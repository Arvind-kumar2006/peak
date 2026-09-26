// Scripted TrueForge stand-in.
//
// This is not a stub. It emits events in the *same shapes* the real runtime
// produces (verified against contracts/trueforge.md), so `mapper.js`, the report
// parser, the status state machine and the entire dashboard all run their real
// code paths. The only thing missing is a language model.
//
// That means: the full demo — trigger, investigate, pause on approval, approve,
// watch it recover, report resolved — works end to end before P3's agent exists,
// and without spending a token.
//
// Timings are tuned for a human watching: ~11s of investigation before the
// approval card appears is long enough to read, short enough not to bore.
// FAKE_SPEED compresses or stretches that: 3 is three times faster (handy for
// tests and for squeezing a rehearsal), 0.5 is half speed.

import { config } from '../config.js';
import { logger } from '../logger.js';

const SPEED = Number(process.env.FAKE_SPEED ?? 1) || 1;
const el = (seconds) => Math.round(seconds * 1000 / SPEED);

let sessionSeq = 0;
let turnSeq = 0;

/** Per-scenario script: the read tools, the proposed write, and the report. */
const SCRIPTS = {
  'conn-leak': {
    release: 'a80e0f0',
    reads: [
      ['get_service_status', {}, { status: 'down', release: 'a80e0f0', uptimeSec: 742, instance: 'web-1' }],
      [
        'get_metrics',
        {},
        { http: { rpm: 238, errorRate: 0.42, p95Ms: 3812 }, db: { pool: { max: 10, inUse: 10, idle: 0, waiting: 34 } } },
      ],
      [
        'get_pool_stats',
        {},
        { max: 10, inUse: 10, idle: 0, waiting: 34, idleInTransaction: 9, acquiredTotal: 4120, source: 'demo-app' },
      ],
      [
        'list_recent_commits',
        { since: '30m' },
        { commits: [{ sha: 'a80e0f0', message: 'perf: reuse client for order lookup', author: 'praveen', ageMin: 12 }] },
      ],
      [
        'get_recent_errors',
        { windowSec: 900 },
        {
          errors: [
            {
              type: 'TimeoutError',
              message: 'pool exhausted (10/10) after 2000ms',
              count: 187,
              release: 'a80e0f0',
              firstSeen: '12m ago',
            },
          ],
        },
      ],
    ],
    proposal: {
      tool: 'trigger_rollback',
      args: { toDeployId: 'dep-8f2a1c9', reason: 'Commit a80e0f0 leaks pool clients in GET /orders; pool is 10/10 with 34 waiters.' },
    },
    executeResult: { ok: true, deployId: 'dep-8f2a1c9', previousRelease: '5c1d0ab', rollbackSec: 41 },
    verifyTool: 'get_metrics_window',
    verifyResult: {
      windowSec: 60,
      before: { errorRate: 0.42, p95Ms: 3812, poolInUse: 10, poolWaiting: 34 },
      after: { errorRate: 0.002, p95Ms: 118, poolInUse: 2, poolWaiting: 0 },
      samples: 30,
    },
    report: (phase) => ({
      phase,
      summary:
        phase === 'resolved'
          ? 'Rolled back commit a80e0f0, which leaked Postgres clients in GET /orders. Error rate and pool saturation returned to baseline over a 60s window.'
          : 'Commit a80e0f0 leaks Postgres clients in GET /orders, saturating the 10-connection pool.',
      rootCause: {
        category: 'code',
        description:
          'GET /orders acquires a pool client and returns without releasing it on the cached-order path, so each request leaks one connection until the pool is exhausted.',
        confidence: 0.93,
        commitSha: 'a80e0f0',
      },
      evidence: [
        { claim: 'The service is failing, not merely slow.', tool: 'cloud.get_service_status', observation: 'status=down, uptime 742s, error rate 0.42' },
        { claim: 'The database pool is fully saturated with waiters.', tool: 'db.get_pool_stats', observation: 'inUse 10/10, idle 0, waiting 34, 9 connections idle-in-transaction' },
        { claim: 'A deploy 12 minutes ago matches the onset.', tool: 'github.list_recent_commits', observation: 'a80e0f0 "perf: reuse client for order lookup"' },
        { claim: 'Errors are tagged with that deploy.', tool: 'cloud.get_recent_errors', observation: '187x TimeoutError "pool exhausted (10/10)" on release a80e0f0' },
      ],
      proposedFix: {
        action: 'trigger_rollback',
        args: { toDeployId: 'dep-8f2a1c9' },
        reasoning:
          'The regression arrived with a80e0f0 and the pool leak is code-level, so reverting the deploy removes the cause. Restarting would only drain the pool temporarily; the leak returns on the next request.',
        diff: null,
      },
      verification:
        phase === 'resolved'
          ? {
              windowSec: 60,
              before: { errorRate: 0.42, p95Ms: 3812, poolInUse: 10, poolWaiting: 34 },
              after: { errorRate: 0.002, p95Ms: 118, poolInUse: 2, poolWaiting: 0 },
              verdict: 'Stable for the full 60s window: pool 2/10, no waiters, error rate 0.2%. Resolved.',
            }
          : null,
    }),
  },

  'mem-leak': {
    release: '5c1d0ab',
    reads: [
      ['get_service_status', {}, { status: 'degraded', release: '5c1d0ab', uptimeSec: 3604, restartCount: 1 }],
      [
        'get_metrics',
        {},
        { http: { rpm: 241, errorRate: 0.011, p95Ms: 2410 }, process: { memoryMB: 402, memoryLimitMB: 512 }, cache: { entries: 48210 } },
      ],
      [
        'get_metrics_window',
        { windowSec: 300 },
        { trend: 'memory rising steadily', from: { memoryMB: 180 }, to: { memoryMB: 402 }, slopeMBPerMin: 44 },
      ],
      // The decisive signal: nothing was deployed, so this is not a code change.
      ['list_recent_commits', { since: '6h' }, { commits: [] }],
      ['get_pool_stats', {}, { max: 10, inUse: 3, idle: 7, waiting: 0, source: 'demo-app' }],
    ],
    proposal: {
      tool: 'clear_cache',
      args: { reason: 'In-process cache grew unbounded to 48k entries (402MB of a 512MB limit) with no deploy in the window.' },
    },
    executeResult: { cleared: 48210, stoppedGrowth: true },
    verifyTool: 'get_metrics_window',
    verifyResult: {
      windowSec: 60,
      before: { memoryMB: 402, p95Ms: 2410, cacheEntries: 48210 },
      after: { memoryMB: 168, p95Ms: 126, cacheEntries: 12 },
      samples: 30,
    },
    report: (phase) => ({
      phase,
      summary:
        phase === 'resolved'
          ? 'Cleared an unbounded in-process cache holding 48k entries. Memory fell from 402MB to 168MB and stayed flat over 60s.'
          : 'Unbounded in-process cache growth is consuming the instance; there is no recent deploy.',
      rootCause: {
        category: 'infra',
        description:
          'A cache-fill path adds entries with no eviction or size bound. No commit landed in the incident window, so this is runtime/infra behaviour rather than a code regression.',
        confidence: 0.9,
        commitSha: null,
      },
      evidence: [
        { claim: 'Memory is near the instance limit.', tool: 'cloud.get_metrics', observation: 'memoryMB 402 of 512 limit, cache.entries 48210' },
        { claim: 'Memory is climbing, not spiking.', tool: 'cloud.get_metrics_window', observation: '180MB → 402MB over 300s, +44MB/min, no step change' },
        { claim: 'This is not a deploy regression.', tool: 'github.list_recent_commits', observation: 'no commits in the last 6 hours' },
        { claim: 'The database is healthy, ruling out Scenario A.', tool: 'db.get_pool_stats', observation: 'inUse 3/10, waiting 0' },
      ],
      proposedFix: {
        action: 'clear_cache',
        args: {},
        reasoning:
          'The growth is the cache itself, so clearing it removes the cause and stops the runaway fill. Rolling back is not an option — there is no bad deploy to revert.',
        diff: null,
      },
      verification:
        phase === 'resolved'
          ? {
              windowSec: 60,
              before: { memoryMB: 402, p95Ms: 2410, cacheEntries: 48210 },
              after: { memoryMB: 168, p95Ms: 126, cacheEntries: 12 },
              verdict: 'Memory at 33% of limit and flat across 30 samples over 60s. p95 back to 126ms. Resolved.',
            }
          : null,
    }),
  },
};

