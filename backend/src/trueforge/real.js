// Real TrueForge adapter (v0.2.1). All shapes here come from
// contracts/trueforge.md, which P3 verified against a running instance.
//
// Everything is wrapped in `{ data: ... }` on the way out, and the event list
// `limit` is capped at 100 — both documented gotchas, both handled here so no
// other file has to know.

import { config } from '../config.js';
import { logger } from '../logger.js';
import { TrueforgeError } from './adapter.js';

const BASE = () => `${config.trueforge.url}/api/v1`;

async function api(method, path, body) {
  const url = `${BASE()}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.trueforge.requestTimeoutMs),
    });
  } catch (err) {
    // Network-level failure: TrueForge is down or restarting. Distinct from an
    // API error because the poller wants to retry rather than mark the incident
    // errored.
    throw new TrueforgeError(`TrueForge unreachable at ${url}: ${err.message}`, { path });
  }

  const text = await res.text();
  if (!res.ok) {
    throw new TrueforgeError(`TrueForge ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, {
      status: res.status,
      path,
    });
  }
  return text ? JSON.parse(text) : null;
}

export function createRealAdapter() {
  return {
    mode: 'real',

    async createSession({ incidentId, description }) {
      // P3 registers the agent by name; TRUEFORGE_AGENT_NAME makes that a config
      // change rather than a code change if the name differs.
      const { data } = await api('POST', '/sessions', {
        agent: { name: config.trueforge.agentName },
        metadata: { incidentId },
      });
      logger.info('session created', { sessionId: data.id, incidentId, description });
      return { sessionId: data.id };
    },

    async startTurn({ sessionId, input, previousTurnId }) {
      const payload = { stream: false, input };
      if (previousTurnId) payload.previous_turn_id = previousTurnId;
      const { data } = await api('POST', `/sessions/${sessionId}/turns`, payload);
      return { turnId: data.id };
    },

    /**
     * Fetch a turn's events, paging past the 100-event cap.
     *
     * A full investigation comfortably exceeds 100 events. Trusting a single
     * page would silently truncate the evidence trail — and the tail is exactly
     * where the approval request and the final report live, so we would look
     * broken precisely when the demo matters most.
     *
     * The cursor shape is undocumented, so we page by offset and stop as soon as
     * a page yields no ids we haven't already seen. If `offset` is ignored, we
     * detect the repeat instead of looping forever.
     */
    async getTurnEvents({ sessionId, turnId }) {
      const size = config.trueforge.eventPageSize;
      const seen = new Set();
      const events = [];

      for (let offset = 0; offset < 2000; offset += size) {
        const sep = offset === 0 ? '?' : '&';
        const { data } = await api(
          'GET',
          `/sessions/${sessionId}/turns/${turnId}/events?limit=${size}${sep}offset=${offset}`,
        );
        const page = Array.isArray(data) ? data : [];
        if (page.length === 0) break;

        let fresh = 0;
        for (const event of page) {
          const key = event?.id ?? JSON.stringify(event);
          if (seen.has(key)) continue;
          seen.add(key);
          events.push(event);
          fresh++;
        }
        // No new ids => the offset parameter isn't doing anything. Stop rather
        // than spin.
        if (fresh === 0) break;
        if (page.length < size) break;
      }

      logger.debug('fetched turn events', { sessionId, turnId, count: events.length });
      return events;
    },

    async sendToolApproval({ sessionId, turnId, threadId, toolCallId, status, reason }) {
      const approval =
        status === 'allow' ? { status: 'allow' } : { status: 'deny', reason: reason || 'Rejected by operator' };
      const input = [
        {
          type: 'user.tool_approval',
          thread_id: threadId,
          tool_call_id: toolCallId,
          approval,
        },
      ];
      // Chained to the paused turn — that is how TrueForge resumes a turn that
      // stopped on the approval gate.
      return this.startTurn({ sessionId, input, previousTurnId: turnId });
    },

    async cancelSession({ sessionId }) {
      try {
        await api('POST', `/sessions/${sessionId}/cancel`, {});
      } catch (err) {
        logger.warn('cancel failed (ignoring)', { sessionId, err: err.message });
      }
    },

    sessionUrl(sessionId) {
      return `${config.trueforge.url}/sessions/${sessionId}`;
    },
  };
}
