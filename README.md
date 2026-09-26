# PEAK — AI Production Incident Response Agent

PEAK closes the loop on production incidents: **detect → investigate → diagnose → propose fix → execute (with human approval) → verify recovery.**

It plugs into the stack a team already has (GitHub, Sentry, Postgres, Render), finds the root cause with cited evidence, proposes a single whitelisted fix, waits for a human to click **Approve**, then checks that the service actually recovered.

> Hackathon project. See [PRD.md](PRD.md) for the product spec, [TEAM_PLAN.md](TEAM_PLAN.md) for who owns what, and [contracts/](contracts/) for the interfaces between components.

## How it works

```
 Simulate incident ─┐
                    ▼
            ┌──────────────┐   REST    ┌────────────┐
            │  Dashboard   │◀────────▶│  Backend   │  thin proxy, no reasoning
            │   :5173      │           │   :4000    │
            └──────────────┘           └─────┬──────┘
                                             │ sessions / turns / approvals
                                             ▼
                                    ┌──────────────────┐
                                    │    TrueForge     │  agent loop, approval gate,
                                    │      :8790       │  session history, UI
                                    └───┬─────┬─────┬──┘
                          MCP over HTTP │     │     │
                     ┌──────────────────┘     │     └──────────────────┐
                     ▼                        ▼                        ▼
              ┌────────────┐          ┌──────────────┐         ┌──────────────┐
              │  db-mcp    │          │  cloud-mcp   │         │  github-mcp  │
              │  :7101     │          │  :7102       │         │  :7103       │
              │  read only │          │ read + write │         │ read + write │
              └─────┬──────┘          └──────┬───────┘         └──────┬───────┘
                    ▼                        ▼                        ▼
                Postgres           Demo app / Render / Sentry       GitHub
```

1. An incident is triggered, and the backend starts a TrueForge session.
2. The agent investigates with read-only MCP tools: pool stats, metrics, Sentry errors, recent commits.
3. It produces a structured report (root cause, confidence, evidence, proposed fix) that must match [`incident-report.schema.json`](contracts/incident-report.schema.json).
4. It calls a whitelisted write tool (`trigger_rollback`, `restart_service`, `scale_service`, `clear_cache`). **TrueForge pauses the turn.**
5. A human clicks Approve or Reject on the dashboard, and the backend resumes the turn.
6. On approve, the tool runs. The agent then watches the metrics for 60s and reports **resolved / mitigated / not resolved**.

### Safety

- Only whitelisted actions exist. Anything else isn't a tool at all.
- Every write tool is paused for human approval by the runtime, not by our app code.
- The LLM never holds credentials. They live in the MCP servers.
- The full reasoning trail is kept in TrueForge's session history.

## Demo scenarios

| | Scenario A — code-level | Scenario B — infra-level |
|---|---|---|
| Cause | Bad deploy leaks DB connections | Unbounded cache growth, no deploy |
| Signal | Pool exhausted, 500s, Sentry errors tagged with bad SHA | Memory climbing, p95 latency up, DB healthy |
| Correct fix | `trigger_rollback` | `clear_cache` |
| Trap | `restart_service` only *mitigates* | `trigger_rollback` — nothing to roll back |

Details: [contracts/scenarios.md](contracts/scenarios.md).

## Repo layout

| Path | What | Owner |
|---|---|---|
| [`contracts/`](contracts/) | Shared interfaces — read these first | All |
| [`demo-app/`](demo-app/) | Node service we break on purpose | P1 |
| [`mcp/db`](mcp/db/), [`mcp/cloud`](mcp/cloud/), [`mcp/github`](mcp/github/) | MCP connectors (HTTP, `/mcp`) | P2 |
| [`agent/`](agent/) | AgentSpec, instructions, eval scripts, TrueForge spike | P3 |
| [`backend/`](backend/) | Express API over TrueForge | P4 |
| [`dashboard/`](dashboard/) | One-page incident dashboard | P4 |

## Quick start

**Requires Node.js ≥ 22.14.**

```bash
git clone <repo-url> && cd Peak
cp .env.example .env        # fill in your keys — never commit .env
```

### 1. Run TrueForge

```bash
./scripts/start-trueforge.sh
# = OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@0.2.1
```

- UI: http://localhost:8790 · API docs: http://localhost:8790/api/v1/docs
- `OUTBOUND_URL_ALLOWED_HOSTS` is required. Without it TrueForge refuses to connect to MCP servers on localhost.
- Keep the version pinned to `0.2.1`.

### 2. Verify the approval gate (spike)

```bash
cd agent/spike && npm install
npm run mcp                   # terminal A — dummy MCP server
npm run mock-model            # terminal B — scripted model, no API key needed
MOCK_MODEL=1 npm run spike    # terminal C — expect "✓ approval requested" → "Spike complete"
```

See [agent/spike/README.md](agent/spike/README.md) for pass criteria.

### 3. Run the components

Each package gets its own README with run instructions as it's built. Local ports:

| Service | Port |
|---|---|
| demo-app | 3000 |
| backend | 4000 |
| dashboard | 5173 |
| db-mcp / cloud-mcp / github-mcp | 7101 / 7102 / 7103 |
| mock-model (dev only) | 7300 |
| TrueForge | 8790 |

## Tech stack

TrueForge (agent runtime) · Node.js + `@modelcontextprotocol/sdk` (MCP servers) · Express (backend) · React (dashboard) · Postgres on Neon/Supabase · Sentry · Render · Claude (model)

## Team

| Role | Name |
|---|---|
| P1 — Demo App & Infra | Kumar Praveen |
| P2 — MCP Connectors | Pranjal Negi |
| P3 — Agent Brain | Vaibhav Kumawat |
| P4 — Backend, Dashboard & Demo | Arvind Kumar |
