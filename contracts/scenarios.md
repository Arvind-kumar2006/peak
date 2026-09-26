# Seeded Failure Scenarios

Owner: **P1**. These drive everything else: tools (P2), SKILL.md (P3), demo script (P4).

---

## Scenario A — Bad deploy → DB connection leak (code-level)

| | |
|---|---|
| **Trigger** | Deploy a commit that acquires a pool client in `GET /orders` and never releases it on one code path. Locally: `POST /admin/inject/conn-leak` |
| **Commit** | Message looks innocent, e.g. `perf: reuse client for order lookup`. Diff clearly shows missing `client.release()` |
| **Symptom chain** | Pool in-use climbs to max → requests wait → `pool exhausted (10/10)` / timeout errors → 500s on `/orders` → error rate spikes |
| **Signals** | `/metrics`: `db.pool.inUse == db.pool.max`, `db.pool.waiting > 0`, `http.errorRate` high. Sentry: `TimeoutError: pool exhausted` tagged `release=<bad sha>`. db-mcp: pool saturated, many idle-in-transaction connections |
| **Correct diagnosis** | Commit `<sha>` introduced a connection leak in `GET /orders` |
| **Correct fix** | `trigger_rollback` to the previous deploy (approval-gated). Optional: propose diff adding `client.release()` in a `finally` |
| **Wrong-but-tempting fix** | `restart_service` — clears the pool temporarily, leak comes back. Agent must report this as **mitigated**, not resolved |
| **Resolved when** | For 60s after rollback: `db.pool.inUse < 0.5 * max`, `db.pool.waiting == 0`, `http.errorRate < 1%`, and running deploy SHA != bad SHA |

---

## Scenario B — Memory blowup, no recent deploy (infra-level)

| | |
|---|---|
| **Trigger** | `POST /admin/inject/mem-leak` — in-process cache grows unbounded (no code change, no deploy) |
| **Symptom chain** | Memory climbs → GC pauses → latency p95 spikes → (eventually) OOM restarts |
| **Signals** | `/metrics`: `process.memoryMB` climbing toward limit, `cache.entries` huge, `http.p95Ms` high. cloud-mcp: memory near limit, restart count rising. GitHub: **no** commits in the incident window. DB: healthy |
| **Correct diagnosis** | Runtime/infra issue (cache growth), not a code deploy — recent commits are unrelated |
| **Correct fix** | `clear_cache` (approval-gated). Acceptable alternative: `restart_service` |
| **Wrong-but-tempting fix** | `trigger_rollback` — there's no bad deploy to roll back |
| **Resolved when** | For 60s after action: `process.memoryMB` below 60% of limit and flat, `http.p95Ms` back to baseline |

---

## Decisions (2026-09-26)

- **`main` must always be healthy.** The Scenario A bad commit (`5a824ff perf: reuse client for order lookup`) lives only on `p1/scenario-a-bad-commit` and is merged/deployed *live during the demo*. It was merged into `main` early by PR #2; the `Vaibhav` branch restores the healthy `reconcileRecentOrders`.
- **Scenario B quiet window:** `list_recent_commits(sinceMinutes: 120)` returns no commits during Scenario B (mocks enforce it; for the live demo, nobody pushes to the deployed branch in the 2 hours before). The agent treats an empty window as evidence against a bad deploy.
- **Rollback target** is `previousDeploy.id` from `get_service_status` (the parent of the bad commit, `1e82fab`).
- **Mock numbers = P1's measurements** (demo-app/README.md): A → errorRate 0.30, p95 2003ms, pool 10/10 with 7 waiting; B → memory 385MB of 512MB, p95 173ms, 717 cache entries.

## Rules for both

- `POST /admin/reset` restores a healthy state in < 5s (needed for rehearsals).
- Every error log includes the release SHA.
- Scenario must be reproducible 10/10 times.
