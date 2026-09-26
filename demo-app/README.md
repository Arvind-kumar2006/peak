# demo-app — PEAK's incident subject

**Owner: P1 (Kumar Praveen).** This is the service we break on purpose. It is
the "production system" the agent investigates: it has a real Postgres pool, a
real background job, real cache, real errors — and two seeded failure modes.

Implements [`contracts/demo-app-api.md`](../contracts/demo-app-api.md) and
[`contracts/scenarios.md`](../contracts/scenarios.md).

---

## Quick start

```bash
# 1. one-time: schema + deterministic seed
npm install
npm run db:reset

# 2. run it (reads the repo-root .env)
npm start
```

```bash
curl localhost:3000/health
curl localhost:3000/metrics | jq
curl -H "x-admin-token: $ADMIN_TOKEN" localhost:3000/admin/state | jq
```

Verify everything, against a real Postgres:

```bash
npm run smoke              # 40 assertions, ~90s
npm run smoke:scenario-b   # Scenario B at demo volume, ~2min
```

---

## The two scenarios

Both are reproducible 10/10 and both are driven by the app's own background
traffic, so metrics move with nobody clicking.

### Scenario A — code-level: `POST /admin/inject/conn-leak`

A background reconciler (`src/reconciler.js`) pages through recent orders. Under
the fault it takes **one pool client per tick and never releases it**, with the
transaction left open. The pool drains over `POOL_MAX × RECONCILE_INTERVAL_SEC`
(default 10 × 6s = **~60s**), then:

| Signal | Where | Verified value |
|---|---|---|
| pool saturated | `GET /metrics` → `db.pool` | `inUse 10/10`, `waiting > 0` |
| request failures | `GET /orders` | `500 {"error":"pool exhausted (10/10)"}` |
| error rate | `GET /metrics` → `http.errorRate` | climbs to ~5–10% |
| latency | `GET /metrics` → `http.p95Ms` | ~2000ms (connect timeout) |
| **Postgres-side** | `pg_stat_activity` | **10 × `idle in transaction`** |
| deploy linkage | Sentry / logs | every line carries the release SHA |

**The `idle in transaction` rows are the point.** A naive leak (grab a client,
never release) shows up in `pg_stat_activity` as `active`, which reads like slow
queries rather than a leak. This fault issues `BEGIN` and never commits, so
Postgres itself reports stranded transactions. `db-mcp`'s `get_pool_stats` and
`get_lock_waits` therefore agree with `/metrics` from two independent sources —
that agreement is what makes the diagnosis unambiguous instead of a guess.

### Scenario B — infra-level: `POST /admin/inject/mem-leak`

An in-process cache stops evicting and grows without bound, with a GC-pressure
latency penalty so it degrades the way users feel it. At the default
`TRAFFIC_RPS=10` (half of which hits the cache-writing `/summary`):

| | baseline | peak | after `clear_cache` |
|---|---|---|---|
| `process.memoryMB` | ~26MB (5%) | **~385MB (75%)** | ~26MB (5%) |
| `http.p95Ms` | ~1ms | ~173ms | ~3ms |
| `cache.entries` | 0–1 | ~717 | 0 |

Peak sits at 75% of a 512MB instance: alarming on the dashboard, comfortably
clear of the 90% line where Render would OOM-kill the process mid-demo.

There is **no deploy and no code change** — that is the whole point. The agent
must classify this as infra, not code, and `list_recent_commits` in the incident
window must be empty for that to be a fair test (see *Open questions* below).

### The traps

| Scenario | Tempting wrong fix | What actually happens |
|---|---|---|
| A | `restart_service` | Pool is fresh, symptoms clear, **leak returns next tick**. SHA is unchanged, so the honest verdict is *mitigated*, not *resolved*. |
| B | `trigger_rollback` | Nothing to roll back — no deploy caused this. |

---

## API

