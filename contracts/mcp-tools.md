# MCP Tools

Owner: **P2** (`report-mcp`: **P3**). Consumed by P3 (`agent/agent-spec.mjs`, `agent/instructions.md`).

- Every server: Node + `@modelcontextprotocol/sdk`, **Streamable HTTP at `/mcp`** (TrueForge does not support stdio).
- Every server supports `MOCK=1` → a **shared simulated world** (`mcp/_shared/mockState.js`) using P1's measured numbers and the real Scenario A commit. Write tools change it: a rollback in `github-mcp` makes `cloud-mcp` metrics recover.
  - `POST /mock/state` with `{ "scenario": "A" | "B" | "healthy" }` on any server resets the world; `GET /mock/state` shows it. State file: `MOCK_STATE_FILE` (default: OS temp dir).
- **Real mode never returns fake zeros.** A tool that isn't wired to a real backend yet returns `isError` with "not implemented in real mode", so the agent can't mistake it for a healthy reading.
- Read tools: annotate `readOnlyHint: true`.
- Write tools: annotate `destructiveHint: true` **and** list by name in the AgentSpec's `require_approval_for_tools`.
- Every response includes `source` (where the data came from) and `observedAt`, so the agent can cite evidence.

---

## db-mcp (port 7101) — read only

| Tool | Input | Output |
|---|---|---|
| `get_pool_stats` | — | `{ max, inUse, idle, waiting, idleInTransaction, source, observedAt }` |
| `get_slow_queries` | `{ limit?: number = 5 }` | `{ queries: [{ query, meanMs, calls, note? }], source, observedAt }` |
| `get_lock_waits` | — | `{ waits: [{ pid, waitingOn, durationMs, query }], source, observedAt }` |

## cloud-mcp (port 7102)

| Tool | Kind | Input | Output |
|---|---|---|---|
| `get_service_status` | read | — | `{ status, runningCommit (7-char), currentDeploy: { id, commitSha, createdAt }, previousDeploy: { id, commitSha }, restartCount, source, observedAt }` — `previousDeploy.id` is the rollback target |
| `get_metrics` | read | — | Demo app `/metrics` payload + `source, observedAt` |
| `get_metrics_window` | read | `{ seconds = 60, intervalSec = 10, waitSeconds = 0 }` | `{ samples: [metrics...], source }` — **used for verification**: `waitSeconds: 60` waits first so only post-fix samples come back. Real mode reads a background sampler (`/metrics` every 10s); mock mode evaluates the simulated world instantly |
| `restart_service` | **write, approval** | `{ reason: string }` | `{ ok, deployId?, at }` |
| `scale_service` | **write, approval** | `{ instances: 1-3, reason: string }` | `{ ok, instances, at }` |
| `clear_cache` | **write, approval** | `{ reason: string }` | `{ ok, cleared, at }` |

## github-mcp (port 7103)

| Tool | Kind | Input | Output |
|---|---|---|---|
| `list_recent_commits` | read | `{ sinceMinutes: number = 120 }` | `{ commits: [{ sha, message, author, timestamp, filesChanged }], source }` |
| `get_commit_diff` | read | `{ sha: string }` — full SHA **or ≥7-char prefix** | `{ sha, message, author, timestamp, files: [{ path, patch }], source }`; unknown SHA → `isError` |
| `trigger_rollback` | **write, approval** | `{ toDeployId: string, reason: string }` | `{ ok, rollbackDeployId, at }` (Render rollback API — NOT the deploy hook) |
| `create_fix_pr` | **write, approval** (stretch) | `{ title, body, files: [{ path, content }] }` | `{ ok, prUrl }` |

> Decided: all GitHub tools live in our own `github-mcp`. `list_recent_commits` honours `sinceMinutes` (Scenario B's 120-minute window is empty by design). `trigger_rollback` rejects unknown deploy ids. `create_fix_pr` is disabled in the AgentSpec (stretch goal).

## sentry (read only)

| Tool | Input | Output |
|---|---|---|
| `get_recent_errors` | `{ sinceMinutes: number = 30 }` | `{ issues: [{ title, count, firstSeen, lastSeen, release, culprit }], source }` |

> Decided: `get_recent_errors` lives in `cloud-mcp`.

## report-mcp (port 7104) — P3, read only (no approval)

| Tool | Input | Output |
|---|---|---|
| `submit_diagnosis` | `Diagnosis` in [`incident-report.schema.json`](incident-report.schema.json) | `{ ok, next }`. Must be called before any write tool |
| `submit_resolution` | `Resolution` in [`incident-report.schema.json`](incident-report.schema.json) | `{ ok, next }`. Last tool call, after verification |

Validation errors come back as tool errors, so the model can correct the report.

## Real-mode status

| Tool | Real mode |
|---|---|
| `cloud-mcp.get_metrics`, `get_metrics_window`, `clear_cache` | ✅ talk to the demo app (`DEMO_APP_URL`, `ADMIN_TOKEN`) |
| everything else | ⏳ returns "not implemented" (P2: Render API, Sentry API, GitHub API, Postgres) |
