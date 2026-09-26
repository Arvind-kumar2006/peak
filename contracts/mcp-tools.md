# MCP Tools

Owner: **P2**. Consumed by P3 (AgentSpec / SKILL.md).

- Every server: Node + `@modelcontextprotocol/sdk`, **Streamable HTTP at `/mcp`** (TrueForge does not support stdio).
- Every server supports `MOCK=1` → returns fixed contract-shaped data (so P3 can work before P1 is deployed).
- Read tools: annotate `readOnlyHint: true`.
- Write tools: annotate `destructiveHint: true` **and** list by name in the AgentSpec's `require_approval_for_tools`.
- Every response includes `source` (where the data came from) and `observedAt`, so the agent can cite evidence.

---

## db-mcp (port 7101) — read only

| Tool | Input | Output |
|---|---|---|
| `get_pool_stats` | — | `{ max, inUse, idle, waiting, idleInTransaction, source, observedAt }` |
| `get_slow_queries` | `{ limit?: number = 5 }` | `{ queries: [{ query, meanMs, calls }], source, observedAt }` |
| `get_lock_waits` | — | `{ waits: [{ pid, waitingOn, durationMs, query }], source, observedAt }` |

## cloud-mcp (port 7102)

| Tool | Kind | Input | Output |
|---|---|---|---|
| `get_service_status` | read | — | `{ status, currentDeploy: { id, commitSha, createdAt }, previousDeploy: { id, commitSha }, restartCount, source, observedAt }` |
| `get_metrics` | read | — | Demo app `/metrics` payload + `source, observedAt` |
| `get_metrics_window` | read | `{ seconds: number = 60, intervalSec: number = 10 }` | `{ samples: [metrics...], source }` — **used for verification** |
| `restart_service` | **write, approval** | `{ reason: string }` | `{ ok, deployId?, at }` |
| `scale_service` | **write, approval** | `{ instances: 1-3, reason: string }` | `{ ok, instances, at }` |
| `clear_cache` | **write, approval** | `{ reason: string }` | `{ ok, cleared, at }` |

## github-mcp (port 7103)

| Tool | Kind | Input | Output |
|---|---|---|---|
| `list_recent_commits` | read | `{ sinceMinutes: number = 120 }` | `{ commits: [{ sha, message, author, timestamp, filesChanged }], source }` |
| `get_commit_diff` | read | `{ sha: string }` | `{ sha, message, files: [{ path, patch }], source }` |
| `trigger_rollback` | **write, approval** | `{ toDeployId: string, reason: string }` | `{ ok, rollbackDeployId, at }` (Render rollback API — NOT the deploy hook) |
| `create_fix_pr` | **write, approval** (stretch) | `{ title, body, files: [{ path, content }] }` | `{ ok, prUrl }` |

> Decide at kickoff: use the official GitHub MCP server (read-only toolset) for reads and keep only write tools here — or keep all four here for simplicity. Recommendation: **keep all here**, it's ~100 lines and avoids auth/config surprises.

## sentry (read only)

| Tool | Input | Output |
|---|---|---|
| `get_recent_errors` | `{ sinceMinutes: number = 30 }` | `{ issues: [{ title, count, firstSeen, lastSeen, release, culprit }], source }` |

> Either the official Sentry MCP server or add this one tool to cloud-mcp. Recommendation: **add to cloud-mcp** for the hackathon.
