// Minimal TrueForge client with model fallback. Used by agent scripts and P4's backend.
// API details: contracts/trueforge.md
import { modelRef } from './providers.mjs';

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
      agent: { spec: { ...spec, model: { ...spec.model, name: modelRef(providers[0]) } } },
      metadata: { ...metadata, provider: providers[0].name },
    });
    return { id: session.id, spec: session.agent.spec, providerIndex: 0 };
  }

  // Poll a turn until it pauses for approval or finishes.
  // Returns { kind: 'approval', turnId, threadId, toolCalls } | { kind: 'done', turnId, state }
  async function waitForTurn(sessionId, turnId, { timeoutMs = 300_000 } = {}) {
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
    const spec = { ...session.spec, model: { ...session.spec.model, name: modelRef(provider) } };
    await api('PATCH', `/sessions/${session.id}`, { agent: { spec }, metadata: { provider: provider.name } });
    session.spec = spec;
    session.providerIndex = index;
    log(`[trueforge] session ${session.id}: switched to ${modelRef(provider)}`);
  }

  // Start a turn and wait for it. If it errors (model/provider failure), switch the
  // session to the next provider and retry. Approval inputs can't be replayed once the
  // tool has run, so a failed resume is retried with a "continue" message instead.
  async function runTurn(session, input, { previousTurnId } = {}) {
    let turnInput = input;
    let prev = previousTurnId;
    for (;;) {
      const turn = await api('POST', `/sessions/${session.id}/turns`, {
        stream: false,
        input: turnInput,
        ...(prev ? { previous_turn_id: prev } : {}),
      });
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

  const start = (session, content) => runTurn(session, [{ type: 'user.message', content }]);

  function decide(session, paused, decision, reason) {
    return runTurn(
      session,
      paused.toolCalls.map((tc) => ({
        type: 'user.tool_approval',
        thread_id: paused.threadId,
        tool_call_id: tc.id,
        approval: decision === 'allow' ? { status: 'allow' } : { status: 'deny', ...(reason ? { reason } : {}) },
      })),
      { previousTurnId: paused.turnId },
    );
  }

  return {
    api,
    registerProviders,
    registerMcpServer,
    createSession,
    start,
    approve: (session, paused) => decide(session, paused, 'allow'),
    reject: (session, paused, reason) => decide(session, paused, 'deny', reason),
    sessionUrl: (session) => `${baseUrl}/sessions/${session.id}`,
  };
}
