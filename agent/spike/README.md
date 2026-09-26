# TrueForge approval spike

Proves the Feature 3 gate: agent calls a destructive tool → TrueForge pauses → we approve over HTTP → tool runs.

```bash
# terminal 1 — TrueForge (allow localhost MCP servers)
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@0.2.1

# terminal 2 — dummy MCP server
cd agent/spike && npm install && npm run mcp

# terminal 3 — pick a model
cd agent/spike && npm run mock-model       # scripted model, no key needed (port 7300)

# terminal 4 — run the spike
cd agent/spike
MOCK_MODEL=1 npm run spike                  # full approval round-trip, no key
DECISION=deny MOCK_MODEL=1 npm run spike    # rejection path
ANTHROPIC_API_KEY=sk-ant-... npm run spike  # same, with real Claude
SKIP_MODEL=1 npm run spike                  # registration only
```

**Result (2026-09-26, mock model):** ✅ allow → paused, approved, `restart_service` executed, agent reported recovery. ✅ deny → paused, denied, tool never executed, agent wrapped up.

**Pass criteria:** output shows `✓ approval requested`, terminal 2 prints `restart_service EXECUTED` only after approval, final message says the service recovered. With `DECISION=deny`, the tool must **not** execute.

Optional: `MODEL_ID=<anthropic model id>` (default `claude-sonnet-5`).
