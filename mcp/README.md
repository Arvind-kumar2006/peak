# mcp/ — P2 (Pranjal Negi)

Three MCP servers, Streamable HTTP at `/mcp`. Contract: [contracts/mcp-tools.md](../contracts/mcp-tools.md).

| Server | Port | Run |
|---|---|---|
| db-mcp | 7101 | `MOCK=1 node db/server.js` |
| cloud-mcp | 7102 | `MOCK=1 node cloud/server.js` |
| github-mcp | 7103 | `MOCK=1 node github/server.js` |

Install once: `npm install` in `_shared/`, `db/`, `cloud/`, `github/`. Or run the whole stack with `../scripts/dev-mock-stack.sh`.

## Mock mode (`MOCK=1`)

All three servers share one simulated world (`_shared/mockState.js`, a JSON file in the OS temp dir), so they agree with each other:

- Numbers are P1's measured values; Scenario A's commit and diff are the real `5a824ff`.
- Write tools change the world: `trigger_rollback` fixes A, `clear_cache` fixes B, `restart_service` during A only mitigates (the leak refills the pool over ~60s), wrong actions do nothing.
- Reset or switch scenario from any server:

```bash
curl -X POST localhost:7101/mock/state -d '{"scenario":"A"}'   # A | B | healthy
curl localhost:7101/mock/state
```

## Real mode

Tools not yet wired to a real backend return an explicit "not implemented" error, never zeros. Done: `cloud-mcp` `get_metrics`, `get_metrics_window` (samples `DEMO_APP_URL/metrics` every 10s), `clear_cache`. Remaining: Render, GitHub, Sentry, Postgres (see TEAM_PLAN.md).
