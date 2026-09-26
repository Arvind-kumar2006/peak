// Scripted, rule-based stand-in for the LLM (OpenAI Chat Completions API, streaming).
// It follows the same runbook as instructions.md, reading real tool results, so the whole
// pipeline — MCP servers, approval gate, reports, backend, dashboard — can be exercised
// for free and deterministically. Register it via MODEL_PROVIDERS=mock.
//
//   MOCK_BEHAVIOR=correct (default) → picks the right fix
//   MOCK_BEHAVIOR=trap              → picks the tempting wrong fix (tests verification)
//   FAIL=1                          → every call returns 503 (tests provider fallback)
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 7300);
const BEHAVIOR = process.env.MOCK_BEHAVIOR ?? 'correct';
const FAIL = Boolean(process.env.FAIL);

const INVESTIGATE = [
  ['get_service_status', {}],
  ['get_metrics', {}],
  ['get_recent_errors', { sinceMinutes: 60 }],
  ['get_pool_stats', {}],
  ['list_recent_commits', { sinceMinutes: 120 }],
];

function parseResult(content) {
  let v = content;
  if (Array.isArray(v)) v = v.map((p) => p.text ?? '').join('');
  try {
    v = JSON.parse(v);
  } catch {
    return { text: String(v) };
  }
  if (Array.isArray(v?.error)) v = { error: v.error.map((p) => p.text ?? '').join('') };
  return v;
}

// Tool calls made so far, in order, with parsed results.
function history(messages) {
  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, parseResult(m.content)]));
  return messages
    .filter((m) => m.role === 'assistant' && m.tool_calls)
    .flatMap((m) => m.tool_calls.map((tc) => ({ name: tc.function.name, args: JSON.parse(tc.function.arguments || '{}'), result: results.get(tc.id) })));
}

const summarize = (m) =>
  m && {
    errorRate: m.http?.errorRate ?? null,
    p95Ms: m.http?.p95Ms ?? null,
    poolInUse: m.db?.pool?.inUse ?? null,
    poolWaiting: m.db?.pool?.waiting ?? null,
    memoryMB: m.process?.memoryMB ?? null,
    release: m.release ?? null,
  };

