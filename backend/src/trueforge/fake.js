// Scripted TrueForge stand-in.
//
// This is not a stub. It emits the same event shapes P3's client reads —
// `model.message` carrying `tool_calls`, `tool.response` keyed by
// `tool_call_id`, `tool.approval_required`, `turn.done` — and it submits its
// reports through `submit_diagnosis` / `submit_resolution` on report-mcp, which
// is how the real agent reports under the current schema.
//
// So the mapper, the report parsers, the status state machine and the whole
// dashboard all run their real code paths. The only thing missing is a language
// model.
//
// That means the full demo — trigger, investigate, pause on approval, approve,
// verify, submit a resolution — works end to end before P3's agent exists, and
// without spending a token.
//
// Timings are tuned for a human watching: ~11s of investigation before the
// approval card appears is long enough to read, short enough not to bore.
// FAKE_SPEED compresses or stretches that: 3 is three times faster (handy for
// tests and for squeezing a rehearsal), 0.5 is half speed.

import { config } from '../config.js';
import { logger } from '../logger.js';

const SPEED = Number(process.env.FAKE_SPEED ?? 1) || 1;
const el = (seconds) => Math.round((seconds * 1000) / SPEED);

let sessionSeq = 0;
let turnSeq = 0;
let msgSeq = 0;

const nextId = (prefix) => `${prefix}_${++msgSeq}`;

/**
 * Per-scenario script.
 *
 * Shaped to the current schema: a Diagnosis (with `ruledOut`, `expectedOutcome`
 * and `before`) submitted before the write tool is attempted, and a Resolution
 * (with `verdict`, `actionTaken`, `after` and `followUp`) submitted after the
 * agent has watched the recovery window.
 */