`/admin/*` requires header `x-admin-token: $ADMIN_TOKEN`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | `{ status, release, uptimeSec }` — exactly the contract shape. `status` goes `degraded` then `down`. |
| `GET` | `/metrics` | Exact contract shape. `_diag` is additive; ignore it. |
| `POST` | `/admin/inject/:scenario` | `conn-leak` \| `mem-leak` |
| `POST` | `/admin/reset` | Clears faults, reclaims stranded clients, clears cache. **~10ms.** |
| `POST` | `/admin/cache/clear` | Backs `cloud-mcp.clear_cache`. Returns `{ cleared, stoppedGrowth }`. |
| `GET` | `/admin/state` | Fault flags + pool state. Handy in rehearsals. |
| `GET` | `/_diag` | P1-only: resolved config, pool internals. Not in any contract. |
| `GET` | `/orders`, `/orders/:id`, `/products`, `/summary` | DB-backed business endpoints. |

`errorRate` is a **fraction 0–1**, not a percent.

---

## Things the rest of the team needs to know

**For P2 (MCP servers)**

- `db.pool.*` in `/metrics` is **the app's own `pg.Pool`** (`totalCount - idleCount`,
  and a `waiting` counter we track ourselves). `get_lock_waits` and
  `idleInTransaction` are **Postgres-side** — query `pg_stat_activity` directly.
  These are two different things; don't build one from the other.
- The query that finds the evidence:
  ```sql
  SELECT pid, state, now() - state_change AS age, query
  FROM pg_stat_activity
  WHERE datname = current_database() AND state = 'idle in transaction'
  ORDER BY age DESC;
  ```
- `pg_stat_statements` is available (the schema script enables it), so
  `get_slow_queries` can use it. `db-setup.mjs` prints whether it took.
- **Use a direct (non-pooled) `DATABASE_URL`.** A pgbouncer/pooler connection
  breaks `pg_stat_activity` and `idle in transaction` detection, which is the
  evidence Scenario A stands on.
- `release` in `/health` and `/metrics` is `RENDER_GIT_COMMIT`, and it flips on
  rollback. `restart_service` must **not** change it; `trigger_rollback` must.
  That difference is how the agent justifies "mitigated" vs "resolved".
- `POST /admin/cache/clear` also stops the injected growth
  (`stoppedGrowth: true`). That is intentional: the fault models a runaway
  cache-fill job, and clearing the cache is the operator action that stops it.
  Without it, the next request re-adds an entry and Scenario B could never
  reach *resolved*.

**For P3 (agent brain)**

- Scenario B's memory metric is **live memory** (`heapUsed + external`), not
  `rss`. Reason: the allocator does not return freed pages to the OS on every
  platform, so `rss` can stay high after a real fix and the contract's "below
  60% of limit" bar would never be met. Real `rss` is in `_diag.rssMB` if you
  want it. Both climb during the incident; only the live figure reliably falls.
- The pool saturates in ~60s, so `get_metrics_window(seconds=60)` is *just* long
  enough to show the whole incident. Longer windows are fine.
- Distinctive, quotable log strings: `pool exhausted (10/10)`,
  `cache growing without eviction`, `reclaimed stranded clients`.
- Every log line is JSON with a `release` field, so Render's log search can tie
  errors to a deploy.

**For P4 (dashboard + demo)**

- `POST /admin/reset` is the rehearsal button: ~10ms, no redeploy, no restart.
- `GET /admin/state` tells you whether a fault is currently active — check it
  before triggering so a stale fault doesn't poison a run.
- Local standalone load generator, for pushing a *remote* Render service into
  degradation right before a rehearsal:
  ```bash
  node scripts/load.js --url https://<service>.onrender.com --rps 20
  ```

---

## Environment

See `.env.example`. The ones that matter most:

| Var | Default | Why you'd change it |
|---|---|---|
| `DATABASE_URL` | — | **Required.** Direct connection, not pooled. |
| `ADMIN_TOKEN` | `change-me` | Required in prod. |
| `POOL_MAX` | `10` | Matches the contract. Don't change without a contract PR. |
| `POOL_CONNECT_TIMEOUT_MS` | `2000` | Without a connect timeout a dry pool hangs forever and you never see the 500s. |
| `RECONCILE_INTERVAL_SEC` | `6` | Sets Scenario A pacing: `POOL_MAX × this` = seconds to saturation. |
| `ERROR_RATE_WINDOW_SEC` | `60` | Contract default. See *Open questions*. |
| `MEMORY_LIMIT_MB` | `512` | Must match the Render instance memory. |
| `CACHE_ENTRY_KB` | `512` | Scenario B memory slope. |
| `TRAFFIC_RPS` / `TRAFFIC_PATHS` | `10` / mixed | Half the mix must hit `/summary` or Scenario B never starts. |
| `IDLE_IN_TRANSACTION_TIMEOUT_MS` | `300000` | Must stay above `POOL_MAX × RECONCILE_INTERVAL_SEC`. |
| `LEAK_GRACE_MS` | `30000` | How long a checkout must be held before `/admin/reset` treats it as stranded. |