function diagnose(h) {
  const get = (name) => h.findLast((c) => c.name === name)?.result ?? {};
  const status = get('get_service_status');
  const metrics = get('get_metrics');
  const pool = get('get_pool_stats');
  const errors = get('get_recent_errors').issues ?? [];
  const commits = get('list_recent_commits').commits ?? [];
  const diff = get('get_commit_diff');
  const patch = (diff.files ?? []).map((f) => f.patch).join('\n');
  const before = summarize(metrics);

  const leakInDiff = /^\+.*BEGIN/m.test(patch) && !/^\+.*(COMMIT|release\()/m.test(patch);
  const saturated = pool.inUse >= pool.max && pool.max > 0;
  const memHigh = metrics.process && metrics.process.memoryMB > 0.6 * metrics.process.memoryLimitMB;

  if (commits.length && leakInDiff && saturated) {
    const sha = diff.sha?.slice(0, 7);
    const target = status.previousDeploy?.id;
    const trap = BEHAVIOR === 'trap';
    return {
      summary: `Deploy ${sha} ("${diff.message}") leaks DB connections inside an uncommitted transaction; the pool is exhausted and /orders is failing.`,
      rootCause: {
        category: 'code',
        description: `Commit ${sha} acquires one client and runs BEGIN with no COMMIT or release() → clients stay idle in transaction → pool saturates (${pool.inUse}/${pool.max}, ${pool.waiting} waiting) → "pool exhausted" errors and p95 ${metrics.http?.p95Ms}ms.`,
        confidence: 0.93,
        commitSha: sha,
      },
      evidence: [
        { claim: 'Bad commit is the running deploy', tool: 'cloud-mcp.get_service_status', observation: `running ${status.runningCommit}, currentDeploy ${status.currentDeploy?.id}` },
        { claim: 'Diff leaks the client', tool: 'github-mcp.get_commit_diff', observation: 'adds acquire() + BEGIN, removes per-page release(client); no COMMIT' },
        { claim: 'Connections stuck in open transactions', tool: 'db-mcp.get_pool_stats', observation: `inUse ${pool.inUse}/${pool.max}, waiting ${pool.waiting}, idleInTransaction ${pool.idleInTransaction}` },
        { claim: 'Errors tagged with the bad release', tool: 'cloud-mcp.get_recent_errors', observation: errors.map((e) => `${e.title} ×${e.count} on ${e.release}`).join('; ') || 'none' },
      ],
      ruledOut: [`Memory pressure — ${metrics.process?.memoryMB}MB of ${metrics.process?.memoryLimitMB}MB`],
      proposedFix: trap
        ? { action: 'restart_service', args: { reason: 'Drain the exhausted DB pool' }, reasoning: 'Restart frees the stuck connections.', expectedOutcome: 'mitigates' }
        : { action: 'trigger_rollback', args: { toDeployId: target, reason: `Roll back leaking commit ${sha}` }, reasoning: `Rolling back to ${target} removes the leaking code; a restart would only drain the pool until the leak refills it.`, expectedOutcome: 'resolves' },
      before,
    };
  }
  if (memHigh && !commits.length) {
    const trap = BEHAVIOR === 'trap';
    return {
      summary: `No recent deploy; in-process cache is growing without eviction (${metrics.cache?.entries} entries) and memory is at ${metrics.process.memoryMB}MB of ${metrics.process.memoryLimitMB}MB.`,
      rootCause: {
        category: 'infra',
        description: `Unbounded cache growth → memory ${metrics.process.memoryMB}MB (${Math.round((100 * metrics.process.memoryMB) / metrics.process.memoryLimitMB)}% of limit) → GC pressure → p95 ${metrics.http?.p95Ms}ms. No commits in the last 120 minutes.`,
        confidence: 0.85,
        commitSha: null,
      },
      evidence: [
        { claim: 'Memory near limit', tool: 'cloud-mcp.get_metrics', observation: `memoryMB ${metrics.process.memoryMB} / ${metrics.process.memoryLimitMB}, cache.entries ${metrics.cache?.entries}` },
        { claim: 'No recent deploy', tool: 'github-mcp.list_recent_commits', observation: '0 commits in the last 120 minutes' },
        { claim: 'Database healthy', tool: 'db-mcp.get_pool_stats', observation: `inUse ${pool.inUse}/${pool.max}, waiting ${pool.waiting}, idleInTransaction ${pool.idleInTransaction}` },
      ],
      ruledOut: ['Bad deploy — no commits in the incident window', `DB leak — pool ${pool.inUse}/${pool.max}`],
      proposedFix: trap
        ? { action: 'trigger_rollback', args: { toDeployId: status.previousDeploy?.id, reason: 'Roll back' }, reasoning: 'Rollback to the previous deploy.', expectedOutcome: 'resolves' }
        : { action: 'clear_cache', args: { reason: 'Unbounded cache growth is exhausting memory' }, reasoning: 'Clearing the cache releases the memory directly; no code change is involved.', expectedOutcome: 'resolves' },
      before,
    };
  }
  return {
    summary: 'Symptoms do not match a known failure pattern.',
    rootCause: { category: 'unknown', description: 'Evidence is inconclusive.', confidence: 0.3, commitSha: null },
    evidence: [
      { claim: 'Current metrics', tool: 'cloud-mcp.get_metrics', observation: JSON.stringify(before) },
      { claim: 'Pool state', tool: 'db-mcp.get_pool_stats', observation: `inUse ${pool.inUse}/${pool.max}` },
    ],
    ruledOut: [],
    proposedFix: { action: 'none', args: {}, reasoning: 'No action is supported by the evidence.', expectedOutcome: 'mitigates' },
    before,
  };
}

const healthy = (s) =>
  s.http.errorRate < 0.01 && s.db.pool.inUse < 0.5 * s.db.pool.max && s.db.pool.waiting === 0 && s.process.memoryMB < 0.6 * s.process.memoryLimitMB && s.http.p95Ms < 150;

function resolve(diagnosis, action, window) {
  const samples = window.samples ?? [];
  const last = samples.at(-1);
  const rising = samples.length > 1 && samples.at(-1).db.pool.inUse > samples[0].db.pool.inUse + 2;
  const allHealthy = samples.length > 0 && samples.every(healthy);
  const stillBad = action === 'trigger_rollback' && diagnosis.rootCause.commitSha && last?.release?.startsWith(diagnosis.rootCause.commitSha);
  let verdict;
  if (allHealthy && !stillBad) verdict = 'resolved';
  else if (samples.some(healthy) || rising) verdict = 'mitigated';
  else verdict = 'not_resolved';
  const reason = {
    resolved: `All ${samples.length} samples over ${window.samples?.length ? 60 : 0}s are healthy (last: errorRate ${last?.http.errorRate}, pool ${last?.db.pool.inUse}/${last?.db.pool.max}, memory ${last?.process.memoryMB}MB, release ${last?.release}).`,
    mitigated: `Symptoms cleared at first but did not hold: pool went ${samples[0]?.db.pool.inUse} → ${last?.db.pool.inUse} of ${last?.db.pool.max} across the window. The root cause is still present.`,
    not_resolved: `No sample in the window is healthy (last: errorRate ${last?.http.errorRate}, pool ${last?.db.pool.inUse}/${last?.db.pool.max}, memory ${last?.process.memoryMB}MB).`,
  }[verdict];
  return {
    verdict,
    actionTaken: action,
    windowSec: 60,
    before: diagnosis.before,
    after: summarize(last),
    reasoning: reason,
    followUp:
      verdict === 'resolved' && action === 'trigger_rollback'
        ? `Fix commit ${diagnosis.rootCause.commitSha} (commit or roll back the transaction and release the client) before redeploying.`
        : verdict === 'resolved'
          ? 'Add eviction / a size bound to the cache so it cannot grow without limit.'
          : 'Escalate to the on-call engineer; the applied action did not remove the root cause.',
  };
}

function decide(messages, availableTools) {
  const h = history(messages);
  const called = (name) => h.some((c) => c.name === name);

  for (const [name, args] of INVESTIGATE) if (!called(name)) return { tool: name, args };

  const status = h.findLast((c) => c.name === 'get_service_status').result;
  const commits = h.findLast((c) => c.name === 'list_recent_commits').result.commits ?? [];
  const deployed = commits.find((c) => status.runningCommit && c.sha.startsWith(status.runningCommit));
  if (deployed && !called('get_commit_diff')) return { tool: 'get_commit_diff', args: { sha: deployed.sha.slice(0, 7) } };
  if (!called('get_slow_queries')) return { tool: 'get_slow_queries', args: { limit: 5 } };

  const diagCall = h.findLast((c) => c.name === 'submit_diagnosis');
  if (!diagCall) return { tool: 'submit_diagnosis', args: diagnose(h) };
  const diagnosis = diagCall.args;
  const action = diagnosis.proposedFix.action;

  if (action === 'none') {
    if (!called('submit_resolution')) {
      return { tool: 'submit_resolution', args: { verdict: 'not_resolved', actionTaken: 'none', windowSec: 0, before: diagnosis.before, after: diagnosis.before, reasoning: 'No supported action matched the evidence.', followUp: 'Manual investigation needed.' } };
    }
    return { text: 'Investigation inconclusive; no action was taken. Escalating to a human.' };
  }

  const actionCall = h.findLast((c) => c.name === action);
  if (!actionCall) return { tool: action, args: diagnosis.proposedFix.args };

  if (!called('submit_resolution')) {
    const r = actionCall.result ?? {};
    const err = r.error ? String(r.error) : null;
    if (err && /denied/i.test(err)) {
      return { tool: 'submit_resolution', args: { verdict: 'rejected', actionTaken: action, windowSec: 0, before: diagnosis.before, after: diagnosis.before, reasoning: `The approver denied ${action}: ${err}`, followUp: 'Handle manually; the diagnosis above still stands.' } };
    }
    if (err) {
      return { tool: 'submit_resolution', args: { verdict: 'not_resolved', actionTaken: action, windowSec: 0, before: diagnosis.before, after: diagnosis.before, reasoning: `${action} failed: ${err}`, followUp: 'Escalate: the remediation tool returned an error.' } };
    }
    const windowCall = h.filter((c) => c.name === 'get_metrics_window').at(-1);
    const afterAction = windowCall && h.indexOf(windowCall) > h.indexOf(actionCall);
    if (!afterAction) return { tool: 'get_metrics_window', args: { seconds: 60, waitSeconds: 60 } };
    return { tool: 'submit_resolution', args: resolve(diagnosis, action, windowCall.result) };
  }

  const res = h.findLast((c) => c.name === 'submit_resolution').args;
  return { text: `${diagnosis.summary} Action: ${action} → ${res.verdict}. ${res.reasoning}` };
}

function sse(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

http
  .createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    if (FAIL) {
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":{"message":"mock provider outage"}}');
      return;
    }
    const body = JSON.parse(raw);
    const available = new Set((body.tools ?? []).map((t) => t.function?.name));
    let step;
    try {
      step = decide(body.messages, available);
      if (step.tool && !available.has(step.tool)) step = { text: `(mock) tool ${step.tool} is not available to this agent.` };
    } catch (err) {
      step = { text: `(mock) could not follow the runbook: ${err.message}` };
    }

    const base = { id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (step.tool) {
      console.log(`[mock-model] → ${step.tool}`);
      sse(res, {
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, finish_reason: null }],
      });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      console.log('[mock-model] → final answer');
      sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    sse(res, { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    res.end('data: [DONE]\n\n');
  })
  .listen(PORT, () => console.log(`[mock-model] listening on http://localhost:${PORT}/v1 (behavior: ${BEHAVIOR})`));