const SCRIPTS = {
  'conn-leak': {
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
    diagnosis: {
      summary:
        'A commit deployed 12 minutes ago leaks Postgres clients in GET /orders. The pool is 10/10 with 34 waiters and 42% of requests are failing.',
      rootCause: {
        category: 'code',
        description:
          'GET /orders acquires a pool client and returns without releasing it on the cached-order path, so every request leaks one connection until the pool is exhausted.',
        confidence: 0.93,
        commitSha: 'a80e0f0',
      },
      evidence: [
        { claim: 'The service is failing, not merely slow.', tool: 'cloud.get_service_status', observation: 'status=down, uptime 742s, error rate 0.42' },
        { claim: 'The database pool is saturated with waiters.', tool: 'db.get_pool_stats', observation: 'inUse 10/10, idle 0, waiting 34, 9 connections idle-in-transaction' },
        { claim: 'A deploy 12 minutes ago matches the onset.', tool: 'github.list_recent_commits', observation: 'a80e0f0 "perf: reuse client for order lookup"' },
        { claim: 'Errors are tagged with that deploy.', tool: 'cloud.get_recent_errors', observation: '187x TimeoutError "pool exhausted (10/10)" on release a80e0f0' },
      ],
      // The field that makes the diagnosis convincing: it says what it threw away.
      ruledOut: [
        'Not a database fault: the pool is saturated by application connections, not by slow queries (get_slow_queries is clean).',
        'Not traffic-driven: rpm has been flat at ~238 for the last 30 minutes.',
        'Not a lock contention problem: get_lock_waits returned nothing.',
      ],
      proposedFix: {
        action: 'trigger_rollback',
        args: { toDeployId: 'dep-8f2a1c9' },
        reasoning:
          'The regression arrived with a80e0f0 and the leak is code-level, so reverting the deploy removes the cause.',
        expectedOutcome: 'resolves',
      },
      before: { errorRate: 0.42, p95Ms: 3812, poolInUse: 10, poolWaiting: 34, release: 'a80e0f0' },
    },
    writeTool: 'trigger_rollback',
    writeArgs: { toDeployId: 'dep-8f2a1c9', reason: 'Commit a80e0f0 leaks pool clients in GET /orders; pool is 10/10 with 34 waiters.' },
    writeResult: { ok: true, deployId: 'dep-8f2a1c9', previousRelease: '5c1d0ab', rollbackSec: 41 },
    verifyTool: 'get_metrics_window',
    verifyArgs: { windowSec: 60 },
    verifyResult: {
      windowSec: 60,
      before: { errorRate: 0.42, p95Ms: 3812, poolInUse: 10, poolWaiting: 34 },
      after: { errorRate: 0.002, p95Ms: 118, poolInUse: 2, poolWaiting: 0 },
      samples: 30,
    },
    resolution: {
      verdict: 'resolved',
      actionTaken: 'trigger_rollback',
      windowSec: 60,
      before: { errorRate: 0.42, p95Ms: 3812, poolInUse: 10, poolWaiting: 34, release: 'a80e0f0' },
      after: { errorRate: 0.002, p95Ms: 118, poolInUse: 2, poolWaiting: 0, release: '5c1d0ab' },
      reasoning:
        'Rolled back to 5c1d0ab. Pool fell from 10/10 to 2/10 with no waiters and error rate from 42% to 0.2%, stable across 30 samples in the 60s window. The leak is gone with the commit that caused it.',
      followUp:
        'Add client.release() in a finally block on the cached-order path and open a PR so the next deploy of this branch is safe.',
    },
  },

  'mem-leak': {
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
    diagnosis: {
      summary:
        'Memory has climbed to 402MB of a 512MB limit over 30 minutes with no deploy in the window. The in-process cache holds 48k entries; the database is healthy.',
      rootCause: {
        category: 'infra',
        description:
          'A cache-fill path adds entries with no eviction or size bound. No commit landed in the incident window, so this is runtime behaviour rather than a code regression.',
        confidence: 0.9,
        commitSha: null,
      },
      evidence: [
        { claim: 'Memory is near the instance limit.', tool: 'cloud.get_metrics', observation: 'memoryMB 402 of 512 limit, cache.entries 48210' },
        { claim: 'Memory is climbing, not spiking.', tool: 'cloud.get_metrics_window', observation: '180MB → 402MB over 300s, +44MB/min, no step change' },
        { claim: 'This is not a deploy regression.', tool: 'github.list_recent_commits', observation: 'no commits in the last 6 hours' },
        { claim: 'The database is healthy, ruling out a connection leak.', tool: 'db.get_pool_stats', observation: 'inUse 3/10, waiting 0' },
      ],
      ruledOut: [
        'Not a connection leak: pool is 3/10 with no waiters, so Scenario A is ruled out.',
        'Not a traffic spike: rpm is flat at ~241 and memory climbs independently of it.',
        'Not a bad deploy: no commits in the last 6 hours, so there is nothing to roll back to.',
      ],
      proposedFix: {
        action: 'clear_cache',
        args: {},
        reasoning: 'The growth is the cache itself, so clearing it removes the cause and stops the runaway fill.',
        expectedOutcome: 'resolves',
      },
      before: { memoryMB: 402, p95Ms: 2410, cacheEntries: 48210, release: '5c1d0ab' },
    },
    writeTool: 'clear_cache',
    writeArgs: { reason: 'In-process cache grew unbounded to 48k entries (402MB of a 512MB limit) with no deploy in the window.' },
    writeResult: { cleared: 48210, stoppedGrowth: true },
    verifyTool: 'get_metrics_window',
    verifyArgs: { windowSec: 60 },
    verifyResult: {
      windowSec: 60,
      before: { memoryMB: 402, p95Ms: 2410, cacheEntries: 48210 },
      after: { memoryMB: 168, p95Ms: 126, cacheEntries: 12 },
      samples: 30,
    },
    resolution: {
      verdict: 'resolved',
      actionTaken: 'clear_cache',
      windowSec: 60,
      before: { memoryMB: 402, p95Ms: 2410, cacheEntries: 48210, release: '5c1d0ab' },
      after: { memoryMB: 168, p95Ms: 126, cacheEntries: 12, release: '5c1d0ab' },
      reasoning:
        'Cleared 48,210 cache entries. Memory fell from 402MB to 168MB (33% of limit) and stayed flat across 30 samples; p95 returned to 126ms. Recovery is stable, not a one-sample blip.',
      followUp:
        'Put a max-entries eviction policy on the cache-fill job so this cannot regrow, and alert at 70% of the instance memory limit.',
    },
  },
};

