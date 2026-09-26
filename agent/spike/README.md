# TrueForge approval spike

Proves the Feature 3 gate: agent calls a destructive tool → TrueForge pauses → we approve over HTTP → tool runs.

```bash
# terminal 1 — TrueForge (allow localhost MCP servers)
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@0.2.1

# terminal 2 — dummy MCP server
cd agent/spike && npm install && npm run mcp

# terminal 3 — run the spike
cd agent/spike
SKIP_MODEL=1 npm run spike                  # registration only, no key needed
ANTHROPIC_API_KEY=sk-ant-... npm run spike  # full approval round-trip
DECISION=deny ANTHROPIC_API_KEY=... npm run spike   # test rejection path
```

**Pass criteria:** output shows `✓ approval requested`, terminal 2 prints `restart_service EXECUTED` only after approval, final message says the service recovered. With `DECISION=deny`, the tool must **not** execute.

Optional: `MODEL_ID=<anthropic model id>` (default `claude-sonnet-5`).
