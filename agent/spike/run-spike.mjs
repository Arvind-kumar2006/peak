// TrueForge approval spike: proves the Feature 3 gate works over HTTP.
//
//   1. register the dummy MCP server + Anthropic provider
//   2. start a session whose agent must call restart_service
//   3. wait for tool.approval_required
//   4. approve it via the API (what our backend's /approve will do)
//   5. confirm the tool executed and the turn finished
//
// Prereqs: TrueForge running (npx @truefoundry/trueforge@0.2.1) and dummy-mcp running.
// Model, pick one:
//   ANTHROPIC_API_KEY=...  real Claude
//   MOCK_MODEL=1           scripted model from mock-model.mjs (no key needed; run `npm run mock-model` first)
// Set SKIP_MODEL=1 to only check registration.

const TF = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
const MCP_URL = process.env.SPIKE_MCP_URL ?? 'http://localhost:7199/mcp';
const MODEL_ID = process.env.MODEL_ID ?? 'claude-sonnet-5';
const MOCK_MODEL = Boolean(process.env.MOCK_MODEL);
const MOCK_MODEL_URL = process.env.MOCK_MODEL_URL ?? 'http://localhost:7300/v1';
const DECISION = process.env.DECISION ?? 'allow'; // or 'deny'

async function api(method, path, body) {
  const res = await fetch(`${TF}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const step = (msg) => console.log(`\n▶ ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTurn(sessionId, turnId, stopWhen) {
  for (let i = 0; i < 120; i++) {
    const { data } = await api('GET', `/sessions/${sessionId}/turns/${turnId}/events?limit=100`);
    const hit = data.find(stopWhen);
    if (hit) return { hit, events: data };
    await sleep(1000);
  }
  throw new Error('timed out waiting for turn');
}

step('Resetting dummy service to unhealthy');
await fetch(MCP_URL.replace(/\/mcp$/, '/reset'), { method: 'POST' });

step('Registering MCP server "spike-mcp"');
await api('PUT', '/settings/mcp-servers', {
  manifest: { type: 'remote', name: 'spike-mcp', url: MCP_URL, description: 'Spike: health check + restart' },
});
const { data: tools } = await api('GET', '/mcp-servers/spike-mcp/tools');
console.log('  tools:', JSON.stringify(tools));

if (process.env.SKIP_MODEL) {
  console.log('\nSKIP_MODEL set — registration OK, stopping before model calls.');
  process.exit(0);
}
let provider;
if (MOCK_MODEL) {
  step('Registering scripted mock model provider');
  provider = 'mock';
  await api('PUT', '/settings/model-providers', {
    manifest: {
      type: 'custom',
      name: 'mock',
      base_url: MOCK_MODEL_URL,
      auth: { api_key: 'not-used' },
      models: [{ model_id: 'mock-1', name: 'spike-model', properties: {} }],
    },
  });
} else {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY, or MOCK_MODEL=1');
  step('Registering Anthropic model provider');
  provider = 'anthropic';
  await api('PUT', '/settings/model-providers', {
    manifest: {
      type: 'anthropic',
      auth: { api_key: process.env.ANTHROPIC_API_KEY },
      models: [{ model_id: MODEL_ID, name: 'spike-model', properties: {} }],
    },
  });
}
const models = await api('GET', '/models');
console.log('  models:', JSON.stringify(models).slice(0, 300));

step('Creating session with inline agent spec');
const session = await api('POST', '/sessions', {
  agent: {
    spec: {
      model: { name: `${provider}/spike-model` },
      instructions:
        'You are an incident responder. First call get_health. If unhealthy, call restart_service with a reason. ' +
        'After it runs, call get_health again and report whether the service recovered.',
      mcp_servers: [{ name: 'spike-mcp', preload: true, require_approval_for_tools: ['restart_service'] }],
    },
  },
  metadata: { incidentId: 'spike-001' },
});
const sessionId = session.data.id;
console.log("  session:", sessionId);


step('Starting investigation turn');
const turn = await api('POST', `/sessions/${sessionId}/turns`, {
  stream: false,
  input: [{ type: 'user.message', content: 'The service is throwing errors. Investigate and fix.' }],
});
const turnId = turn.data.id;
console.log('  turn:', turnId);

step('Waiting for tool.approval_required');
const { hit: approval } = await waitForTurn(sessionId, turnId, (e) => e.type === 'tool.approval_required' || e.type === 'turn.done');
if (approval.type === 'turn.done' && approval.state.status === 'error') {
  console.error('✗ Turn errored before reaching a tool call:', approval.state.message);
  process.exit(1);
}
if (approval.type !== 'tool.approval_required') {
  console.error('✗ Turn finished without requesting approval — gate did NOT fire', JSON.stringify(approval));
  process.exit(1);
}
console.log('  ✓ approval requested:', JSON.stringify(approval.tool_calls));

step(`Sending decision: ${DECISION}`);
const resume = await api('POST', `/sessions/${sessionId}/turns`, {
  stream: false,
  previous_turn_id: turnId,
  input: approval.tool_calls.map((tc) => ({
    type: 'user.tool_approval',
    thread_id: approval.thread_id,
    tool_call_id: tc.id,
    approval: DECISION === 'allow' ? { status: 'allow' } : { status: 'deny', reason: 'Rejected in spike' },
  })),
});
const resumeTurnId = resume.data.id;

step('Waiting for turn.done');
const { hit: done, events } = await waitForTurn(sessionId, resumeTurnId, (e) => e.type === 'turn.done');
console.log('  final state:', JSON.stringify(done.state));
const lastMsg = events.filter((e) => e.type === 'model.message').at(-1);
console.log('  final message:', JSON.stringify(lastMsg).slice(0, 800));

console.log(`\n✓ Spike complete. Session UI: ${TF}/sessions/${sessionId}`);
console.log('  Check dummy-mcp logs for "restart_service EXECUTED" (allow) or its absence (deny).');
