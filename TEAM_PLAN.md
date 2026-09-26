# PEAK — Team Plan & Work Division

> Who does what, in what order, and how we plug it together.
> This file is the source of truth for **who owns what**. The **how** lives in [`contracts/`](contracts/). Update checkboxes as you go.

## Team

| Role | Name | Owns | Folder |
|---|---|---|---|
| **P1 — Demo App & Infra** | Kumar Praveen | Demo app, DB, Sentry, Render deploy, failure injection, rollback mechanism | `demo-app/` |
| **P2 — MCP Connectors** | Pranjal Negi | `db-mcp`, `cloud-mcp`, `github-mcp`, whitelisted write tools | `mcp/` |
| **P3 — Agent Brain** | Vaibhav Kumawat | TrueForge setup, AgentSpec, SKILL.md, verification logic, eval runs | `agent/` |
| **P4 — Backend, Dashboard & Demo** | Arvind Kumar | Express backend, approval flow, dashboard, demo script, pitch, backup recording | `backend/`, `dashboard/` |

---

## Phase 0 — Kickoff (Hour 0–2, EVERYONE together)

Goal: agree on contracts so all four can work in parallel against mocks.

- [x] Create repo skeleton
- [x] Draft `contracts/scenarios.md` — both failure scenarios (owner: **P1**)
- [x] Draft `contracts/demo-app-api.md` — health/metrics/inject endpoints (owner: **P1**)
- [x] Draft `contracts/mcp-tools.md` — every tool: name, input, output, read vs write (owner: **P2**)
- [x] Draft `contracts/incident-report.schema.json` — agent's final output shape (owner: **P3**)
- [x] Draft `contracts/backend-api.md` — REST endpoints for dashboard (owner: **P4**)
- [x] TrueForge v0.2.1 verified — sessions, MCP, approval schema, JSON output, deep links ([`contracts/trueforge.md`](contracts/trueforge.md)). **Decision: GO**
- [x] **Live approval spike** — allow → tool runs, deny → tool never runs. Verified with scripted mock model (`agent/spike`). Gate is runtime-enforced, model-independent
- [x] Deterministic mock model (`agent/spike/mock-model.mjs`) — lets P4 build without an API key
- [x] One-command TrueForge start: `./scripts/start-trueforge.sh`
- [x] Model providers: **OpenAI primary, Grok (xAI) fallback** with automatic per-turn fallback (`agent/lib/`) — verified with simulated outage
- [ ] Real-key check: `OPENAI_API_KEY=... XAI_API_KEY=... npm run spike` and confirm `OPENAI_MODEL` / `XAI_MODEL` ids — owner **P3**
- [ ] **Each owner reviews their contract file** with the team → mark contracts **frozen**
- [ ] Everyone: clone repo, copy `.env.example` → `.env`, run `./scripts/start-trueforge.sh` (see [README](README.md#quick-start))

### Decisions

| Topic | Decision | Status |
|---|---|---|
| Agent runtime | TrueForge **pinned `@0.2.1`** (0.3.0-rc exists — don't upgrade mid-hackathon) | ✅ verified |
| TrueForge startup | `OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'` or it blocks local MCP servers | ✅ verified |
| MCP transport | All MCP servers = **Streamable HTTP at `/mcp`** (TrueForge has no stdio support) | ✅ verified |
| Approval gate | Write tools listed **by name** in `require_approval_for_tools`; backend approves via `user.tool_approval` | ✅ verified end-to-end |
| Structured output | AgentSpec `response_format: json_schema` using `incident-report.schema.json` | ✅ verified |
| Scenario A (code-level) | Bad commit leaks DB connections → pool exhaustion → 500s. Fix: **rollback** | Confirm at kickoff |
| Scenario B (infra-level) | No recent deploy; memory blowup / cache growth. Fix: **clear_cache** (or restart) | Confirm at kickoff |
| Rollback mechanism | **Render API rollback** to previous deploy (NOT the deploy hook — that redeploys the bad HEAD) | Confirm at kickoff |
| GitHub access | Fine-grained PAT; GitHub App = stretch goal | Confirm at kickoff |
| GitHub / Sentry tools | Our own small `github-mcp` (reads + rollback); Sentry `get_recent_errors` lives in `cloud-mcp`. No official servers — fewer auth surprises | Confirm at kickoff |
| "Resolved" definition | Metrics stable over a **60s window**, not one sample. Symptom-only fixes → **"mitigated"** | Confirm at kickoff |
| Dashboard updates | Poll `GET /api/incidents/:id` every 2s (no SSE) | Confirm at kickoff |
| Model | OpenAI primary → Grok (xAI) fallback, order via `MODEL_PROVIDERS`; fallback handled in `agent/lib/trueforge-client.mjs` | ✅ verified (mocks) |
| Dev without API key | Scripted mock model via TrueForge `custom` provider (OpenAI-compatible) | ✅ verified |

---

## P1 — Demo App & Infra · Kumar Praveen

**Contracts:** [`scenarios.md`](contracts/scenarios.md), [`demo-app-api.md`](contracts/demo-app-api.md) · **Start immediately — no dependencies.**

- [x] Node service with a few DB-backed endpoints (incl. `GET /orders`) on port 3000
- [x] Neon/Supabase Postgres provisioned — **local Postgres 15 verified instead; managed DB still needed for Render**
- [x] `GET /health`, `GET /metrics` exactly as in the contract
- [x] `POST /admin/inject/:scenario`, `POST /admin/reset`, `POST /admin/cache/clear` (header `x-admin-token`)
- [x] Background traffic generator so metrics move on their own
- [x] **Scenario A**: commit that leaks connections (missing `client.release()`) — branch `p1/scenario-a-bad-commit`
- [x] **Scenario B**: unbounded cache growth, triggerable without a deploy
- [x] Sentry integrated, `release` = commit SHA — **code done, needs a real DSN to verify**
- [x] Distinctive log lines (e.g. `pool exhausted (10/10)`)
- [ ] Deployed on Render
- [ ] Rollback via Render API verified manually — **measure how long it takes** (drives demo timing)
- [ ] Share with team: app URL, Render service ID, API keys (privately)

**Verified locally against real Postgres** — `npm run smoke` (40 assertions, all
passing) and `npm run smoke:scenario-b`. Both scenarios confirmed reproducible:

| | Scenario A | Scenario B |
|---|---|---|
| Trigger | deploy of `perf: reuse client for order lookup`, or `POST /admin/inject/conn-leak` | `POST /admin/inject/mem-leak` |
| Measured | pool 10/10 in ~60s, `waiting` 7, `p95` 2003ms, `errorRate` 0.30, `/orders` → 500 `pool exhausted (10/10)`, **10 × `idle in transaction`** in `pg_stat_activity` | memory 26MB → **385MB (75% of 512MB)**, `p95` 1ms → 173ms, `cache.entries` 0 → 717 |
| Fix verified | `POST /admin/reset` reclaims all 10 clients in ~10ms | `POST /admin/cache/clear` → memory back to 5%, `p95` 3ms |

The `idle in transaction` rows are deliberate: a naive leak shows as `active` in
`pg_stat_activity` (reads like slow queries), so Scenario A opens a transaction
and never commits, giving `db-mcp` a second independent source of evidence.

> **Blockers for the rest of the team** — details in [`demo-app/README.md`](demo-app/README.md):
> 1. **Use a direct (non-pooled) `DATABASE_URL`.** A pgbouncer/pooler URL breaks `pg_stat_activity` and `idle in transaction` detection, which is the evidence Scenario A stands on. Affects P2's `db-mcp` directly.
> 2. **Scenario B needs a quiet commit window.** `list_recent_commits(sinceMinutes: 120)` must come back empty/unrelated during Scenario B, or "recent commits are unrelated" is not a fair test. Must be settled in `scenarios.md` before P3 writes SKILL.md.
> 3. **`process.memoryMB` is live memory (`heapUsed + external`), not `rss`** — the allocator does not return freed pages on every platform, so `rss` can stay high after a real fix and the contract's "below 60% of limit" bar would never be met. Real `rss` is in `_diag.rssMB`. P2 reads the top-level field.
> 4. **`get_metrics_window` has no defined data source.** Recommendation: P2 samples `/metrics` every 10s and caches, keeping the stability check independent of the app being measured.
> 5. **`errorRate` 60s window + 60s stability window = up to ~2min to *resolved*.** If the demo feels slow, `ERROR_RATE_WINDOW_SEC=20` is a one-line change.
>
> **Status (P3, 2026-09-26):** #2 settled in `scenarios.md` (quiet window, mocks enforce it). #4 settled: `cloud-mcp` background sampler + `waitSeconds`. #1, #3, #5 still open.
>
> ⚠️ **PR #2 merged the Scenario A bad commit into `main`** — every copy of `main` leaked the pool within ~60s. Fixed on the `Vaibhav` branch (healthy `reconcileRecentOrders` restored). The bad commit stays on `p1/scenario-a-bad-commit` for the live demo. **P1: keep `main` healthy; deploy the bad branch only during the demo.**


---

## P2 — MCP Connectors · Pranjal Negi

**Contract:** [`mcp-tools.md`](contracts/mcp-tools.md) · **Depends on:** contracts only — use `MOCK=1` data until P1 is live.
**Reference:** [`agent/spike/dummy-mcp.mjs`](agent/spike/dummy-mcp.mjs) is a working HTTP MCP server to copy from.

- [x] `db-mcp` (port 7101) — read: `get_pool_stats`, `get_slow_queries`, `get_lock_waits`
- [x] `cloud-mcp` (port 7102) — read: `get_service_status`, `get_metrics`, `get_metrics_window`, `get_recent_errors` (Sentry)
- [x] `cloud-mcp` — write (`destructiveHint`): `restart_service`, `scale_service`, `clear_cache`
- [x] `github-mcp` (port 7103) — read: `list_recent_commits`, `get_commit_diff`
- [x] `github-mcp` — write (`destructiveHint`): `trigger_rollback` (stretch: `create_fix_pr`)
- [x] Every response includes `source` + `observedAt`
- [x] `MOCK=1` mode on every server — mocks match Scenario A and B signals
- [x] Register all three in TrueForge; confirm `GET /api/v1/mcp-servers/{name}/tools` lists them
- [x] Mock fixes (P3, reviewed with P2): shared mock world so write tools actually change metrics (`mcp/_shared/mockState.js`, `POST /mock/state`); `get_commit_diff` accepts short SHAs; commit times relative to the incident + `sinceMinutes` honoured; evidence matches the scenarios (no slow queries in B, no invented lock waits in A); mock diff = P1's real commit; P1's measured numbers
- [x] Real mode returns explicit "not implemented" errors instead of zeros
- [x] Real mode: `get_metrics`, `get_metrics_window` (background sampler + `waitSeconds`), `clear_cache` against the demo app
- [ ] Real mode: Render API (`get_service_status`, `restart_service`, `scale_service`, `trigger_rollback`)
- [ ] Real mode: GitHub API (`list_recent_commits`, `get_commit_diff`), Sentry API (`get_recent_errors`), Postgres (`db-mcp`, needs a **direct** `DATABASE_URL`)

**Deliverable by ~6h:** all three servers running in mock mode and visible in TrueForge. ✅ DONE

---

## P3 — Agent Brain · Vaibhav Kumawat

**Contracts:** [`trueforge.md`](contracts/trueforge.md), [`incident-report.schema.json`](contracts/incident-report.schema.json) · **Depends on:** P2's mock servers.

- [x] Live approval spike (Phase 0)
- [x] Model providers: OpenAI → Grok fallback (`agent/lib/providers.mjs`, `trueforge-client.mjs`)
- [x] `npm run setup` — registers providers, 4 MCP servers, and the `incident-investigator` agent in one command
- [x] AgentSpec (`agent/agent-spec.mjs`): write tools listed by name for approval, `create_fix_pr` disabled, sub-agents / ask-user / generative UI / web search off
- [x] **Report tools** (`report-mcp`, port 7104): `submit_diagnosis` before the action, `submit_resolution` after verifying. Replaces `response_format` — the diagnosis is available *while* the action awaits approval (see `contracts/trueforge.md`)
- [x] Instructions (`agent/instructions.md`):
  - [x] Only cite evidence retrieved from tools; every claim names its tool
  - [x] Distinguish code-level vs infra-level cause (check commits in incident window)
  - [x] Propose exactly one whitelisted action; call out the trap fix for each scenario
  - [x] After action: `get_metrics_window {seconds: 60, waitSeconds: 60}` → resolved / mitigated / not_resolved / rejected
- [x] Client helpers for P4: `getReports`, `getPendingAction` (tool name + args), `listToolCalls` (timeline), `loadSession`
- [x] Scenario-aware mock model (`agent/mock-model.mjs`) — follows the runbook on real tool results; `MOCK_BEHAVIOR=trap` picks the wrong fix
- [x] `run-incident.mjs` (one incident from the CLI) and `eval.mjs` (N runs × scenario × provider, graded, saved to `eval-results/`)
- [x] `scripts/dev-mock-stack.sh` — whole mock stack in one command (for P4)
- [x] Verified on the mock stack: A → rollback → resolved; B → clear_cache → resolved; deny → tool never runs → rejected; trap A → mitigated; trap B → not_resolved; eval grader fails the trap runs
- [ ] **Real-model runs** — needs `OPENAI_API_KEY` / `XAI_API_KEY`; pin `OPENAI_MODEL` / `XAI_MODEL`
- [ ] Eval ≥ 9/10 per scenario on **both** providers (`node --env-file=../.env eval.mjs --providers openai` then `--providers xai`); tune `instructions.md` on failures
- [ ] Re-run the eval against P2's real-mode servers once P1 is deployed

**Deliverable by ~8h:** agent diagnoses Scenario A correctly against mocks and pauses on `trigger_rollback`. ✅ DONE with the mock model — pending a real-model run.

---

## P4 — Backend, Dashboard & Demo · Arvind Kumar

**Contract:** [`backend-api.md`](contracts/backend-api.md) · **Depends on:** contracts only — use a fake incident JSON until P3 is ready.

- [ ] Use `agent/lib/trueforge-client.mjs` (`createSession`, `start`, `approve`, `reject`, `getReports`, `getPendingAction`) — see the sketch in `contracts/backend-api.md` and the working CLI in `agent/run-incident.mjs`
- [ ] Develop against `./scripts/dev-mock-stack.sh` (no keys needed)
- [x] Express backend (port 4000):
  - [x] `POST /api/incidents` — inject scenario + create TrueForge session + start turn
  - [x] `GET /api/incidents`, `GET /api/incidents/:id` — status derived from turn events
  - [x] `POST /api/incidents/:id/approve` / `reject` → `user.tool_approval`
  - [x] `POST /api/demo/reset`, `GET /api/metrics`
- [x] Dashboard (one page, port 5173): incident feed, status, confidence, root cause, evidence list, pending action + Approve/Reject, live metrics chart, before/after, link to TrueForge session
- [x] "Simulate incident" buttons for Scenario A and B
- [x] **Demo script — start Day 1**, update as features land → [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md)
- [ ] Pitch deck
- [ ] Record backup demo video (after 24h checkpoint)

**Done so far:** backend runs end to end against a scripted fake agent
(`TRUEFORGE_MODE=fake`), so the whole approve flow is demoable before the core
lands. 38 tests over the status state machine, report parsers and event mapper.
Dashboard verified in-browser: trigger → investigate → submit diagnosis → gate →
approve → submit resolution → resolved, with `ruledOut`, evidence, the agent's own
before/after measurements, and follow-up all rendering. Reject path verified too.

Uses P3's `agent/lib/trueforge-client.mjs` per `contracts/backend-api.md`, so
model-provider fallback comes with it. Because that client is blocking, the
investigation and the decision run as background tasks and the poller derives
state — the endpoints still return immediately, as the contract requires.

**Blocked on:** Neon `PEAK_DATABASE_URL` (memory store until then) and P1's
`ADMIN_TOKEN` + a reachable demo app (metrics fall back to labelled synthetic
data, so the chart works but shows a flat line until :3000 is up).

**Deliverable by ~6h:** dashboard renders a fake incident end to end; Approve button hits the backend. ✅


**Fixes after review (P3, 2026-09-26)** — verified in real mode against the mock stack, screenshots checked:
- 🔴 Real mode never showed *Awaiting approval*: a paused turn also emits `turn.done`, so status went straight to `error`, and after a decision the old approval still read as pending. `backend/src/trueforge/turns.js` now reads the **latest turn** only; 5 new tests (`test/turns.test.mjs`, 43/43 pass).
- 🟠 Simulate/Reset/metrics ignored the MCP mock world, so on the mock stack the agent investigated a stale world and the chart drew random numbers. `MOCK_WORLD_URL` (backend `.env`) routes them to `POST /mock/state` / `GET /mock/metrics` when the demo app is down.
- 🟠 The sampler stopped at the verdict, so the chart never showed the recovery. It now samples 60s past the end of the turn.
- UI redesign (design: claude.ai/artifact/LRDzMTNMRXhM5mrYWbvyrM): progress stepper; decision panel with the *why* beside Approve; outcome-first layout with before/after tiles once resolved; honest step chart (no fake slope before the approval), coloured by verdict; live strip derives Healthy/Degraded (was a permanent "—"); short feed titles; event trail names each tool result; no stale incident flash when switching; IBM Plex type.

---

## Checkpoints (everyone syncs)

| Hour | Milestone | Done? |
|---|---|---|
| 2 | Contracts frozen, live approval spike passed | spike ✅ · contracts ⏳ |
| 8 | Scenario A end-to-end **with mocks**: trigger → diagnosis → approve → mock execute | agent side ✅ (CLI) · backend/dashboard ⏳ |
| 16 | Scenario A end-to-end **on real infra**, real rollback, verified recovery | [ ] |
| 24 | Scenario B works — **FEATURE FREEZE** | [ ] |
| 30 | Both scenarios pass 10/10 runs; backup video recorded | [ ] |
| 34 | Full rehearsal ×2 | [ ] |
| 36 | Demo | |

After Hour 24: bug fixes, prompt hardening, and demo polish only. No new features.

---

## Working Rules

- **Contracts are frozen after kickoff.** Changing one = ping the whole team first.
- **Branches:** `p1/...`, `p2/...`, `p3/...`, `p4/...`; merge to `main` via small PRs, keep `main` runnable.
- **Secrets:** never commit. Copy `.env.example` → `.env`; share real values privately.
- **Blocked > 30 min?** Say so in the team chat immediately.
- **Status update** at every checkpoint: done / next / blocked.
