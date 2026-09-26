// Real TrueForge adapter — a thin wrapper over P3's client.
//
// contracts/backend-api.md says to use `agent/lib/trueforge-client.mjs` rather
// than calling TrueForge directly, and that is the right call: it already does
// model-provider fallback, which is the difference between a demo riding out a
// provider outage and a demo dying on one. So this file adds no HTTP of its own.
//
// What it does add is the read path. P3's `getReports` and `getPendingAction`
// each re-fetch the whole session event list internally, so calling both on
// every 1.5s poll would fetch it four times per tick. Here we fetch the event
// list once and only re-derive when it has actually changed.

// Path note: this file is backend/src/trueforge/real.js, so P3's modules under
// agent/ are three levels up. backend/ has no dependency on agent/ in
// package.json — these are plain ESM files with no external imports, which is
// what makes reaching across safe.
import { providersFromEnv } from '../../../agent/lib/providers.mjs';
import { createClient } from '../../../agent/lib/trueforge-client.mjs';
import { buildAgentSpec, incidentPrompt, AGENT_NAME, MCP_SERVERS } from '../../../agent/agent-spec.mjs';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { TrueforgeError } from './adapter.js';
import { extractDiagnosis, extractResolution } from '../domain/report.js';
import { pendingActionFrom } from './mapper.js';
import { pausedFrom, turnDoneFrom, turnStatusFrom } from './turns.js';

export function createRealAdapter() {
  const providers = providersFromEnv();
  const tf = createClient({
    baseUrl: config.trueforge.url,
    providers,
    log: (msg) => logger.info(`[p3-client] ${msg}`),
  });

  /** sessionId -> { paused, eventCount } so we only re-derive when events move. */
  const cache = new Map();

  /**
   * The read path. One event fetch, then derived state.
   *
   * `getPendingAction` and `getReports` are P3's functions and we use them as
   * intended — just not on a tick where nothing changed.
   */
  async function readState({ sessionId }) {
    const events = await tf.listSessionEvents(sessionId);
    const entry = cache.get(sessionId);
    const changed = !entry || entry.eventCount !== events.length;

    if (!changed) {
      return { ...entry.state, events, eventCount: events.length };
    }

    const paused = pausedFrom(events);
    let pendingAction = null;
    let diagnosis = null;
    let resolution = null;

    if (paused) {
      const actions = await tf.getPendingAction({ id: sessionId }, paused);
      pendingAction = pendingActionFrom(actions);
    }
    const reports = await tf.getReports(sessionId);
    diagnosis = extractDiagnosis(reports.diagnosis);
    resolution = extractResolution(reports.resolution);

    const state = {
      paused,
      pendingAction,
      diagnosis,
      resolution,
      turnDone: turnDoneFrom(events),
      turnStatus: turnStatusFrom(events),
    };
    cache.set(sessionId, { eventCount: events.length, state });
    return { ...state, events, eventCount: events.length };
  }

  /**
   * Run something in the background and report failures through `onError`.
   *
   * P3's client blocks for the length of a turn — up to five minutes — and
   * `tf.approve` blocks for the whole 60s verification window. Neither can sit
   * inside an HTTP handler.
   */
  function background(label, sessionId, work, onUpdate) {
    void (async () => {
      try {
        const result = await work();
        onUpdate?.({ ok: true, result });
        logger.info(`[p3-client] ${label} finished`, { sessionId, kind: result?.kind });
      } catch (err) {
        logger.error(`[p3-client] ${label} failed`, { sessionId, err: err.message });
        onUpdate?.({ ok: false, error: err.message });
      } finally {
        // Force the next read to re-derive, whatever happened.
        cache.delete(sessionId);
      }
    })();
  }

  return {
    mode: 'real',

    async ensureReady() {
      await tf.registerProviders();
      for (const server of MCP_SERVERS) {
        await tf.registerMcpServer({ name: server.name, url: server.url, description: server.description });
      }
      logger.info('registered providers and MCP servers', {
        providers: providers.map((p) => p.name),
        mcpServers: MCP_SERVERS.map((s) => s.name),
      });
    },

    async createSession({ incidentId, description }) {
      // P3 owns the AgentSpec and the prompt. The scenario tag is deliberately
      // not passed to the model — the agent has to find the cause from evidence
      // (see incidentPrompt in agent/agent-spec.mjs).
      const session = await tf.createSession(buildAgentSpec(), { incidentId });
      cache.delete(session.id);
      logger.info('session created', { sessionId: session.id, incidentId, description });
      return { sessionId: session.id, session };
    },

    startInvestigation({ session, description, onUpdate }) {
      background('investigation', session.id, () => tf.start(session, incidentPrompt({ description })), onUpdate);
    },

    submitDecision({ sessionId, decision, reason, onUpdate }) {
      background('decision', sessionId, async () => {
        // Re-attach: the process may have restarted since the incident opened.
        const session = await tf.loadSession(sessionId);
        const events = await tf.listSessionEvents(sessionId);
        const paused = pausedFrom(events);
        if (!paused) throw new Error('No tool call is waiting for approval on this session.');
        return decision === 'allow'
          ? tf.approve(session, paused)
          : tf.reject(session, paused, reason);
      }, onUpdate);
    },

    readState,

    sessionUrl(sessionId) {
      return `${config.trueforge.url}/sessions/${sessionId}`;
    },

    agentName: AGENT_NAME,
  };
}
