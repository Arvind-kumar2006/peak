# Backend API

Owner: **P4**. Consumed by the dashboard. The backend is a thin proxy over TrueForge — no reasoning logic.

Base URL: `BACKEND_URL` (local `http://localhost:4000`).

## Incident object

```json
{
  "id": "inc_01J...",
  "sessionId": "01J...",
  "scenario": "conn-leak",
  "status": "investigating" | "awaiting_approval" | "executing" | "resolved" | "mitigated" | "not_resolved" | "rejected" | "error",
  "createdAt": "2026-09-26T11:00:00Z",
  "report": { "...": "IncidentReport (contracts/incident-report.schema.json) or null" },
  "pendingAction": {
    "threadId": "...",
    "toolCallId": "...",
    "tool": "trigger_rollback",
    "args": { "toDeployId": "dep-123", "reason": "..." }
  },
  "trueforgeUrl": "http://localhost:8790/sessions/01J..."
}
```

`pendingAction` is non-null only while `status = awaiting_approval`.

## Endpoints

| Method | Path | Body | Does |
|---|---|---|---|
| `POST` | `/api/incidents` | `{ "scenario"?: "conn-leak" \| "mem-leak", "description"?: string }` | If `scenario` given, calls demo-app inject. Creates TrueForge session (metadata `incidentId`), starts investigation turn. Returns Incident |
| `GET` | `/api/incidents` | — | List, newest first |
| `GET` | `/api/incidents/:id` | — | One incident (status derived from TrueForge turn events) |
| `POST` | `/api/incidents/:id/approve` | — | Sends `user.tool_approval` `{status:"allow"}` for `pendingAction` |
| `POST` | `/api/incidents/:id/reject` | `{ "reason"?: string }` | Sends `user.tool_approval` `{status:"deny", reason}` |
| `POST` | `/api/demo/reset` | — | Calls demo-app `/admin/reset` |
| `GET` | `/api/metrics` | — | Proxies demo-app `/metrics` (for live chart) |

## Status mapping from TrueForge events

| TrueForge | Incident status |
|---|---|
| turn running, no action required | `investigating` / `executing` (after approval) |
| `tool.approval_required` event | `awaiting_approval` |
| `turn.done` with report.phase | `report.phase` (resolved / mitigated / not_resolved) |
| denied | `rejected` |
| turn state `error` | `error` |

Dashboard polls `GET /api/incidents/:id` every 2s (simple > SSE for a hackathon).
