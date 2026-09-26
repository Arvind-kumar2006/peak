# Demo App API

Owner: **P1**. Consumed by P2 (MCP connectors) and P4 (simulate button).

Base URL: `DEMO_APP_URL` (local `http://localhost:3000`).
`/admin/*` requires header `x-admin-token: $ADMIN_TOKEN`.

## `GET /health`

```json
{ "status": "ok" | "degraded" | "down", "release": "a1b2c3d", "uptimeSec": 812 }
```

## `GET /metrics`

```json
{
  "timestamp": "2026-09-26T11:00:00Z",
  "release": "a1b2c3d",
  "http": { "rpm": 240, "errorRate": 0.004, "p95Ms": 120 },
  "db": { "pool": { "max": 10, "inUse": 3, "idle": 7, "waiting": 0 } },
  "process": { "memoryMB": 180, "memoryLimitMB": 512 },
  "cache": { "entries": 1200 }
}
```

`errorRate` is a fraction (0–1) over the last 60s.

## `POST /admin/inject/:scenario`

`scenario` = `conn-leak` | `mem-leak`

```json
{ "injected": "conn-leak", "at": "2026-09-26T11:00:00Z" }
```

## `POST /admin/reset`

Clears all injected faults, drains pool, clears cache.

```json
{ "reset": true }
```

## `POST /admin/cache/clear`

Used by `cloud-mcp.clear_cache`.

```json
{ "cleared": 48210 }
```

## Traffic

The app must generate its own background traffic (or ship a `load.js` script) so metrics move during the demo without anyone clicking.
