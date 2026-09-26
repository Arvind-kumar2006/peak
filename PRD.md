# PRD: PEAK — AI-Powered Production Incident Response Agent

**Version:** v3 · **Updated:** 2026-09-26
**Team:** Kumar Praveen (P1) · Pranjal Negi (P2) · Vaibhav Kumawat (P3) · Arvind Kumar (P4)
**Related:** [TEAM_PLAN.md](TEAM_PLAN.md) (who does what) · [contracts/](contracts/) (interfaces) · [README.md](README.md) (setup)

---

## Revision history

### v3 — Phase 0 findings (2026-09-26)

TrueForge 0.2.1 was run locally and checked against this PRD. The core assumptions hold, so the plan stays on TrueForge. What changed:

| Area | v2 said | v3 says | Why |
|---|---|---|---|
| MCP transport | stdio or HTTP | **HTTP only** (Streamable HTTP at `/mcp`) | TrueForge only supports remote MCP servers |
| Connectors | 4 servers incl. `sentry-mcp` | **3 servers**; Sentry's tool goes into `cloud-mcp` | Fewer processes and auth setups |
| Rollback | Render deploy hook / `workflow_dispatch` | **Render API rollback** to the previous deploy | A deploy hook redeploys the branch head, which is the bad commit |
| GitHub integration | GitHub App + webhooks | **Fine-grained PAT**; GitHub App moved to stretch | A push webhook doesn't signal an incident; saves 1–2h of setup |
| Scenarios | "Bad deploy" and "DB connection leak" | **A: code-level** (leak via bad deploy) · **B: infra-level** (cache/memory growth, no deploy) | The demo should show the agent telling code causes from infra causes |
| Verification | Re-poll the health signal | Watch metrics over a **60s window**; symptom-only fixes report **"mitigated"** | A restart temporarily hides a leak and would give a false "resolved" |
| Structured output | Enforced by SKILL.md prompt | Enforced by **`response_format: json_schema`** in the AgentSpec | Verified in TrueForge; stronger than prompt-only |
| Fix via PR | Implied | `create_fix_pr` listed explicitly as an approval-gated write (stretch) | Opening a PR is a write action |
| Timeline | By feature | By **parallel workstreams** with checkpoints | Four people build against contracts and mocks |

### v2 — Adopt TrueForge

v1 called for a hand-built reasoning core: raw Claude API, a custom tool-calling loop, a hand-built approval pause, and a hand-built evidence dashboard. That was roughly 12–16 hours of agent infrastructure. TrueForge (`truefoundry/trueforge`, MIT) already provides the agent loop, MCP connectivity, a per-tool approval pause, session and turn persistence, and a chat UI. That turns the reasoning core into configuration work (an AgentSpec plus small MCP servers) and moves the saved hours to scenario hardening and demo rehearsal.

---

## 1. Problem statement

When production breaks, engineers spend most of the incident window on triage: correlating logs, suspecting a recent deploy, checking DB health, reading dashboards. All of that happens before they start fixing anything. MTTR (mean time to resolution) is limited by investigation, not remediation.

## 2. Product vision

An AI agent that plugs into a team's existing stack (GitHub, logs, database, cloud) and handles an incident end to end:

**detect → investigate → diagnose → propose fix → execute (with human approval) → verify recovery**

## 3. Assumptions

- Build window: about 36 hours (hackathon).
- One cloud provider for the demo: **Render**.
- One demo application with seeded, injectable bugs, not a real production system.
- "Execute with approval" means a human clicks Approve before any write action. TrueForge's tool-approval gate enforces this in the runtime, not only in our application code.

## 4. Goals

1. Prove the full loop end to end on two realistic failure scenarios.
2. Make the AI's reasoning visible and inspectable. Judges must see **why**, not just **what**.
3. Keep every write action behind an explicit human approval gate.

## 5. Non-goals (MVP)

- Multi-cloud support
- Fully autonomous remediation without approval
- Arbitrary or unknown incident types (only the 2 seeded failure classes)
- Historical incident analytics beyond what TrueForge sessions already provide

---

## 6. MVP features

| # | Feature | Core output |
|---|---|---|
| 1 | Incident ingestion & root-cause investigation | Root-cause hypothesis + cited evidence |
| 2 | Fix proposal | One specific, whitelisted action with reasoning |
| 3 | Approve → execute → verify | Resolved / mitigated / not resolved + before/after metrics |

### Feature 1: Incident ingestion & root-cause investigation

