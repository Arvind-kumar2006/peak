-- PEAK backend schema. Owner: P4.
--
-- Deliberately its own `peak` schema rather than tables in `public`: P1 owns
-- DATABASE_URL and its own migrations, and the worst possible time for our
-- migrations to collide with theirs is during the incident we are demoing.
--
-- Idempotent. Safe to run on every boot.

CREATE SCHEMA IF NOT EXISTS peak;

-- One row per incident. `status` is *derived* from incident_events by
-- domain/status.js; it is cached here so the 2s dashboard poll is a single
-- cheap read instead of a replay.
CREATE TABLE IF NOT EXISTS peak.incidents (
  id              text PRIMARY KEY,
  session_id      text,
  turn_ids        jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_turn_id    text,
  scenario        text,
  description     text,
  status          text NOT NULL DEFAULT 'investigating',
  report          jsonb,
  pending_action  jsonb,
  decision        text,
  error           text,
  trueforge_url   text,
  last_event_at   timestamptz,
  stalled         boolean NOT NULL DEFAULT false,
  -- True once the current turn has reported turn.done. Kept separate from
  -- `status` because a rejection is terminal for the *incident* while its turn
  -- is still running and still owes us the agent's wrap-up report. Without this
  -- the poller would stop on Reject and the dashboard would never show why.
  turn_done       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incidents_created_at_idx ON peak.incidents (created_at DESC);
CREATE INDEX IF NOT EXISTS incidents_status_idx ON peak.incidents (status);

-- Raw TrueForge events, verbatim. This table is the audit trail: incident
-- status is always reproducible by replaying it, which is what lets us tell a
-- judge "we never wrote 'resolved' ourselves, the agent's report did".
CREATE TABLE IF NOT EXISTS peak.incident_events (
  id            bigserial PRIMARY KEY,
  incident_id   text NOT NULL REFERENCES peak.incidents (id) ON DELETE CASCADE,
  turn_id       text,
  event_id      text NOT NULL,
  type          text NOT NULL,
  payload       jsonb,
  at            timestamptz NOT NULL DEFAULT now(),
  -- (incident, turn, event) is the natural key. TrueForge caps event lists at
  -- 100 per page, so a poll can legitimately re-read events we already have.
  UNIQUE (incident_id, turn_id, event_id)
);

CREATE INDEX IF NOT EXISTS incident_events_incident_idx ON peak.incident_events (incident_id, id);

-- Who approved what, and why they refused. Small table, high narrative value:
-- it is the proof that a human was in the loop, which is the project's whole
-- safety claim.
CREATE TABLE IF NOT EXISTS peak.decisions (
  id            bigserial PRIMARY KEY,
  incident_id   text NOT NULL REFERENCES peak.incidents (id) ON DELETE CASCADE,
  decision      text NOT NULL,
  reason        text,
  actor         text NOT NULL DEFAULT 'operator',
  tool          text,
  args          jsonb,
  at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS decisions_incident_idx ON peak.decisions (incident_id, at);

-- Metric history for the before/after chart. Also the safety net: if the
-- agent's verification block comes back thin, we can still show real numbers.
CREATE TABLE IF NOT EXISTS peak.metric_samples (
  id            bigserial PRIMARY KEY,
  incident_id   text REFERENCES peak.incidents (id) ON DELETE CASCADE,
  at            timestamptz NOT NULL DEFAULT now(),
  release       text,
  rpm           double precision,
  error_rate    double precision,
  p95_ms        double precision,
  memory_mb     double precision,
  pool_in_use   integer,
  pool_waiting  integer,
  cache_entries integer,
  raw           jsonb
);

CREATE INDEX IF NOT EXISTS metric_samples_incident_idx ON peak.metric_samples (incident_id, at);
CREATE INDEX IF NOT EXISTS metric_samples_at_idx ON peak.metric_samples (at DESC);