/** A generic alert with no scenario hint — used when nothing is injected. */
const GENERIC = {
  reads: [
    ['get_service_status', {}, { status: 'degraded', release: 'unknown', uptimeSec: 900 }],
    ['get_metrics', {}, { http: { rpm: 200, errorRate: 0.08, p95Ms: 900 } }],
  ],
  proposal: { tool: 'restart_service', args: { reason: 'Service degraded with no further diagnosis available.' } },
  executeResult: { ok: true, restarted: true },
  verifyTool: 'get_metrics_window',
  verifyResult: { windowSec: 60, before: { errorRate: 0.08 }, after: { errorRate: 0.01 } },
  report: (phase) => ({
    phase,
    summary: 'Service was degraded; restarted and metrics improved.',
    rootCause: { category: 'unknown', description: 'Insufficient evidence to attribute a cause.', confidence: 0.3, commitSha: null },
    evidence: [{ claim: 'Service reported degraded.', tool: 'cloud.get_service_status', observation: 'status=degraded' }],
    proposedFix: { action: 'restart_service', args: {}, reasoning: 'No better-supported action available from the evidence gathered.', diff: null },
    verification: phase === 'resolved' ? { windowSec: 60, before: { errorRate: 0.08 }, after: { errorRate: 0.01 }, verdict: 'Improved.' } : null,
  }),
};

