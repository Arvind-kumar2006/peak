// Postgres (Neon) store.
//
// Used automatically when PEAK_DATABASE_URL or DATABASE_URL is set. Falls back
// to memory.js otherwise, so the demo always starts.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(here, 'schema.sql'), 'utf8');

export function createPgStore() {
  const pool = new pg.Pool({
    connectionString: config.store.url,
    // Neon terminates TLS with a certificate chain that doesn't validate against
    // the default Node trust store in every environment. This is the documented
    // Neon + node-postgres recipe.
    ssl: config.store.url.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8000,
  });

  // A pool-level error handler is required: without one, an idle client dropped
  // by Neon emits an unhandled 'error' event and takes the process down. On
  // stage that is the difference between a flaky chart and a dead backend.
  pool.on('error', (err) => logger.error('idle postgres client error', { err: err.message }));

  const q = (text, params) => pool.query(text, params);

  return {
    kind: 'pg',

    async init() {
      await q(SCHEMA_SQL);
      const { rows } = await q('select current_database() as db, version() as version');
      logger.info('postgres store ready', {
        database: rows[0].db,
        // Neon reports "Neon ... (some version)". Truncated: nobody needs the rest.
        server: String(rows[0].version).slice(0, 40),
      });
    },

    async createIncident(row) {
      const { rows } = await q(
        `insert into peak.incidents
           (id, session_id, turn_ids, last_turn_id, scenario, description, status, trueforge_url)
         values ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)
         returning *`,
        [row.id, row.sessionId ?? null, JSON.stringify(row.turnIds ?? []), row.lastTurnId ?? null,
         row.scenario ?? null, row.description ?? null, row.status, row.trueforgeUrl ?? null],
      );
      return rows[0];
    },

    async getIncident(id) {
      const { rows } = await q('select * from peak.incidents where id = $1', [id]);
      return rows[0] ?? null;
    },

    async listIncidents({ limit = 50 } = {}) {
      const { rows } = await q('select * from peak.incidents order by created_at desc limit $1', [limit]);
      return rows;
    },

    async updateIncident(id, patch) {
      // Whitelist rather than interpolating keys: this is the one place a
      // caller-supplied object could otherwise become SQL. The type is declared
      // per column because jsonb columns need an explicit cast from a text
      // parameter and casting a plain word like 'investigating' to jsonb would
      // throw at runtime.
      const columns = {
        status: ['status', 'text'],
        report: ['report', 'jsonb'],
        pendingAction: ['pending_action', 'jsonb'],
        decision: ['decision', 'text'],
        error: ['error', 'text'],
        lastTurnId: ['last_turn_id', 'text'],
        lastEventAt: ['last_event_at', 'timestamptz'],
        stalled: ['stalled', 'boolean'],
        turnDone: ['turn_done', 'boolean'],
        turnIds: ['turn_ids', 'jsonb'],
      };
      const sets = [];
      const values = [id];
      for (const [key, [column, type]] of Object.entries(columns)) {
        if (!(key in patch)) continue;
        const value = type === 'jsonb' ? JSON.stringify(patch[key] ?? null) : patch[key];
        values.push(value);
        sets.push(`${column} = $${values.length}::${type}`);
      }
      if (!sets.length) return this.getIncident(id);
      sets.push('updated_at = now()');

      const { rows } = await q(
        `update peak.incidents set ${sets.join(', ')} where id = $1 returning *`,
        values,
      );
      return rows[0] ?? null;
    },

    /**
     * Append events, ignoring ones we already have.
     * `on conflict do nothing` is what makes re-polling a turn safe: TrueForge
     * caps pages at 100, so we re-read the same events on every poll by design.
     */
    async appendEvents(incidentId, turnId, events) {
      if (!events.length) return 0;
      const values = [];
      const tuples = events.map((e, i) => {
        const base = values.length;
        values.push(incidentId, turnId, e.eventId, e.type, JSON.stringify(e.payload ?? null), e.at);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5}::jsonb,$${base + 6})`;
      });
      const { rowCount } = await q(
        `insert into peak.incident_events (incident_id, turn_id, event_id, type, payload, at)
         values ${tuples.join(',')}
         on conflict (incident_id, turn_id, event_id) do nothing`,
        values,
      );
      return rowCount ?? 0;
    },

    async listEvents(incidentId, { limit = 200, turnId } = {}) {
      const { rows } = await q(
        `select * from peak.incident_events
         where incident_id = $1 ${turnId ? 'and turn_id = $3' : ''}
         order by id asc limit $2`,
        turnId ? [incidentId, limit, turnId] : [incidentId, limit],
      );
      return rows;
    },

    async recordDecision(row) {
      const { rows } = await q(
        `insert into peak.decisions (incident_id, decision, reason, actor, tool, args)
         values ($1,$2,$3,$4,$5,$6::jsonb) returning *`,
        [row.incidentId, row.decision, row.reason ?? null, row.actor ?? 'operator',
         row.tool ?? null, JSON.stringify(row.args ?? {})],
      );
      return rows[0];
    },

    async listDecisions(incidentId) {
      const { rows } = await q('select * from peak.decisions where incident_id = $1 order by at asc', [incidentId]);
      return rows;
    },

    async addSample(row) {
      await q(
        `insert into peak.metric_samples
           (incident_id, at, release, rpm, error_rate, p95_ms, memory_mb, pool_in_use, pool_waiting, cache_entries, raw)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [row.incidentId ?? null, row.at ?? new Date(), row.release ?? null, row.rpm ?? null,
         row.errorRate ?? null, row.p95Ms ?? null, row.memoryMB ?? null, row.poolInUse ?? null,
         row.poolWaiting ?? null, row.cacheEntries ?? null, JSON.stringify(row.raw ?? null)],
      );
    },

    async listSamples({ incidentId, since, limit = 500 } = {}) {
      const { rows } = await q(
        `select * from peak.metric_samples
         where ($1::text is null or incident_id = $1)
           and ($2::timestamptz is null or at >= $2)
         order by at asc limit $3`,
        [incidentId ?? null, since ?? null, limit],
      );
      return rows;
    },

    async latestSample() {
      const { rows } = await q('select * from peak.metric_samples order by at desc limit 1');
      return rows[0] ?? null;
    },

    /** Trim history so a long rehearsal doesn't grow unbounded. */
    async prune({ keepSamples = 20000 } = {}) {
      const { rowCount } = await q(
        `delete from peak.metric_samples where id not in (select id from peak.metric_samples order by at desc limit $1)`,
        [keepSamples],
      );
      if (rowCount) logger.info('pruned old metric samples', { removed: rowCount });
    },

    async close() {
      await pool.end();
    },
  };
}