/** No scenario injected — the agent triages whatever it can see. */
const GENERIC = {
  reads: [
    ['get_service_status', {}, { status: 'degraded', release: 'unknown', uptimeSec: 900 }],
    ['get_metrics', {}, { http: { rpm: 200, errorRate: 0.08, p95Ms: 900 } }],
  ],
  diagnosis: {
    summary: 'Service is degraded, but the evidence gathered does not identify a cause.',
    rootCause: {
      category: 'unknown',
      description: 'Insufficient evidence to attribute a cause. No deploy, pool or error signal stands out.',
      confidence: 0.3,
      commitSha: null,
    },
    evidence: [{ claim: 'Service reported degraded.', tool: 'cloud.get_service_status', observation: 'status=degraded' }],
    ruledOut: ['No recent deploy, and the connection pool is not saturated.'],
    proposedFix: {
      action: 'restart_service',
      args: {},
      reasoning: 'No better-supported action is available from the evidence gathered.',
      expectedOutcome: 'mitigates',
    },
    before: { errorRate: 0.08, p95Ms: 900 },
  },
  writeTool: 'restart_service',
  writeArgs: { reason: 'Service degraded with no better-supported action available.' },
  writeResult: { ok: true, restarted: true },
  verifyTool: 'get_metrics_window',
  verifyArgs: { windowSec: 60 },
  verifyResult: { windowSec: 60, before: { errorRate: 0.08, p95Ms: 900 }, after: { errorRate: 0.01, p95Ms: 140 } },
  resolution: {
    verdict: 'mitigated',
    actionTaken: 'restart_service',
    windowSec: 60,
    before: { errorRate: 0.08, p95Ms: 900 },
    after: { errorRate: 0.01, p95Ms: 140 },
    reasoning:
      'Metrics improved after the restart, but no cause was identified, so this is mitigated rather than resolved.',
    followUp: 'Re-run the investigation with a longer window and Sentry errors enabled.',
  },
};

const SCRIPT_FOR = (scenario) => SCRIPTS[scenario] ?? GENERIC;

/** A model.message requesting a tool — the shape `listToolCalls` reads. */
function toolCallMessage(tool, args) {
  const id = nextId('call');
  return {
    id: nextId('msg'),
    type: 'model.message',
    thread_id: 'main',
    created_at: new Date().toISOString(),
    content: null,
    tool_calls: [
      { id, type: 'function', function: { name: tool, arguments: JSON.stringify(args) }, tool_info: { server_name: serverFor(tool) } },
    ],
  };
}

/** Which MCP server a tool lives on. Purely so the fake mirrors reality. */
function serverFor(tool) {
  if (/pool|query|lock/i.test(tool)) return 'db-mcp';
  if (/commit|diff|rollback/i.test(tool)) return 'github-mcp';
  if (/^submit_/.test(tool)) return 'report-mcp';
  return 'cloud-mcp';
}

function toolResponse(callMessage, payload) {
  return {
    id: nextId('msg'),
    type: 'tool.response',
    thread_id: 'main',
    created_at: new Date().toISOString(),
    tool_call_id: callMessage.tool_calls[0].id,
    name: callMessage.tool_calls[0].function.name,
    content: JSON.stringify(payload),
  };
}

function textMessage(content) {
  return {
    id: nextId('msg'),
    type: 'model.message',
    thread_id: 'main',
    created_at: new Date().toISOString(),
    content,
    finish_reason: 'stop',
  };
}

