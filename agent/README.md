# agent/ — P3 (Vaibhav Kumawat)

The agent brain: TrueForge setup, AgentSpec, instructions, report tools, mock model, evals.
API details and gotchas: [contracts/trueforge.md](../contracts/trueforge.md).

## Files

| File | What |
|---|---|
| `instructions.md` | The runbook the model follows: evidence rules, code-vs-infra decision, one action, verification, reporting |
| `agent-spec.mjs` | AgentSpec: MCP servers, write tools needing approval, runtime config. `incidentPrompt()` |
| `report-schema.mjs` | Zod schemas for `submit_diagnosis` / `submit_resolution` (source of truth; `npm run schema` regenerates `contracts/incident-report.schema.json`) |
| `report-mcp/server.mjs` | MCP server (port 7104) exposing the two report tools |
| `lib/providers.mjs` | Model providers in fallback order: OpenAI → Grok (xAI), plus `mock` |
| `lib/trueforge-client.mjs` | Client for P4's backend: sessions, fallback, approve/reject, `getReports`, `getPendingAction`, `listToolCalls`, `loadSession` |
| `setup.mjs` | Registers providers, MCP servers and the `incident-investigator` agent. Safe to re-run |
| `run-incident.mjs` | One incident end to end from the CLI (same calls the backend makes) |
| `eval.mjs` | N runs × scenario × provider, graded against `contracts/scenarios.md`, saved to `eval-results/` |
| `mock-model.mjs` | Rule-based stand-in for the LLM (port 7300). Follows the runbook on real tool results. `MOCK_BEHAVIOR=trap` picks wrong fixes |
| `spike/` | Phase 0 experiments (approval gate, fallback) |

## Run it

```bash
npm install

# Everything on mocks (no keys, no DB) — from the repo root:
../scripts/dev-mock-stack.sh
MODEL_PROVIDERS=mock node run-incident.mjs --scenario A        # B, or --decision deny
MODEL_PROVIDERS=mock node eval.mjs --providers mock --runs 5

# Real models (MCP servers + report-mcp + TrueForge running):
node --env-file=../.env setup.mjs
node --env-file=../.env run-incident.mjs --scenario A
node --env-file=../.env eval.mjs --providers openai --runs 10
node --env-file=../.env eval.mjs --providers xai --runs 10
```

## How the agent reports

1. Investigates with read-only tools.
2. `submit_diagnosis` (root cause, ≥2 cited evidence items, proposed fix + exact args, `before` metrics).
3. Calls exactly one write tool → TrueForge pauses → human approves or rejects.
4. `get_metrics_window {seconds: 60, waitSeconds: 60}`.
5. `submit_resolution` (resolved / mitigated / not_resolved / rejected, before/after, follow-up).

The backend reads 2 and 5 with `tf.getReports(sessionId)` and the paused action with `tf.getPendingAction(session, paused)`.

## Status

Verified on the mock stack: A → rollback → resolved · B → clear_cache → resolved · deny → tool never runs · trap fixes → mitigated / not_resolved, and the eval grader fails them.
Not yet run against a real model: needs `OPENAI_API_KEY` / `XAI_API_KEY`.
