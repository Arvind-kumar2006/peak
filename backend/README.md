# PEAK backend

P4 — a thin proxy over TrueForge. It holds no reasoning of its own: it opens
sessions, relays approval decisions, persists the event log, and derives incident
status from it.

Implements [`contracts/backend-api.md`](../contracts/backend-api.md).

## Run it

```bash
cd backend
npm install
cp .env.example .env      # optional — every key has a working default
npm start                 # http://localhost:4000
```

No configuration is required to start. With no `PEAK_DATABASE_URL` it runs on
the in-memory store, and with no TrueForge reachable it runs against a scripted
fake agent. Both fallbacks are logged loudly at boot so you always know which
mode you are in.

```bash
npm test        # 39 tests, pure logic, no network
npm run migrate # apply the schema without starting the server
npm run dev     # --watch
```

## The one design decision that matters

Every call into P3's world goes through a single adapter interface
(`src/trueforge/adapter.js`) with two implementations:

| Mode | What it is | When |
|---|---|---|
| `real.js` | HTTP against TrueForge at `TRUEFORGE_URL` | the agent core is up |
| `fake.js` | a scripted Scenario A / B event timeline | building the UI, rehearsing, CI |

`fake.js` emits events in the **same shapes** the real runtime produces, so the
mapper, the report parser, the status state machine and the whole dashboard run
their real code paths. The only thing missing is a language model. That is why
the dashboard was finished and demoed before the agent existed, and why going
live is one env var:

```bash
TRUEFORGE_MODE=real npm start
```

`auto` (the default) probes TrueForge at boot and picks `real` if it answers.

## Status is derived, never written

`src/domain/status.js` is a pure function:

```
deriveStatus({ events, decision }) -> { status, report, reason }
```

Two reasons, both about the demo:

1. **Auditable.** When a judge asks how we know it isn't just the model claiming
   success, the answer is a replay of the real TrueForge events. Nothing in this
   codebase ever writes `resolved` — that value comes from the agent's report
   `phase`.
2. **Idempotent.** Polling the same turn twice cannot corrupt state, so a dropped
   response or a double-clicked Approve is harmless.

Because it is pure, it is testable before the core exists. That is most of the
test suite.

## Layout

```
src/
  config.js            env parsing, .env loader, adapter-mode resolution
  asyncHandler.js      Express 4 does not catch async throws — see below
  app.js  index.js     app assembly, bootstrap, clean shutdown
  domain/
    status.js          the state machine (the only real logic)
    report.js          lenient IncidentReport parsing
    incident.js        row -> API shape
  trueforge/
    adapter.js         the seam: one interface, two implementations
    real.js            HTTP against :8790
    fake.js            scripted Scenario A / B
    mapper.js          TrueForge shapes -> ours, liberal in what it accepts
  store/
    index.js           picks pg or memory
    pg.js  memory.js   identical interface
    schema.sql         the `peak` schema
  services/
    sync.js            events -> incident state (used by poller and routes)
    poller.js          one background loop reads turn events
    sampler.js         2s metric snapshots for the before/after chart
    demoApp.js         proxy to P1, with a synthetic-metrics fallback
  routes/              incidents, demo, metrics
test/                  39 tests over the pure logic
```

## Storage

Postgres (Neon) when `PEAK_DATABASE_URL` is set, otherwise in-memory. Both
implement the same interface, so nothing above `store/` knows which it got.

Four tables in a dedicated `peak` schema — `incidents`, `incident_events`,
`decisions`, `metric_samples`. Notes:

- **Its own schema, its own DSN.** P1 owns `DATABASE_URL` and its own migrations.
  The worst possible time for our migrations to collide with theirs is during
  the incident we are demoing.
- **`incident_events` is the audit trail.** Raw TrueForge events, verbatim.
- **`decisions` is the safety claim.** The event log alone cannot distinguish an
  approved action from one the runtime ran unasked, so human decisions get their
  own table.
- **`metric_samples`** backs the before/after chart, and is the fallback when the
  agent's `verification` block comes back thin.

If Neon is configured but unreachable, the backend logs the error and falls back
to memory rather than refusing to boot.

## API

The seven contract endpoints, plus three additive ones:

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/incidents` | inject scenario, open session, start turn. Returns immediately. |
| `GET` | `/api/incidents` | newest first, summary shape |
| `GET` | `/api/incidents/:id` | the 2s poll endpoint; adds `timeline`, `decisions`, `metrics` |
| `POST` | `/api/incidents/:id/approve` | sends `user.tool_approval` allow |
| `POST` | `/api/incidents/:id/reject` | deny, with an optional reason |
| `POST` | `/api/demo/reset` | proxies P1's reset, closes open incidents |
| `GET` | `/api/metrics` | proxies `/metrics`; serves the last sample with `stale: true` if the app is down |
| `GET` | `/api/health` | **additive** — which adapter and store are live |
| `GET` | `/api/incidents/:id` | `turnDone` flag tells the UI whether the agent has finished wrapping up |

Statuses: the contract's seven, plus `diagnosed`, `cancelled` and a separate
`stalled` **flag**. `stalled` is deliberately not a status — overwriting
`investigating` with `stalled` would destroy the real state, and could make a
paused-for-approval incident look merely slow.

## Two things that will bite you if you don't know them

**Express 4 does not catch async throws.** A rejected promise in a route handler
hangs the request until the client gives up — with no log line. Since the
dashboard polls every 2s, that presents as a frozen UI. Every async handler goes
through `asyncHandler`.

**An approval starts a new turn.** The decision is the input to a new turn chained
to the paused one, and its id must become the incident's `last_turn_id`. Miss that
and the poller re-reads the already-paused turn forever, and the incident sits in
`executing` until someone notices.

## Handing over to the real runtime

1. `TRUEFORGE_MODE=real`, and set `TRUEFORGE_AGENT_NAME` to whatever P3 registered.
2. Check `GET /api/health` reports `agent.mode: "real"`.
3. The pending action needs the tool's **name and args** to render the approval
   card. `mapper.js` handles several plausible shapes and degrades to
   "details unavailable" rather than failing; if that shows up, the answer is in
   `test/mapper.test.mjs`, which has a case per shape.
