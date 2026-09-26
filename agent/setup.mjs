// One-command TrueForge setup for PEAK: model providers (fallback order), the four MCP
// servers, and the named `incident-investigator` agent (handy for the TrueForge UI).
// Safe to re-run: everything is created-or-replaced.
//
//   node --env-file=../.env setup.mjs        (or: MODEL_PROVIDERS=mock node setup.mjs)
import { providersFromEnv, modelRef } from './lib/providers.mjs';
import { createClient } from './lib/trueforge-client.mjs';
import { AGENT_NAME, MCP_SERVERS, WRITE_TOOLS, buildAgentSpec } from './agent-spec.mjs';

const providers = providersFromEnv();
const tf = createClient({ providers });

console.log('▶ Model providers (fallback order):', providers.map(modelRef).join(' → '));
await tf.registerProviders();

console.log('▶ MCP servers');
let missing = 0;
for (const s of MCP_SERVERS) {
  await tf.registerMcpServer(s);
  try {
    const tools = await tf.api('GET', `/mcp-servers/${s.name}/tools`);
    const names = tools.map((t) => t.name);
    const absent = s.writeTools.filter((w) => !names.includes(w));
    console.log(`  ✓ ${s.name.padEnd(11)} ${names.join(', ')}${absent.length ? `  ⚠ missing write tools: ${absent.join(', ')}` : ''}`);
  } catch (err) {
    missing += 1;
    console.log(`  ✗ ${s.name.padEnd(11)} not reachable at ${s.url} — is it running?`);
  }
}

console.log(`▶ Agent "${AGENT_NAME}"`);
const manifest = {
  ...buildAgentSpec(),
  model: { name: modelRef(providers[0]), ...(providers[0].params ? { params: providers[0].params } : {}) },
};
const existing = (await tf.api('GET', '/agents')).find((a) => a.name === AGENT_NAME);
if (existing) {
  await tf.api('PUT', `/agents/${existing.id}`, { description: 'PEAK production incident responder', manifest });
} else {
  await tf.api('POST', '/agents', { name: AGENT_NAME, description: 'PEAK production incident responder', manifest });
}
console.log(`  ✓ saved — approval required for: ${WRITE_TOOLS.join(', ')}`);

console.log(missing ? `\n⚠ Setup finished with ${missing} unreachable MCP server(s).` : '\n✓ TrueForge is ready.');
process.exit(missing ? 1 : 0);
