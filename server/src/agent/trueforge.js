// Minimal TrueForge client with model fallback.
// API details: contracts/trueforge.md
import { modelRef } from './providers.js';

export function createClient({ baseUrl = process.env.TRUEFORGE_URL ?? 'http://localhost:8790', providers, log = console.log } = {}) {
  if (!providers?.length) throw new Error('createClient: providers is required');

  async function api(method, path, body) {
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return text ? JSON.parse(text).data : null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function registerProviders() {
    for (const p of providers) {
      await api('PUT', '/settings/model-providers', { manifest: p.manifest });
      log(`[trueforge] provider ready: ${modelRef(p)} (${p.model.model_id})`);
    }
  }

  async function registerMcpServer({ name, url, description }) {
    await api('PUT', '/settings/mcp-servers', { manifest: { type: 'remote', name, url, description } });
  }

  // spec: AgentSpec without `model` — the client fills it in from the provider list.
  async function createSession(spec, metadata = {}) {
    const session = await api('POST', '/sessions', {
      agent: { spec: { ...spec, model: modelFor(providers[0], spec.model) } },
      metadata: { ...metadata, provider: providers[0].name },
    });
    return { id: session.id, spec: session.agent.spec, providerIndex: 0 };
  }

  // Poll a turn until it pauses for approval or finishes.
  // Returns { kind: 'approval', turnId, threadId, toolCalls } | { kind: 'done', turnId, state }
  async function waitForTurn(sessionId, turnId, { timeoutMs = 20 * 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const events = await api('GET', `/sessions/${sessionId}/turns/${turnId}/events?limit=100`);
      const approval = events.find((e) => e.type === 'tool.approval_required');
      if (approval) return { kind: 'approval', turnId, threadId: approval.thread_id, toolCalls: approval.tool_calls };
      const done = events.find((e) => e.type === 'turn.done');
      if (done) return { kind: 'done', turnId, state: done.state };
      await sleep(1000);
    }
    throw new Error(`turn ${turnId} timed out`);
  }

  async function switchProvider(session, index) {
    const provider = providers[index];
    const spec = { ...session.spec, model: modelFor(provider, session.spec.model) };
    await api('PATCH', `/sessions/${session.id}`, { agent: { spec }, metadata: { provider: provider.name } });
    session.spec = spec;
    session.providerIndex = index;
    log(`[trueforge] session ${session.id}: switched to ${modelRef(provider)}`);
  }

  // Start a turn and wait for it. If it errors (model/provider failure), switch the
  // session to the next provider and retry. Approval inputs can't be replayed once the
  // tool has run, so a failed resume is retried with a "continue" message instead.
  async function runTurn(session, input, { previousTurnId, onTurn } = {}) {
    let turnInput = input;
    let prev = previousTurnId;
    for (;;) {
      const turn = await api('POST', `/sessions/${session.id}/turns`, {
        stream: false,
        input: turnInput,
        ...(prev ? { previous_turn_id: prev } : {}),
      });
      onTurn?.(turn.id);
      const result = await waitForTurn(session.id, turn.id);
      if (result.kind !== 'done' || result.state.status !== 'error') return { ...result, provider: providers[session.providerIndex].name };

      const next = session.providerIndex + 1;
      log(`[trueforge] turn ${turn.id} failed on ${providers[session.providerIndex].name}: ${result.state.message}`);
      if (next >= providers.length) return { ...result, provider: providers[session.providerIndex].name };

      await switchProvider(session, next);
      prev = turn.id;
      if (turnInput.some((i) => i.type !== 'user.message')) {
        turnInput = [{ type: 'user.message', content: 'The previous model call failed. Continue the investigation from where you left off.' }];
      }
    }
  }

  const start = (session, content, opts) => runTurn(session, [{ type: 'user.message', content }], opts);

  // Re-attach to an existing session (e.g. after a backend restart) — only the id needs storing.
  async function loadSession(sessionId) {
    const s = await api('GET', `/sessions/${sessionId}`);
    const index = Math.max(0, providers.findIndex((p) => p.name === s.metadata?.provider));
    return { id: s.id, spec: s.agent.spec, providerIndex: index, metadata: s.metadata };
  }

  // All session events, oldest first (the API pages newest-first, 100 at a time).
  async function listSessionEvents(sessionId) {
    const pages = [];
    let token;
    do {
      const qs = new URLSearchParams({ limit: '100', ...(token ? { page_token: token } : {}) });
      const res = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/events?${qs}`);
      if (!res.ok) throw new Error(`GET events → ${res.status}: ${await res.text()}`);
      const body = await res.json();
      // Session events are wrapped as { turn_id, event } (turn events are not).
      pages.push(body.data.map((item) => ({ ...item.event, turn_id: item.turn_id })));
      token = body.pagination?.next_page_token;
    } while (token);
    return pages.flat().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // Every tool call in the session: { id, tool, server, args, result, isError, at }.
  async function listToolCalls(sessionId) {
    const events = await listSessionEvents(sessionId);
    const responses = new Map(events.filter((e) => e.type === 'tool.response').map((e) => [e.tool_call_id, e]));
    const calls = [];
    for (const e of events) {
      if (e.type !== 'model.message' || !e.tool_calls) continue;
      for (const tc of e.tool_calls) {
        const r = responses.get(tc.id);
        calls.push({
          id: tc.id,
          tool: tc.function.name,
          server: tc.tool_info?.server_name ?? null,
          args: safeJson(tc.function.arguments),
          result: r ? safeJson(r.content) : null,
          at: e.created_at,
        });
      }
    }
    return calls;
  }

  // The write tool waiting for approval, with its arguments (for the Approve screen).
  async function getPendingAction(session, paused) {
    if (paused?.kind !== 'approval') return null;
    const calls = await listToolCalls(session.id);
    const ids = new Set(paused.toolCalls.map((t) => t.id));
    const pending = calls.filter((c) => ids.has(c.id));
    return pending.map(({ id, tool, server, args }) => ({ toolCallId: id, threadId: paused.threadId, tool, server, args }));
  }

  function decide(session, paused, decision, reason, opts = {}) {
    return runTurn(
      session,
      paused.toolCalls.map((tc) => ({
        type: 'user.tool_approval',
        thread_id: paused.threadId,
        tool_call_id: tc.id,
        approval: decision === 'allow' ? { status: 'allow' } : { status: 'deny', ...(reason ? { reason } : {}) },
      })),
      { ...opts, previousTurnId: paused.turnId },
    );
  }

  return {
    api,
    waitForTurn,
    loadSession,
    listSessionEvents,
    listToolCalls,
    getPendingAction,
    registerProviders,
    registerMcpServer,
    createSession,
    start,
    approve: (session, paused, opts) => decide(session, paused, 'allow', undefined, opts),
    reject: (session, paused, reason, opts) => decide(session, paused, 'deny', reason, opts),
    sessionUrl: (session) => `${baseUrl}/sessions/${session.id}`,
  };
}

function safeJson(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

// AgentSpec model for a provider. Provider-specific params (e.g. Groq's include_reasoning)
// replace the previous provider's, so a fallback never inherits settings it would reject.
function modelFor(provider, base = {}) {
  const { params: _previous, ...rest } = base;
  return { ...rest, name: modelRef(provider), ...(provider.params ? { params: provider.params } : {}) };
}