A trigger (the dashboard's **Simulate incident** button for MVP; alert webhooks are a stretch goal) makes the backend start a TrueForge session for the `incident-investigator` agent. The agent gathers evidence through read-only MCP tools:

| Source | Server | Tools |
|---|---|---|
| Recent commits and diffs | `github-mcp` | `list_recent_commits`, `get_commit_diff` |
| Sentry errors tagged with release SHA | `cloud-mcp` | `get_recent_errors` |
| DB health | `db-mcp` | `get_pool_stats`, `get_slow_queries`, `get_lock_waits` |
| Service and resource state | `cloud-mcp` | `get_service_status`, `get_metrics`, `get_metrics_window` |

**Output:** a structured report (root cause, category, confidence, evidence, proposed fix). TrueForge enforces its shape with `response_format` against [`contracts/incident-report.schema.json`](contracts/incident-report.schema.json).

**Acceptance criteria:**
- **Scenario A:** the agent names the offending commit SHA and the symptom chain (leak → pool exhaustion → timeouts → 500s).
- **Scenario B:** the agent classifies the cause as infra-level and says explicitly that recent commits are unrelated.
- Every evidence item names the tool that produced it.

### Feature 2: Fix proposal

- **Code-level cause:** propose `trigger_rollback` to the previous deploy, optionally with a code diff. `create_fix_pr` is a stretch goal.
- **Infra-level cause:** propose exactly one of `restart_service`, `scale_service` or `clear_cache`.

The whitelist is enforced twice:
1. **MCP layer:** a non-whitelisted action doesn't exist as a tool.
2. **Runtime layer:** every write tool is listed by name in `require_approval_for_tools`, so TrueForge pauses before it runs.

**Acceptance criteria:** the agent proposes the correct fix for each scenario (see §11) and does not propose the known "trap" fix.

### Feature 3: Approve, execute, verify

A human reviews the pending action (tool name, arguments, reasoning, evidence) on the dashboard, or in TrueForge's own session UI, and approves or rejects it.

- **Approve:** the backend resumes the paused turn with `user.tool_approval: allow`. The MCP server runs the action. The agent then samples metrics over a 60s window and gives its final verdict:
  - **resolved:** the metrics that indicated the incident are back to normal and stable, and the root cause is addressed.
  - **mitigated:** the symptoms cleared but the root cause remains (for example, a restart during a connection leak).
  - **not resolved:** the metrics are still degraded. The agent may investigate again and propose another fix.
- **Reject:** the backend sends `deny` with an optional reason. The agent acknowledges it and the incident is marked `rejected` for manual handling.

**Acceptance criteria:** the write tool never runs without approval; the dashboard shows before/after metrics; the session history holds the full timeline.

---

## 7. Incident lifecycle

```
Trigger (Simulate button)
   │
   ▼
Backend creates TrueForge session (metadata: incidentId) and starts a turn
   │
   ▼
Agent investigates via read-only MCP tools ──► report: root cause + evidence
   │
   ▼
Agent calls one whitelisted write tool
   │
   ▼
TrueForge pauses: tool.approval_required ──► dashboard shows "Awaiting approval"
   │
   ├── Reject ──► turn resumed with deny ──► status: rejected (manual handling)
   │
   └── Approve ──► turn resumed with allow ──► MCP server executes action
                        │
                        ▼
                  Agent watches metrics for 60s
                        │
                        ▼
          resolved / mitigated / not_resolved ──► post-incident summary
                        │
                        └── not_resolved ──► back to investigation
```

---

## 8. System architecture

| Component | Port | Role |
|---|---|---|
| **TrueForge** `@0.2.1` | 8790 | Agent loop, MCP connections, approval pause, session/turn history, session UI. Local SQLite mode. |
| **db-mcp** | 7101 | Read-only DB health tools |
| **cloud-mcp** | 7102 | Service status, metrics, Sentry errors (read) + `restart_service`, `scale_service`, `clear_cache` (approval-gated) |
| **github-mcp** | 7103 | Commits and diffs (read) + `trigger_rollback` (approval-gated), `create_fix_pr` (stretch) |
| **Backend** (Express) | 4000 | Creates sessions, derives incident status from turn events, proxies approve/reject. **No reasoning logic.** |
| **Dashboard** (React) | 5173 | Incident feed, report, pending action with Approve/Reject, live metrics chart, deep link to the TrueForge session |
| **Demo app** (Node, on Render) | 3000 | Service with injectable faults, `/health`, `/metrics`, admin endpoints |

All MCP servers use Streamable HTTP at `/mcp`. Locally, TrueForge must start with `OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'` or it refuses to connect to them.

Detailed interfaces:
- [demo-app-api.md](contracts/demo-app-api.md)
- [mcp-tools.md](contracts/mcp-tools.md)
- [backend-api.md](contracts/backend-api.md)
- [trueforge.md](contracts/trueforge.md)

---

## 9. Tech stack

| Layer | Choice |
|---|---|
| Agent runtime | TrueForge `0.2.1` (MIT), local/SQLite mode |
| Model | Claude, via TrueForge's Anthropic provider (model id pinned) |
| MCP connectors | Node.js ≥ 22.14 + `@modelcontextprotocol/sdk` |
| Backend | Node.js + Express |
| Dashboard | React (Vite), one page |
| Error capture | Sentry (free tier) |
| Hosting | Render. Rollback goes through the Render API. |
| Database | Neon or Supabase (managed Postgres) |
| GitHub access | Fine-grained PAT (Octokit) |
| Notifications (optional) | Slack incoming webhook |

---

## 10. Safety guardrails

1. **Whitelist by construction.** An action that isn't whitelisted doesn't exist as a tool on any MCP server.
2. **Runtime-enforced approval.** Every write tool is listed by name in `require_approval_for_tools`. TrueForge pauses before it runs, and application code can't skip the pause by accident.
3. **Inspectable reasoning.** Every tool call, observation and model message is in the TrueForge session history, not only the final answer.
4. **No credentials in the model.** Render, GitHub and Sentry credentials live only in the MCP server processes.
5. **Evidence-bound answers.** The instructions forbid claims that aren't backed by a tool result, and the report schema requires every evidence item to name its tool.
6. **Honest verification.** A fix that only treats symptoms is reported as *mitigated*, never *resolved*.

---

## 11. Demo scenarios & success criteria

| | **Scenario A: code-level** | **Scenario B: infra-level** |
|---|---|---|
| Trigger | Deploy a commit that forgets `client.release()` in `GET /orders` | Inject unbounded cache growth (no deploy) |
| Symptoms | Pool 10/10, requests waiting, timeouts, 500s; Sentry errors tagged with bad SHA | Memory climbing, p95 latency up; DB healthy; no recent commits |
| Correct diagnosis | Commit `<sha>` introduced a connection leak | Runtime cache growth, not a deploy |
| Correct fix | `trigger_rollback` | `clear_cache` (restart acceptable) |
| Trap fix | `restart_service` → only *mitigated* | `trigger_rollback` → nothing to roll back |
| Resolved when | 60s: pool < 50%, no waiters, error rate < 1%, running SHA ≠ bad SHA | 60s: memory < 60% of limit and flat, p95 back to baseline |

Full definitions: [contracts/scenarios.md](contracts/scenarios.md).

**Demo script:** trigger a scenario live → the agent investigates on screen → the root cause appears with cited evidence → the fix is proposed → the presenter clicks **Approve** → the metrics chart visibly recovers → the dashboard shows before/after and the verdict → open the TrueForge session to show the full reasoning trail.

**Success metrics:**
- Correct diagnosis **and** correct fix in ≥ 9/10 runs for each scenario.
- Trigger to "awaiting approval" in under 2 minutes.
- Zero write actions without approval, across all test runs.

---

## 12. Build timeline (36 hours, 4 parallel workstreams)

Ownership and checklists: [TEAM_PLAN.md](TEAM_PLAN.md).

| Hours | Milestone |
|---|---|
| 0–2 | **Phase 0:** repo skeleton, contracts drafted, TrueForge + approval gate verified ✅. Remaining: team review and freeze of contracts |
| 2–8 | Parallel build against mocks. P1 demo app + Scenario A · P2 MCP servers in mock mode · P3 AgentSpec + instructions · P4 backend + dashboard on fake data |
| **8** | ✔ Scenario A end to end **with mocks** |
| 8–16 | Swap mocks for real infra; real rollback; verification loop |
| **16** | ✔ Scenario A end to end **on real infra** |
| 16–24 | Scenario B; dashboard polish; eval script |
| **24** | ✔ Scenario B works. **Feature freeze** |
| 24–30 | 10+ runs per scenario, prompt hardening, backup video |
| 30–34 | Buffer, stretch goals only if everything is green, rehearsal ×2 |
| 34–36 | Final rehearsal, pitch |

---

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| The LLM invents a root cause | Evidence-bound instructions; schema requires the source tool per evidence item; unambiguous seeded signals; 10+ run eval |
| Live demo failure | Reproducible scenarios with `/admin/reset`; rehearse ×2; recorded backup video |
| Scope creep | Hard lock to 2 scenarios; feature freeze at hour 24 |
| TrueForge is pre-1.0 (0.3.0-rc already exists) | Pin `@0.2.1`; the API shapes we rely on are documented in `contracts/trueforge.md` |
| Approval gate doesn't behave as documented | ✅ Retired. Verified allow/deny end to end in `agent/spike` |
| Render rollback is slow | P1 measures it early; demo script covers the wait (walk through the evidence while it deploys) |
| Model non-determinism | Pin the model id; disable dynamic sub-agents and ask-user questions; the eval script tracks accuracy |

---

## 14. Stretch goals (post-MVP)

- Auto-detection via a metric/alert webhook instead of a manual trigger
- GitHub App with push/deploy webhooks to correlate deploys automatically
- `create_fix_pr`: the agent opens a PR with the code fix (approval-gated)
- Slack-based approval alongside the dashboard, through TrueForge's HTTP API
- Learning from past incidents (retrieval of similar incidents)
- Multi-cloud support
- Autonomous mode for low-risk actions, which only means editing `require_approval_for_tools` in the config
