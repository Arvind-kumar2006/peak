# PEAK — Team Plan & Work Division

> Who does what, in what order, and how we plug it together.
> Fill in names below, then treat this file as the source of truth. Update checkboxes as you go.

## Team

| Role | Name | Owns |
|---|---|---|
| **P1 — Demo App & Infra** | _Kumar Praveen_ | Demo app, DB, Sentry, Render deploy, failure injection, rollback mechanism |
| **P2 — MCP Connectors** | _Pranjal Negi_ | `db-mcp`, `cloud-mcp`, GitHub/Sentry MCP setup, whitelisted write tools |
| **P3 — Agent Brain** | _Vaibhav Kumawat_ | TrueForge setup (or fallback), AgentSpec, SKILL.md, verification logic, eval runs |
| **P4 — Backend, Dashboard & Demo** | _Arvind Kumar_ | Express backend, approval flow, dashboard, demo script, pitch, backup recording |

---

## Phase 0 — Kickoff (Hour 0–2, EVERYONE together)

Goal: agree on contracts so all four can work in parallel against mocks.

- [x] Create repo skeleton (layout below)
- [x] Draft `contracts/scenarios.md` — both failure scenarios (owner: **P1**, review at kickoff)
- [x] Draft `contracts/demo-app-api.md` — health/metrics/inject endpoints (owner: **P1**, review at kickoff)
- [x] Draft `contracts/mcp-tools.md` — every tool: name, input, output, read vs write (owner: **P2**, review at kickoff)
- [x] Draft `contracts/incident-report.schema.json` — agent's final output shape (owner: **P3**, review at kickoff)
- [x] Draft `contracts/backend-api.md` — REST endpoints for dashboard (owner: **P4**, review at kickoff)
- [x] TrueForge API verified against v0.2.1 — see `contracts/trueforge.md` (sessions, MCP, approval schema, JSON output, deep links all ✅)
- [ ] **Run `agent/spike` with a real `ANTHROPIC_API_KEY`** (owner: **P3**, ~10 min) — last unconfirmed step: live approval round-trip
- [ ] Team reviews all `contracts/` files together, then marks them frozen
- [ ] **TrueForge spike** (owner: **P3**, in parallel): dummy MCP tool marked dangerous → confirm it pauses → approve it via HTTP → confirm it resumes. **Decision by Hour 2: TrueForge or fallback (Claude Agent SDK / plain tool-use loop + our own approval gate).**

### Repo layout

```
Peak/
├── contracts/          # shared agreements — change only with team sign-off
├── demo-app/           # P1
├── mcp/
│   ├── db/             # P2
│   ├── cloud/          # P2
│   └── github/         # P2 (thin wrapper for rollback / create_pr)
├── agent/              # P3 — AgentSpec, SKILL.md, eval scripts
├── backend/            # P4
└── dashboard/          # P4
```

### Proposed decisions (confirm at kickoff)

| Topic | Proposal |
|---|---|
| Scenario A (code-level) | Bad commit leaks DB connections → pool exhaustion → 500s. Fix: **rollback** |
| Scenario B (infra-level) | No recent deploy; memory blowup / stuck cache. Fix: **restart / scale / clear_cache** |
| Rollback mechanism | Render API rollback to previous deploy (NOT the deploy hook — that redeploys the bad HEAD) |
| GitHub access | Fine-grained PAT for MVP; GitHub App = stretch goal |
| MCP transport | All MCP servers = Streamable HTTP at `/mcp` (TrueForge has no stdio support) |
| TrueForge version | Pin `@0.2.1`; start with `OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'` |
| GitHub / Sentry MCP | Reuse official servers (read-only toolsets); only build `db-mcp`, `cloud-mcp`, and a small rollback wrapper |
| "Resolved" definition | Health signal stable over a window (e.g. 60s), not one sample. Symptom-only fixes are reported as **"mitigated"** |

---

## P1 — Demo App & Infra

**Start immediately — no dependencies.**

