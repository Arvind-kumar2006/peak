# Contracts

Shared agreements between the four workstreams. **Frozen after kickoff** — changing one means pinging the whole team first.

| File | Owner | What it defines |
|---|---|---|
| [scenarios.md](scenarios.md) | P1 | The two seeded failures: cause, signals, correct fix, "resolved" definition |
| [demo-app-api.md](demo-app-api.md) | P1 | Health / metrics / inject endpoints on the demo app |
| [mcp-tools.md](mcp-tools.md) | P2 | Every MCP tool: name, input, output, read vs approval-gated write |
| [incident-report.schema.json](incident-report.schema.json) | P3 | Diagnosis + Resolution reports the agent submits via report-mcp (generated from `agent/report-schema.mjs`) |
| [backend-api.md](backend-api.md) | P4 | REST API the dashboard talks to |
| [trueforge.md](trueforge.md) | P3 | Verified facts about TrueForge 0.2.1 and how we integrate with it |

## Local ports

| Service | Port |
|---|---|
| demo-app | 3000 |
| backend | 4000 |
| dashboard | 5173 |
| db-mcp | 7101 |
| cloud-mcp | 7102 |
| github-mcp | 7103 |
| report-mcp (P3) | 7104 |
| mock-model (dev only) | 7300 |
| TrueForge | 8790 |

All MCP servers expose **Streamable HTTP at `/mcp`** (TrueForge only supports remote MCP servers — no stdio).