/**
 * Investigation turn: read tools, submit the diagnosis, then hit the gate.
 *
 * The order matters and mirrors the real agent: report first, *then* attempt the
 * write tool. That is why the dashboard can show a full diagnosis next to the
 * Approve button — the human approves a specific argument, not a vague request.
 */
function investigationTimeline(script) {
  const events = [];
  const push = (at, ev) => events.push({ at: el(at), ev });

  push(0.2, textMessage('Starting incident investigation. Gathering service, pool, deploy and error signals.'));

  let t = 1.6;
  for (const [name, args, result] of script.reads) {
    const call = toolCallMessage(name, args);
    push(t, call);
    push(t + 0.6, toolResponse(call, result));
    t += 1.7;
  }

  // submit_diagnosis — recorded, not gated.
  const submit = toolCallMessage('submit_diagnosis', script.diagnosis);
  push(t, submit);
  push(t + 0.5, toolResponse(submit, { recorded: true, kind: 'diagnosis' }));

  // The write tool: this one trips the approval gate.
  const write = toolCallMessage(script.writeTool, script.writeArgs);
  push(t + 1.0, write);
  push(t + 1.9, {
    id: nextId('msg'),
    type: 'tool.approval_required',
    thread_id: 'main',
    created_at: new Date().toISOString(),
    tool_calls: [{ id: write.tool_calls[0].id, source_event_id: write.id }],
  });

  return events;
}

/** Resume turn after approval: the tool runs, the agent verifies, reports. */
function allowTimeline(script) {
  const events = [];
  const push = (at, ev) => events.push({ at: el(at), ev });

  push(0.2, toolResponse(toolCallMessage(script.writeTool, script.writeArgs), script.writeResult));

  const verify = toolCallMessage(script.verifyTool, script.verifyArgs);
  push(1.8, verify);
  push(2.4, toolResponse(verify, script.verifyResult));

  const submit = toolCallMessage('submit_resolution', script.resolution);
  push(4.0, submit);
  push(4.4, toolResponse(submit, { recorded: true, kind: 'resolution' }));

  push(5.0, {
    id: nextId('msg'),
    type: 'turn.done',
    thread_id: 'main',
    created_at: new Date().toISOString(),
    state: { status: 'done', output: null },
  });
  return events;
}

/** Resume turn after rejection: the agent is told no and reports accordingly. */
function denyTimeline(script, reason) {
  const events = [];
  const push = (at, ev) => events.push({ at: el(at), ev });

  push(0.2, toolResponse(toolCallMessage(script.writeTool, script.writeArgs), { error: `User denied tool call: ${reason || 'no reason given'}` }));

  const resolution = {
    ...script.resolution,
    verdict: 'rejected',
    actionTaken: 'none',
    after: script.diagnosis.before,
    reasoning: `The operator rejected ${script.writeTool}${reason ? `: ${reason}` : ''}. No action was taken, so the incident is unchanged and still needs a decision.`,
    followUp: 'Awaiting a decision on this incident. The proposed fix was not applied.',
  };
  const submit = toolCallMessage('submit_resolution', resolution);
  push(1.6, submit);
  push(2.0, toolResponse(submit, { recorded: true, kind: 'resolution' }));

  push(2.4, {
    id: nextId('msg'),
    type: 'turn.done',
    thread_id: 'main',
    created_at: new Date().toISOString(),
    state: { status: 'done', output: null },
  });
  return events;
}