- [ ] Small Node service with a few DB-backed endpoints
- [ ] Neon/Supabase Postgres provisioned
- [ ] `/health` and `/metrics` (pool in-use/total, error rate, memory, uptime)
- [ ] `/admin/inject/:scenario` and `/admin/reset`
- [ ] **Scenario A**: commit that leaks connections (not releasing pool clients)
- [ ] **Scenario B**: memory leak / cache blowup triggerable without a deploy
- [ ] Sentry integrated, errors tagged with release = commit SHA
- [ ] Clear, distinctive log lines (e.g. `pool exhausted (10/10)`) so evidence is unambiguous
- [ ] Deployed on Render
- [ ] Rollback path verified manually via Render API (measure how long it takes!)
- [ ] Share with team: service ID, API keys (via secure channel), `.env.example`

**Deliverable by ~6h:** app deployed, Scenario A injectable, metrics visibly degrade.

---

## P2 — MCP Connectors

**Depends on:** contracts. Use mock data until P1's app is live.

- [ ] `db-mcp` (read): `get_pool_stats`, `get_slow_queries`, `get_lock_waits`
- [ ] `cloud-mcp` (read): `get_service_status` (CPU, memory, restarts, current deploy)
- [ ] `cloud-mcp` (write, approval-gated): `restart_service`, `scale_service`, `clear_cache`
- [ ] GitHub: configure official GitHub MCP server in read-only mode (commits, diffs)
- [ ] GitHub wrapper (write, approval-gated): `trigger_rollback`, optionally `create_pr`
- [ ] Sentry: configure official Sentry MCP server (read-only)
- [ ] Every tool has a mock mode (`MOCK=1`) returning contract-shaped data
- [ ] Swap mocks → real APIs once P1 is deployed

**Deliverable by ~6h:** all read tools return mock data; P3 can call them from the agent.

---

## P3 — Agent Brain

**Depends on:** TrueForge spike result, P2's mock tools.

- [ ] TrueForge spike (Phase 0) — go / no-go decision
- [ ] Pin exact TrueForge npm version; read `docs/openapi.json` for session/turn API
- [ ] AgentSpec wiring all MCP servers; mark write tools as requiring approval
- [ ] SKILL.md:
  - [ ] Only cite evidence retrieved from tools; every claim has a source
  - [ ] Final answer must match `incident-report.schema.json`
  - [ ] Distinguish code-level vs infra-level cause
  - [ ] After action: re-poll health over a window, report resolved / mitigated / not resolved
- [ ] Pin model version
- [ ] Eval script: run each scenario 10+ times, log accuracy

**Deliverable by ~8h:** agent diagnoses Scenario A correctly against mocks.

---

## P4 — Backend, Dashboard & Demo

**Depends on:** contracts only. Use a fake incident JSON until P3 is ready.

- [ ] Express backend:
  - [ ] `POST /api/incidents` — start a session (manual "simulate" trigger)
  - [ ] `GET /api/incidents` / `GET /api/incidents/:id`
  - [ ] `POST /api/incidents/:id/approve` and `/reject` → proxy to TrueForge
- [ ] Dashboard (one page): incident feed, status, confidence, root cause, evidence, Approve/Reject button, before/after metrics, deep link to TrueForge session
- [ ] "Simulate incident" button → calls P1's inject endpoint + creates incident
- [ ] **Demo script — start Day 1**, update as features land
- [ ] Pitch deck / README
- [ ] Record backup demo video (after 24h checkpoint)

**Deliverable by ~6h:** dashboard renders a fake incident end to end, approve button hits backend.

---

## Checkpoints (everyone syncs)

| Hour | Milestone | Done? |
|---|---|---|
| 2 | Contracts agreed, TrueForge go/no-go decided | [ ] |
| 8 | Scenario A end-to-end **with mocks**: trigger → diagnosis → approve → mock execute | [ ] |
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
- **Secrets:** never commit. Each package has `.env.example`; share real values privately.
- **Blocked > 30 min?** Say so in the team chat immediately.
- **Status update** at every checkpoint: done / next / blocked.
