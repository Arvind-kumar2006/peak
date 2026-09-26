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
| `lib/providers.mjs` | Model providers in fallback order: **Groq → Gemini → OpenAI → xAI (Grok)**, plus `mock`. Providers without a key are skipped |
| `lib/trueforge-client.mjs` | Client for P4's backend: sessions, fallback, approve/reject, `getReports`, `getPendingAction`, `listToolCalls`, `loadSession` |
| `model-proxy.mjs` | Groq compatibility proxy (port 7310) — required for Groq, see below |
| `setup.mjs` | Registers providers, MCP servers and the `incident-investigator` agent. Safe to re-run |
| `run-incident.mjs` | One incident end to end from the CLI (same calls the backend makes) |
| `eval.mjs` | N runs × scenario × provider, graded against `contracts/scenarios.md`, saved to `eval-results/` |
| `mock-model.mjs` | Rule-based stand-in for the LLM (port 7300). Follows the runbook on real tool results. `MOCK_BEHAVIOR=trap` picks wrong fixes |
| `spike/` | Phase 0 experiments (approval gate, fallback) |

## Model providers

Keys live in the repo-root `.env` (and `backend/.env` for the backend) — both gitignored.

| Provider | Key | Model (env) | Notes |
|---|---|---|---|
| Groq | `GROQ_API_KEY` (`gsk_…`) | `GROQ_MODEL` = `openai/gpt-oss-120b` | Through `model-proxy.mjs`. **Free tier: 8,000 tokens/min** — expect minutes per incident |
| Gemini | `GEMINI_API_KEY` | `GEMINI_MODEL` = `gemini-2.5-flash` | Native TrueForge provider. Not yet tested with a real key |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` | Not yet tested with a real key |
| xAI Grok | `XAI_API_KEY` (`xai-…`) | `XAI_MODEL` | Not yet tested with a real key |

Order: `MODEL_PROVIDERS=groq,gemini,openai,xai`. When a turn fails on one provider, the session switches to the next.

**Why the Groq proxy exists** (TrueForge 0.2.1 behaviour we can't configure):
1. TrueForge replays assistant messages with `reasoning_content`; Groq rejects that field → 400 on the second call.
2. TrueForge drops extra model params for custom providers, so `include_reasoning: false` can't be set in the AgentSpec.
3. TrueForge adds ~8 harness tools (tool discovery, sub-agents, UI) PEAK doesn't use; they cost ~2k tokens per call and the model misused `call_tool`.
4. On a 429 it waits the time Groq asks for and retries, instead of failing the turn.

## Run it

```bash
npm install

# Everything on mocks (no keys, no DB) — from the repo root:
../scripts/dev-mock-stack.sh          # also starts model-proxy on :7310
MODEL_PROVIDERS=mock node run-incident.mjs --scenario A        # B, or --decision deny
MODEL_PROVIDERS=mock node eval.mjs --providers mock --runs 5

# Real models (MCP servers + report-mcp + TrueForge running):
node --env-file=../.env setup.mjs
node --env-file=../.env run-incident.mjs --scenario A
node --env-file=../.env eval.mjs --providers groq --runs 3
node --env-file=../.env eval.mjs --providers gemini --runs 10
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
