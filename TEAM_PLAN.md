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
- [ ] **Live approval spike** with a real `ANTHROPIC_API_KEY` — `agent/spike` (owner: **P3**, ~10 min). Run with `allow` and `DECISION=deny`. If it fails → fallback to Claude Agent SDK + our own approval gate
- [ ] **Each owner reviews their contract file** with the team → mark contracts **frozen**
- [ ] Everyone: clone repo, copy `.env.example` → `.env`, get TrueForge running locally (see [README](README.md#quick-start))

### Decisions

| Topic | Decision | Status |
|---|---|---|
| Agent runtime | TrueForge **pinned `@0.2.1`** (0.3.0-rc exists — don't upgrade mid-hackathon) | ✅ verified |
| TrueForge startup | `OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'` or it blocks local MCP servers | ✅ verified |
| MCP transport | All MCP servers = **Streamable HTTP at `/mcp`** (TrueForge has no stdio support) | ✅ verified |
| Approval gate | Write tools listed **by name** in `require_approval_for_tools`; backend approves via `user.tool_approval` | ✅ schema / ⏳ live run |
| Structured output | AgentSpec `response_format: json_schema` using `incident-report.schema.json` | ✅ verified |
| Scenario A (code-level) | Bad commit leaks DB connections → pool exhaustion → 500s. Fix: **rollback** | Confirm at kickoff |
| Scenario B (infra-level) | No recent deploy; memory blowup / cache growth. Fix: **clear_cache** (or restart) | Confirm at kickoff |
| Rollback mechanism | **Render API rollback** to previous deploy (NOT the deploy hook — that redeploys the bad HEAD) | Confirm at kickoff |
| GitHub access | Fine-grained PAT; GitHub App = stretch goal | Confirm at kickoff |
| GitHub / Sentry tools | Our own small `github-mcp` (reads + rollback); Sentry `get_recent_errors` lives in `cloud-mcp`. No official servers — fewer auth surprises | Confirm at kickoff |
| "Resolved" definition | Metrics stable over a **60s window**, not one sample. Symptom-only fixes → **"mitigated"** | Confirm at kickoff |
| Dashboard updates | Poll `GET /api/incidents/:id` every 2s (no SSE) | Confirm at kickoff |

---

## P1 — Demo App & Infra · Kumar Praveen

**Contracts:** [`scenarios.md`](contracts/scenarios.md), [`demo-app-api.md`](contracts/demo-app-api.md) · **Start immediately — no dependencies.**

- [ ] Node service with a few DB-backed endpoints (incl. `GET /orders`) on port 3000
- [ ] Neon/Supabase Postgres provisioned
- [ ] `GET /health`, `GET /metrics` exactly as in the contract
- [ ] `POST /admin/inject/:scenario`, `POST /admin/reset`, `POST /admin/cache/clear` (header `x-admin-token`)
- [ ] Background traffic generator so metrics move on their own
- [ ] **Scenario A**: commit that leaks connections (missing `client.release()`)
- [ ] **Scenario B**: unbounded cache growth, triggerable without a deploy
- [ ] Sentry integrated, `release` = commit SHA
- [ ] Distinctive log lines (e.g. `pool exhausted (10/10)`)
- [ ] Deployed on Render
- [ ] Rollback via Render API verified manually — **measure how long it takes** (drives demo timing)
- [ ] Share with team: app URL, Render service ID, API keys (privately)

**Deliverable by ~6h:** app deployed, Scenario A injectable, metrics visibly degrade.

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
- [ ] Swap mocks → real APIs once P1 is deployed

**Deliverable by ~6h:** all three servers running in mock mode and visible in TrueForge. ✅ DONE

---

## P3 — Agent Brain · Vaibhav Kumawat

**Contracts:** [`trueforge.md`](contracts/trueforge.md), [`incident-report.schema.json`](contracts/incident-report.schema.json) · **Depends on:** P2's mock servers.

- [ ] Live approval spike (Phase 0)
- [ ] Setup script that registers model provider + 3 MCP servers + the `incident-investigator` agent via the API (so anyone can recreate TrueForge state in one command)
- [ ] AgentSpec: all MCP servers, write tools in `require_approval_for_tools`, `response_format` = report schema, disable `dynamic_sub_agents` / `ask_user_questions` for determinism
- [ ] SKILL.md / instructions:
  - [ ] Only cite evidence retrieved from tools; every claim names its tool
  - [ ] Distinguish code-level vs infra-level cause (check commits in incident window)
  - [ ] Propose exactly one whitelisted action
  - [ ] After action: `get_metrics_window` for 60s → resolved / mitigated / not_resolved
- [ ] Pin model id
- [ ] Confirm exact `model.message` / tool-call event shape and document it for P4 in `trueforge.md`
- [ ] Eval script: run each scenario 10+ times, log accuracy

**Deliverable by ~8h:** agent diagnoses Scenario A correctly against mocks and pauses on `trigger_rollback`.

---

## P4 — Backend, Dashboard & Demo · Arvind Kumar

**Contract:** [`backend-api.md`](contracts/backend-api.md) · **Depends on:** contracts only — use a fake incident JSON until P3 is ready.

- [ ] Express backend (port 4000):
  - [ ] `POST /api/incidents` — inject scenario + create TrueForge session + start turn
  - [ ] `GET /api/incidents`, `GET /api/incidents/:id` — status derived from turn events
  - [ ] `POST /api/incidents/:id/approve` / `reject` → `user.tool_approval`
  - [ ] `POST /api/demo/reset`, `GET /api/metrics`
- [ ] Dashboard (one page, port 5173): incident feed, status, confidence, root cause, evidence list, pending action + Approve/Reject, live metrics chart, before/after, link to TrueForge session
- [ ] "Simulate incident" buttons for Scenario A and B
- [ ] **Demo script — start Day 1**, update as features land
- [ ] Pitch deck
- [ ] Record backup demo video (after 24h checkpoint)

**Deliverable by ~6h:** dashboard renders a fake incident end to end; Approve button hits the backend.

---

## Checkpoints (everyone syncs)

| Hour | Milestone | Done? |
|---|---|---|
| 2 | Contracts frozen, live approval spike passed | [ ] |
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
- **Secrets:** never commit. Copy `.env.example` → `.env`; share real values privately.
- **Blocked > 30 min?** Say so in the team chat immediately.
- **Status update** at every checkpoint: done / next / blocked.