`npm start` uses `--expose-gc` so `clear_cache` can reclaim memory immediately
instead of waiting for an unpredictable major GC.

---

## The Scenario A bad commit

The real trigger for Scenario A on Render is a deploy, not an inject call. That
commit lives on its own branch:

```bash
git log --oneline p1/demo-app..p1/scenario-a-bad-commit
# e136d98 perf: reuse client for order lookup
```

The diff is the diagnosis the agent has to reach, and it is deliberately
innocuous in message and damning in content:

```diff
+  // Reuse a single client for the whole walk: per-page checkout was showing up
+  // as the top cost in the profile, and the pages are small enough to read in
+  // one pass.
+  const client = await acquire();
+  await client.query('BEGIN');
   for (let page = 0; page < pages; page += 1) {
-    const client = await acquire();
-    try {
-      const { rows } = await client.query(RECONCILE_SQL, [PAGE_SIZE]);
-      ...
-    } finally {
-      release(client);
-    }
+    const { rows } = await client.query(RECONCILE_SQL, [PAGE_SIZE]);
```

A removed `finally`/`release`, a `BEGIN` with no `COMMIT`, and a plausible
justification. `get_commit_diff` on that SHA should be enough for the agent to
name the offending commit — that is Scenario A's acceptance criterion.

**Demo order:** `p1/demo-app` must be the deployed "previous good" deploy, then
merge the bad branch so Render ships it. Rollback target is the parent commit.
To rehearse locally, check out the bad branch and just `npm start` — the leak
appears on its own in ~60s with no injection.

The production query path in `src/db/orders.js` is always correct. Local
reproduction lives in `src/inject/connLeak.js`, clearly labelled, so the good
code stays reviewable and the bad diff stays unambiguous.

---

## Open questions for the team

1. **Scenario B needs a quiet commit window.** `list_recent_commits(sinceMinutes:
   120)` during Scenario B will return a busy history unless nobody has pushed
   for two hours, and "recent commits are unrelated" stops being a fair test.
   This has to be settled in `scenarios.md` before P3 writes SKILL.md.
2. **`errorRate` window vs. the 60s stability window.** 60s rolling + 60s stable
   means *resolved* can take ~2 min after approval. `ERROR_RATE_WINDOW_SEC=20`
   is a one-line change if the demo feels slow.
3. **Where `get_metrics_window` samples come from.** The contract defines the
   tool but not its data source. Current recommendation: P2 samples
   `/metrics` every 10s and caches, which keeps the stability check independent
   of the app being measured.

---

## Layout

```
src/
  index.js            bootstrap, graceful shutdown
  app.js              express wiring, request metrics, error handler
  config.js           all env knobs
  release.js          single source of truth for the release SHA
  metrics.js          /metrics payload, rolling windows
  cache.js            bounded cache + Scenario B growth
  faults.js           injected-fault flags
  reconciler.js       background scheduler (Scenario A trigger)
  traffic.js          in-process background traffic
  gc.js               forced GC for immediate memory release
  logger.js           structured JSON logs
  sentry.js           Sentry init, release tagging
  db/pool.js          pool, waiting counter, leak reclamation
  db/orders.js        order queries  <- the bad commit touches this
  db/products.js      product + rollup queries
  inject/connLeak.js  local-only fault injector
  routes/             observability, data, admin
scripts/
  schema.sql seed.sql db-setup.mjs load.js
test/
  smoke.mjs                40 assertions incl. pg_stat_activity cross-check
  scenario-b-volume.mjs    Scenario B numbers at demo volume
```
