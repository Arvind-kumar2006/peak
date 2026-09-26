// The TrueForge seam.
//
// Every call the backend makes into P3's world goes through this interface, and
// there are exactly two implementations:
//
//   real.js — HTTP against TrueForge at TRUEFORGE_URL
//   fake.js — a scripted Scenario A / B timeline, no runtime and no API key
//
// This is the reason P4 was never actually blocked on the agent core. The
// dashboard was built and demoed end to end against `fake`, and switching to the
// real runtime is one env var. If TrueForge's event shapes turn out to differ
// from what P3 documented, the blast radius is `real.js` + `mapper.js` — two
// files, both owned by P4.
//
// Interface (all methods may reject; callers must handle it):
//
//   createSession({ incidentId, description })          -> { sessionId }
//   startTurn({ sessionId, input, previousTurnId })     -> { turnId }
//   getTurnEvents({ sessionId, turnId })                -> Array<raw event>
//   sendToolApproval({ sessionId, turnId, threadId,
//                      toolCallId, status, reason })    -> { turnId }
//   cancelSession({ sessionId })                        -> void
//   sessionUrl(sessionId)                               -> string

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
  adapter = mode === 'real' ? createRealAdapter() : createFakeAdapter();
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