const SCRIPT_FOR = (scenario) => SCRIPTS[scenario] ?? GENERIC;

let msgSeq = 0;
const msg = () => `e_msg_${++msgSeq}`;
const call = () => `call_${++msgSeq}`;

/** A model.message that requests a tool. This is what `source_event_id` points at. */
function toolCallMessage(id, name, args) {
  return {
    id,
    type: 'model.message',
    thread_id: 'main',
    content: null,
    tool_calls: [{ id: call(), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

function withCallId(message, callId) {
  message.tool_calls[0].id = callId;
  return message;
}

function resultEvent(name, payload) {
  return { id: msg(), type: 'tool.result', thread_id: 'main', name, content: JSON.stringify(payload) };
}

function textMessage(content) {
  return { id: msg(), type: 'model.message', thread_id: 'main', content, finish_reason: 'stop' };
}

/** Investigation turn: read tools, then pause on the approval gate. */
function investigationTimeline(script) {
  const events = [];
  const push = (at, ev) => events.push({ at: el(at), ev });

  push(0.2, textMessage('Starting incident investigation. Gathering service, pool, deploy and error signals.'));

  let t = 1.6;
  for (const [name, args, result] of script.reads) {
    const callId = call();
    push(t, withCallId(toolCallMessage(msg(), name, args), callId));
    push(t + 0.6, resultEvent(name, result));
    t += 1.7;
  }

  const writeCallId = call();
  const proposalMessage = withCallId(toolCallMessage(msg(), script.proposal.tool, script.proposal.args), writeCallId);
  push(t, proposalMessage);
  push(
    t + 0.9,
    {
      id: msg(),
      type: 'tool.approval_required',
      thread_id: 'main',
      tool_calls: [{ id: writeCallId, source_event_id: proposalMessage.id }],
    },
  );
  return events;
}

/** Resume turn after approval: the tool runs, then the agent verifies. */
function allowTimeline(script) {
  const events = [];
  const push = (at, ev) => events.push({ at: el(at), ev });
  const report = script.report('resolved');

  push(0.2, resultEvent(script.proposal.tool, script.executeResult));

  const verifyCallId = call();
  push(1.8, withCallId(toolCallMessage(msg(), script.verifyTool, { windowSec: 60 }), verifyCallId));
  push(2.4, resultEvent(script.verifyTool, script.verifyResult));
  push(4.0, textMessage(JSON.stringify(report)));
  push(4.4, {
    id: msg(),
    type: 'turn.done',
    thread_id: 'main',
    state: {
      status: 'done',
      // Verified shape (contracts/trueforge.md): the final model.message.
      output: { type: 'model.message', content: JSON.stringify(report), thread_id: 'main', finish_reason: 'stop' },
    },
  });
  return events;
}

/** Resume turn after rejection: the agent is told no and wraps up. */
function denyTimeline(script, reason) {
  const events = [];
  const push = (at, ev) => events.push({ at: el(at), ev });
  const report = script.report('rejected');
  report.summary = `Operator rejected ${script.proposal.tool}. ${report.summary}`;
  report.proposedFix.reasoning = `Rejected by the operator: ${reason || 'no reason given'}. ${report.proposedFix.reasoning}`;

  push(0.2, resultEvent(script.proposal.tool, { error: `User denied tool call: ${reason || 'no reason given'}` }));
  push(1.6, textMessage(JSON.stringify(report)));
  push(2.0, {
    id: msg(),
    type: 'turn.done',
    thread_id: 'main',
    state: {
      status: 'done',
      output: { type: 'model.message', content: JSON.stringify(report), thread_id: 'main', finish_reason: 'stop' },
    },
  });
  return events;
}

export function createFakeAdapter() {
  /** sessionId -> { id, incidentId, scenario, turns: [{ id, kind, startedAt, timeline, decision }] } */
  const sessions = new Map();

  return {
    mode: 'fake',

    async createSession({ incidentId, description }) {
      const id = `sess_fake_${String(++sessionSeq).padStart(4, '0')}`;
      // The scenario is inferred from the investigation prompt so the scripted
      // timeline matches whatever the user clicked. Not a real agent — just
      // enough to make "Simulate incident A" show incident A.
      const script = SCRIPT_FOR(
        /conn-leak/.test(description ?? '') ? 'conn-leak' : /mem-leak/.test(description ?? '') ? 'mem-leak' : null,
      );
      sessions.set(id, { id, incidentId, description, script, turns: [] });
      logger.info('[fake] session created', { sessionId: id, incidentId });
      return { sessionId: id };
    },

    async startTurn({ sessionId, input, previousTurnId }) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`[fake] unknown session ${sessionId}`);

      const isApproval =
        Array.isArray(input) && input.some((i) => i?.type === 'user.tool_approval');
      const approval = isApproval ? input.find((i) => i.type === 'user.tool_approval') : null;

      let timeline;
      let kind;
      if (isApproval) {
        const allowed = approval.approval?.status === 'allow';
        timeline = allowed
          ? allowTimeline(session.script)
          : denyTimeline(session.script, approval.approval?.reason);
        kind = allowed ? 'execute' : 'reject';
      } else {
        timeline = investigationTimeline(session.script);
        kind = 'investigate';
      }

      const turn = {
        id: `turn_fake_${String(++turnSeq).padStart(4, '0')}`,
        kind,
        startedAt: Date.now(),
        timeline,
        previousTurnId: previousTurnId ?? null,
        decision: approval ? approval.approval?.status : null,
      };
      session.turns.push(turn);
      logger.info('[fake] turn started', { sessionId, turnId: turn.id, kind });
      return { turnId: turn.id };
    },

    async getTurnEvents({ sessionId, turnId }) {
      const session = sessions.get(sessionId);
      const turn = session?.turns.find((t) => t.id === turnId);
      if (!turn) throw new Error(`[fake] unknown turn ${turnId}`);
      const elapsed = Date.now() - turn.startedAt;
      return turn.timeline.filter((step) => step.at <= elapsed).map((step) => step.ev);
    },

    async sendToolApproval(args) {
      logger.info('[fake] approval received', { tool: 'n/a', status: args.status });
      return this.startTurn({
        sessionId: args.sessionId,
        input: [
          {
            type: 'user.tool_approval',
            thread_id: args.threadId,
            tool_call_id: args.toolCallId,
            approval: args.status === 'allow' ? { status: 'allow' } : { status: 'deny', reason: args.reason },
          },
        ],
        previousTurnId: args.turnId,
      });
    },

    async cancelSession({ sessionId }) {
      sessions.delete(sessionId);
    },

    sessionUrl(sessionId) {
      return `${config.trueforge.url}/sessions/${sessionId}`;
    },
  };
}
