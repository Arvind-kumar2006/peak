// Fallback test: primary provider is down (mock in FAIL mode), fallback is healthy.
// Expect: first turn fails on primary → session switches to fallback → approval pause → approve → done.
//
//   PORT=7301 FAIL=1 npm run mock-model   # "down" primary
//   npm run mock-model                     # healthy fallback on 7300
//   npm run mcp
//   npm run fallback-test
import { createClient } from '../lib/trueforge-client.mjs';

const mockProvider = (name, port) => ({
  name,
  apiKey: 'not-used',
  model: { model_id: 'mock-1', name: 'peak-model', properties: {} },
  manifest: {
    type: 'custom',
    name,
    base_url: `http://localhost:${port}/v1`,
    auth: { api_key: 'not-used' },
    models: [{ model_id: 'mock-1', name: 'peak-model', properties: {} }],
  },
});

const tf = createClient({ providers: [mockProvider('primary-down', 7301), mockProvider('fallback-ok', 7300)] });

await fetch('http://localhost:7199/reset', { method: 'POST' });
await tf.registerMcpServer({ name: 'spike-mcp', url: 'http://localhost:7199/mcp', description: 'Spike: health check + restart' });
await tf.registerProviders();

const session = await tf.createSession(
  {
    instructions: 'Check health; if unhealthy restart the service, then verify.',
    mcp_servers: [{ name: 'spike-mcp', preload: true, require_approval_for_tools: ['restart_service'] }],
  },
  { incidentId: 'fallback-test' },
);
console.log('session:', tf.sessionUrl(session));

const paused = await tf.start(session, 'The service is throwing errors. Investigate and fix.');
console.log('after start:', paused.kind, 'on', paused.provider);
if (paused.kind !== 'approval') {
  console.error('✗ expected approval pause, got', JSON.stringify(paused.state));
  process.exit(1);
}

const done = await tf.approve(session, paused);
console.log('after approve:', done.kind, done.state?.status, 'on', done.provider);
console.log('final:', done.state?.output?.content);

const ok = done.kind === 'done' && done.state.status === 'done' && done.provider === 'fallback-ok';
console.log(ok ? '\n✓ Fallback works' : '\n✗ Fallback test failed');
process.exit(ok ? 0 : 1);