export function createFakeAdapter() {
  /**
   * sessionId -> {
   *   script, paused, decision,
   *   investigation: {events, startedAt},
   *   resume: {events, startedAt} | null
   * }
   */
  const sessions = new Map();

  /** Everything a poll needs, derived from the two timelines. */
  function readState(session) {
    const all = [...(session.investigation?.events ?? []), ...(session.resume?.events ?? [])];
    const elapsedIn = (tl) => (tl ? Date.now() - tl.startedAt : 0);
    const visible = (tl) => (tl ? tl.events.filter((s) => s.at <= elapsedIn(tl)).map((s) => s.ev) : []);

    const investigation = visible(session.investigation);
    const resume = visible(session.resume);
    const events = [...investigation, ...resume];

    const gate = [...events].reverse().find((e) => e?.type === 'tool.approval_required');
    const done = [...events].reverse().find((e) => e?.type === 'turn.done');

    // Mirrors the real adapter: reconstruct the approval handle from events so
    // nothing has to be held in memory.
    const paused = gate
      ? { kind: 'approval', turnId: session.investigation.turnId, threadId: gate.thread_id, toolCalls: gate.tool_calls }
      : null;

    // Which tool calls succeeded, so we can find submit_* arguments the way
    // getReports() does — by matching model.message tool_calls to their response.
    const responded = new Map(
      events.filter((e) => e.type === 'tool.response').map((e) => [e.tool_call_id, e]),
    );
    const toolArgs = (tool) => {
      for (const e of events) {
        if (e.type !== 'model.message' || !e.tool_calls) continue;
        for (const tc of e.tool_calls) {
          if (tc.function?.name !== tool) continue;
          if (responded.get(tc.id)?.content?.includes('"error"')) continue;
          try {
            return JSON.parse(tc.function.arguments);
          } catch {
            return null;
          }
        }
      }
      return null;
    };

    let pendingAction = null;
    if (paused) {
      const wanted = new Set(paused.toolCalls.map((t) => t.id));
      for (const e of investigation) {
        if (e.type !== 'model.message' || !e.tool_calls) continue;
        for (const tc of e.tool_calls) {
          if (!wanted.has(tc.id)) continue;
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }
          pendingAction = {
            threadId: paused.threadId,
            toolCallId: tc.id,
            tool: tc.function.name,
            args,
            server: tc.tool_info?.server_name ?? null,
            unavailable: false,
            extras: [],
          };
        }
      }
    }

    return {
      paused,
      pendingAction,
      diagnosis: toolArgs('submit_diagnosis'),
      resolution: toolArgs('submit_resolution'),
      events,
      turnDone: Boolean(done),
      turnStatus: done?.state?.status ?? null,
      decision: session.decision,
    };
  }

  return {
    mode: 'fake',

    async ensureReady() {
      /* nothing to register */
    },

    async createSession({ description }) {
      const id = `sess_fake_${String(++sessionSeq).padStart(4, '0')}`;
      // The script is picked from the description so the timeline matches
      // whatever the operator clicked. Not intelligence — just fidelity.
      const scenario = /conn-leak/.test(description ?? '')
        ? 'conn-leak'
        : /mem-leak/.test(description ?? '')
          ? 'mem-leak'
          : null;
      sessions.set(id, { id, script: SCRIPT_FOR(scenario), investigation: null, resume: null, decision: null });
      logger.info('[fake] session created', { sessionId: id, scenario: scenario ?? 'generic' });
      return { sessionId: id };
    },

    startInvestigation({ sessionId }) {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.investigation = {
        turnId: `turn_fake_${String(++turnSeq).padStart(4, '0')}`,
        startedAt: Date.now(),
        events: investigationTimeline(session.script),
      };
      logger.info('[fake] investigation started', { sessionId, turnId: session.investigation.turnId });
    },

    submitDecision({ sessionId, decision, reason }) {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.decision = decision;
      session.resume = {
        turnId: `turn_fake_${String(++turnSeq).padStart(4, '0')}`,
        startedAt: Date.now(),
        events: decision === 'allow' ? allowTimeline(session.script) : denyTimeline(session.script, reason),
      };
      logger.info('[fake] decision recorded', { sessionId, decision });
    },

    async readState({ sessionId }) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`[fake] unknown session ${sessionId}`);
      return readState(session);
    },

    sessionUrl(sessionId) {
      return `${config.trueforge.url}/sessions/${sessionId}`;
    },
  };
}
