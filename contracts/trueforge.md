# TrueForge Integration (verified against v0.2.1)

Owner: **P3**. Everything below was checked against a running TrueForge 0.2.1 on 2026-09-26 unless marked ⚠️.

## Decision: GO with TrueForge ✅

| PRD assumption | Status |
|---|---|
| Runs locally with one command, SQLite | ✅ `npx @truefoundry/trueforge@0.2.1` → http://localhost:8790 |
| HTTP API for sessions / turns / events | ✅ OpenAPI at `/api/v1/openapi.json`, Swagger at `/api/v1/docs` |
| Connects to our MCP servers | ✅ **Remote (HTTP) only** — no stdio. Verified with `agent/spike/dummy-mcp.mjs` |
| Per-tool approval gate | ✅ `require_approval_for_tools` on each MCP server in the AgentSpec (`@write`, `@destructive`, `@all`, or tool names) |
| Approve / deny from our backend | ✅ **verified end-to-end** (allow → tool runs; deny → tool never runs) via `agent/spike` |
| Structured reports | ✅ via **report-mcp tools** (`submit_diagnosis`, `submit_resolution`), not `response_format` — see below |
| Session history = incident timeline | ✅ `GET /sessions/{id}/events`, `GET /sessions/{id}/turns/{turn}/events` |
| Deep link to session UI | ✅ `http://localhost:8790/sessions/{sessionId}` |
| Tag session with our incident id | ✅ `metadata: { incidentId: "..." }` on session create (string values, ≤128 chars) |

Verified with the scripted mock model (`agent/spike/mock-model.mjs`). The gate is enforced by TrueForge's runtime, independent of which model is used. Still worth one run with a real key to check prompt behaviour (`OPENAI_API_KEY=... npm run spike`).

## Gotchas found

1. **Localhost MCP servers are blocked by default** (SSRF guard). Start TrueForge with:
   ```bash
   OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@0.2.1
   ```
2. **Pin the version** — `0.3.0-rc.0` exists; API may change. Always `@0.2.1`.
3. All API responses are wrapped: `{ "data": ... }`.
4. Event list `limit` max is **100**.
5. Node **≥ 22.14** required.
6. Default agent config enables `dynamic_sub_agents`, `ask_user_questions`, `generative_ui`. For deterministic demos, `agent/agent-spec.mjs` disables sub-agents and ask_user_questions in `config`.
7. **Session events are wrapped** as `{ turn_id, event }` and listed newest-first (turn events are not wrapped). `listSessionEvents()` in `agent/lib/trueforge-client.mjs` unwraps and sorts them.
8. **A paused turn also ends with `turn.done`** (`status: "done"`, `output: null`, `required_actions: [tool.approval_required]`). Check for `tool.approval_required` first.
9. Tool calls live in `model.message` events: `tool_calls[].{ id, function.name, function.arguments (JSON string), tool_info.server_name }`; results in `tool.response` events keyed by `tool_call_id`.
10. Default MCP request timeout is **4 minutes** (`MCP_REQUEST_TIMEOUT_MS`), so a 60s blocking `get_metrics_window` is safe.

## API cheat sheet (base `/api/v1`)

```text
PUT  /settings/model-providers   { manifest: { type:"openai", auth:{api_key}, models:[{model_id, name, properties:{}}] } }
PUT  /settings/mcp-servers       { manifest: { type:"remote", name, url, description } }
GET  /mcp-servers/{name}/tools
POST /agents                     { name, description, manifest: AgentSpec }
POST /sessions                   { agent: { name } | { spec: AgentSpec }, metadata }
POST /sessions/{id}/turns        { input: [...], previous_turn_id?, stream: false }
GET  /sessions/{id}/turns/{turnId}/events?limit=100
POST /sessions/{id}/cancel
```

Model name in AgentSpec = `"<provider>/<configured name>"`, e.g. `openai/peak-model`.

## Model providers & fallback

| Provider | TrueForge type | Config |
|---|---|---|
| **OpenAI** (primary) | `openai` | `OPENAI_API_KEY`, `OPENAI_MODEL` |
| **Grok / xAI** (fallback) | `custom`, `base_url: https://api.x.ai/v1` (OpenAI-compatible) | `XAI_API_KEY`, `XAI_MODEL` |
| mock (dev) | `custom`, `base_url: http://localhost:7300/v1` | none |

