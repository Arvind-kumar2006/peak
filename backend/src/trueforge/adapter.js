// The TrueForge seam.
//
// Every call the backend makes into P3's world goes through this interface.
// `real.js` wraps P3's own client (agent/lib/trueforge-client.mjs) rather than
// hand-rolling HTTP, per contracts/backend-api.md §"Use the P3 client".
// `fake.js` is a scripted Scenario A / B timeline with no runtime and no model.
//
// ## Why the interface looks like this
//
// P3's client is *blocking*: `tf.start()` returns when the turn pauses for
// approval or finishes, and `tf.approve()` returns after the agent has verified
// recovery (60s+). That does not fit a request/response route, so:
//
//   - `startInvestigation` and `submitDecision` fire a background task and
//     return immediately. The HTTP handler responds right away.
//   - `readState` is the read path the poller uses. It is cheap, non-blocking,
//     and is the only thing the dashboard's 2s poll depends on.
//
// `readState` reconstructs the `paused` handle from the event log rather than
// holding it in memory, so a backend restart mid-incident can still approve.
//
// Interface:
//
//   ensureReady()                                        register providers + MCP
//   createSession({incidentId, description})   -> {sessionId}
//   startInvestigation({sessionId, description, onUpdate})   background
//   submitDecision({sessionId, decision, reason, onUpdate}) background
//   readState({sessionId})   -> {paused, diagnosis, resolution, pendingAction,
//                                 events, turnDone, turnStatus}
//   sessionUrl(sessionId)                        -> string

import { config, resolveTrueforgeMode } from '../config.js';
import { logger } from '../logger.js';
import { createRealAdapter } from './real.js';
import { createFakeAdapter } from './fake.js';

/** Thrown when TrueForge is reachable but unhappy, so routes can map to 502. */
export class TrueforgeError extends Error {
  constructor(message, { status, path } = {}) {
    super(message);
    this.name = 'TrueforgeError';
    this.status = status;
    this.path = path;
  }
}

let adapter = null;

/**
 * Resolve the adapter once at boot. `auto` probes TrueForge and silently picks
 * the fake when it isn't running, because "the demo doesn't start" is a far
 * worse failure than "you're running against a scripted agent".
 */
export async function getAdapter() {
  if (adapter) return adapter;
  const mode = await resolveTrueforgeMode();

  if (mode === 'real') {
    try {
      adapter = createRealAdapter();
    } catch (err) {
      // createRealAdapter throws when no model provider is configured —
      // providersFromEnv() has nothing to fall back on. That is a
      // configuration problem, not a reason for the whole backend to fail to
      // boot: fall back to the scripted agent so the dashboard still runs, and
      // say exactly what is missing.
      logger.error('cannot use the real agent runtime, falling back to the scripted fake', {
        err: err.message,
        hint: 'set MODEL_PROVIDERS and the matching API key, or start agent/mock-model.mjs and use MODEL_PROVIDERS=mock',
      });
      adapter = createFakeAdapter();
    }
  } else {
    adapter = createFakeAdapter();
  }

  if (adapter.mode === 'real') {
    // Registering providers and MCP servers is P3's client's job and is
    // idempotent, but a failure here is worth surfacing loudly: without a
    // provider the agent cannot run at all.
    try {
      await adapter.ensureReady();
    } catch (err) {
      logger.error('TrueForge setup failed — incidents will not run', { err: err.message });
    }
  }

  logger.info(`trueforge adapter ready (mode=${adapter.mode})`, {
    url: config.trueforge.url,
    agent: config.trueforge.agentName,
  });
  if (mode === 'fake' && config.trueforge.mode === 'auto') {
    logger.warn('TrueForge did not answer — using the scripted fake agent.');
    logger.warn('The full approve flow still works end to end; it is just scripted.');
  }
  return adapter;
}

/** Test seam: inject or reset the adapter. */
export function __setAdapter(next) {
  adapter = next;
}
