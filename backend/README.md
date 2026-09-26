# PEAK backend

P4 — a thin proxy over the agent runtime. It holds no reasoning of its own: it
opens sessions, relays approval decisions, persists the event log, and derives
incident status from it.

Implements [`contracts/backend-api.md`](../contracts/backend-api.md), and uses
P3's client (`agent/lib/trueforge-client.mjs`) rather than calling TrueForge
directly, as that contract requires.

## Run it

```bash
cd backend
npm install
cp .env.example .env      # optional — every key has a working default
npm start                 # http://localhost:4000
```

No configuration is needed to start. With no `PEAK_DATABASE_URL` it runs on the
in-memory store; with no TrueForge reachable it runs against a scripted fake
agent. Both fallbacks are logged loudly at boot, so you always know which mode
you are in.

```bash
npm test        # 38 tests, pure logic, no network
npm run migrate # apply the schema without starting the server
npm run dev     # --watch
```

## The shape of the flow

P3's client is **blocking**. `tf.start()` returns when the turn pauses for
approval or finishes, and `tf.approve()` returns after the agent has watched its
60-second recovery window. Neither fits inside an HTTP request, so:

```
POST /api/incidents   →  record the incident, fire a background task, return 201
                         (status: investigating — exactly as the contract says)
background task       →  agent investigates → submit_diagnosis → gate fires
poller (1.5s)         →  readState() → derive status → the dashboard's 2s poll reads us
POST .../approve      →  record the decision, fire a background task, return
background task       →  tool runs → get_metrics_window → submit_resolution → turn.done
```

Everything TrueForge-shaped goes through one adapter interface
(`src/trueforge/adapter.js`) with two implementations:

| Mode | What it is | When |
|---|---|---|
| `real.js` | wraps P3's client | the agent core is up |
| `fake.js` | scripted Scenario A / B event timeline | building the UI, rehearsing, CI |

`fake.js` emits the same event shapes P3's client reads — `model.message` with
`tool_calls`, `tool.response` keyed by `tool_call_id`, `tool.approval_required`,
`turn.done` — and submits its reports through `submit_diagnosis` /
`submit_resolution`, which is how the real agent reports. So the mapper, the
report parsers, the state machine and the whole dashboard all run their real
code paths against it. The only thing missing is a language model.

Going live is one env var:

```bash
TRUEFORGE_MODE=real npm start
```

`auto` (the default) probes TrueForge at boot and picks `real` if it answers. If
it answers but no model provider is configured, it falls back to the fake and
says exactly which key is missing — a configuration problem should not stop the
dashboard from booting.

## Status is derived, never written

`src/domain/status.js` is a pure function of the session state:

```
deriveStatus({ paused, diagnosis, resolution, turnDone, turnStatus, decision, error })
```

Two reasons, both about the demo:

1. **Auditable.** When a judge asks how we know it isn't just the model claiming
   success, the answer is a replay of the real events plus the agent's own
   submitted `Resolution`. Nothing in this codebase ever writes `resolved` —
   that value comes from `resolution.verdict`, and nowhere else.
2. **Idempotent.** Polling twice cannot corrupt state, so a dropped response or a
   double-clicked Approve is harmless.

Because it is pure, it is testable before the core exists. That is most of the
test suite.

The rule that matters most: **a turn that finishes without submitting a
Resolution is `error`**, not success. That is the contract's instruction and it
is the honest reading — otherwise an agent could walk away from a broken service
and have the dashboard call it fine.

## Storage

Postgres (Neon) when `PEAK_DATABASE_URL` is set, otherwise in-memory. Both
implement the same interface, so nothing above `store/` knows which it got.

Four tables in a dedicated `peak` schema — `incidents`, `incident_events`,
`decisions`, `metric_samples`. Notes:

- **Its own schema, its own DSN.** P1 owns `DATABASE_URL` and its own migrations.
  The worst possible time for our migrations to collide with theirs is during the
  incident we are demoing.
- **`incident_events` is the audit trail.** Raw runtime events, verbatim.
- **`decisions` is the safety claim.** The event log alone cannot distinguish an
  approved action from one the runtime ran unasked, so human decisions get their
  own table.
- **`metric_samples`** backs the before/after chart, and is the fallback when the
  agent's `Resolution` comes back thin.

If Neon is configured but unreachable, the backend logs the error and falls back
to memory rather than refusing to boot.

## API

The seven contract endpoints, plus two additive ones:

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/incidents` | inject scenario, open session, start turn. Returns `201` immediately. |
| `GET` | `/api/incidents` | newest first, summary shape |
| `GET` | `/api/incidents/:id` | the 2s poll endpoint; adds `timeline`, `decisions`, `metrics` |
| `POST` | `/api/incidents/:id/approve` | sends `user.tool_approval` allow |
| `POST` | `/api/incidents/:id/reject` | deny, with an optional reason |
| `POST` | `/api/demo/reset` | proxies P1's reset, closes open incidents |
| `GET` | `/api/metrics` | proxies `/metrics`; serves the last sample with `stale: true` if the app is down |
| `GET` | `/api/health` | **additive** — which adapter and store are live |

The Incident object carries `diagnosis` (available at `awaiting_approval`) and
`resolution` (available at the end), per the contract. Statuses are the
contract's set plus `diagnosed` and `cancelled`, and a separate `stalled`
**flag** — deliberately not a status, because overwriting `investigating` with
`stalled` would destroy the real state and could make a paused-for-approval
incident look merely slow.

## Four things that will bite you if you don't know them

**Express 4 does not catch async throws.** A rejected promise in a route handler
hangs the request until the client gives up — with no log line. Since the
dashboard polls every 2s, that presents as a frozen UI. Every async handler goes
through `asyncHandler`.

**The approval handle is rebuilt from events, not held in memory.** If we kept
P3's `paused` object in a variable, a backend restart mid-incident could never
approve it. `real.js` reconstructs it from the last `tool.approval_required`.

**Rejecting does not end the polling.** A rejected incident is terminal
immediately, but the agent's wrap-up turn still owes us the `Resolution` that
explains the refusal. Polling is keyed on `turn_done`, not on status.

**`GET /api/metrics` returns 200 with stale data, not a 502.** A chart that
freezes with a "stale" badge tells the truth; a red error panel during a live
demo is a distraction.

## Handing over to the real runtime

1. `TRUEFORGE_MODE=real`, plus a model provider (`MODEL_PROVIDERS`, and the
   matching API key — or `mock` with `agent/mock-model.mjs` running).
2. Check `GET /api/health` reports `agent.mode: "real"`.
3. The approval card needs the pending tool's **name and args**. That comes from
   P3's `getPendingAction()`; if the card shows "details unavailable", the answer
   is in `test/mapper.test.mjs`, which has a case per shape we handle.