Order: `MODEL_PROVIDERS=openai,xai` (providers with no key are skipped). Definitions: `agent/lib/providers.mjs`.

**TrueForge has no built-in model fallback.** `agent/lib/trueforge-client.mjs` does it:

1. Create the session on the first provider.
2. If a turn ends with `state.status = "error"`, `PATCH /sessions/{id}` with the same spec but the next provider's model, then retry the turn chained to the failed one (`previous_turn_id`).
3. If the failed turn was an approval resume, retry with a "continue" user message instead, since the approval can't be replayed.
4. Once the last provider fails, return the error.

Verified with a mock provider returning 503: the session switched and completed investigate → approval → execute on the fallback. With fake real keys, OpenAI returned 401 (endpoint OK) and xAI returned 400 (expected for an invalid key; confirm with a real key).

⚠️ Not yet tested: a provider failing **after** an approved tool ran (step 3).
⚠️ The retried turn repeats the user message in history. Harmless, but visible in the session UI.

### AgentSpec MCP entry

```json
{
  "name": "cloud-mcp",
  "preload": true,
  "require_approval_for_tools": ["restart_service", "scale_service", "clear_cache"]
}
```

List write tools **by name** (not only `@destructive`) so the gate never depends on annotations being right.

### Approval flow (what the backend does)

1. Start turn: `POST /sessions/{id}/turns` with `[{ type: "user.message", content }]`, `stream: false`.
2. Poll turn events until one of:
   - `tool.approval_required` → `{ thread_id, tool_calls: [{ id, source_event_id }] }` → incident status `awaiting_approval`
   - `turn.done` → `state.status` is `done` | `error` | `cancelled`
3. On approve/reject, create a new turn chained to the paused one:
   ```json
   {
     "previous_turn_id": "<paused turn id>",
     "stream": false,
     "input": [{
       "type": "user.tool_approval",
       "thread_id": "<from event>",
       "tool_call_id": "<tool_calls[i].id>",
       "approval": { "status": "allow" }
     }]
   }
   ```
   Deny: `"approval": { "status": "deny", "reason": "..." }`.
4. Poll the new turn's events until `turn.done`; the last `model.message` holds the report JSON.

### Verified event details

- **Final answer:** `turn.done` → `state.output` is the final `model.message`: `{ type: "model.message", content: "<text or report JSON>", thread_id: "main", finish_reason: "stop", ... }`. No need to scan the event list.
- **Denied tool:** the agent receives a tool result `{"error":"User denied tool call: <reason>"}` and continues the turn (it should wrap up, not retry).
- **Thread id:** the main agent thread is `"main"`.
- **Pending tool name + args:** the `model.message` event referenced by `tool_calls[].source_event_id` holds them. `getPendingAction()` in the client returns them ready to display.

## Mock model (no API key, deterministic)

TrueForge's `custom` provider talks the **OpenAI Chat Completions** API (`POST {base_url}/chat/completions`, `stream: true`). `agent/spike/mock-model.mjs` is a scripted model on port 7300:

```json
PUT /settings/model-providers
{ "manifest": { "type": "custom", "name": "mock", "base_url": "http://localhost:7300/v1",
  "auth": { "api_key": "not-used" }, "models": [{ "model_id": "mock-1", "name": "spike-model", "properties": {} }] } }
```

Use it for backend/dashboard development and CI: free, instant, same result every time. P3 can extend the script to replay Scenario A and B.

MCP tools appear to the model under their **plain names** (`restart_service`, not prefixed) when `preload: true`.

## Why report tools instead of `response_format`

The final JSON answer only exists when the turn **finishes**, but the approver needs the diagnosis while the turn is **paused** on the write tool. So the agent calls `report-mcp.submit_diagnosis` before the action and `submit_resolution` after verifying. The tool arguments are validated by Zod on the server (`agent/report-schema.mjs`), so a malformed report returns an error the model can fix. It works the same on OpenAI, Grok and the mock model, and no strict-schema quirks are involved.

Backend usage (`agent/lib/trueforge-client.mjs`):

```js
const { diagnosis, resolution } = await tf.getReports(sessionId);  // latest submitted args, or null
const pending = await tf.getPendingAction(session, paused);          // [{ tool, server, args, toolCallId, threadId }]
const calls = await tf.listToolCalls(sessionId);                    // full timeline: tool, args, result, at
const session = await tf.loadSession(sessionId);                    // re-attach after a backend restart
```
