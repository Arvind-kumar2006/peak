import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http from 'node:http';
import { getState, resetState } from './mockState.js';

export function createMcpServer(name, version = '0.1.0') {
  return new McpServer({ name, version });
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
}

export function createHttpServer(name, port, buildServer) {
  return http.createServer(async (req, res) => {
    // Mock control (MOCK=1 only): GET current state, POST { scenario } to reset the mock world.
    // Any server can be used — state is shared by all three.
    if (req.url === '/mock/state' && mockMode()) {
      const state = req.method === 'POST' ? resetState((await readJson(req))?.scenario) : getState();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state));
      return;
    }
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const body = await readJson(req);

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }).listen(port, () => console.log(`[${name}] listening on http://localhost:${port}/mcp${mockMode() ? ' (MOCK)' : ''}`));
}

export function withMetadata(result, source) {
  return {
    ...result,
    source,
    observedAt: new Date().toISOString()
  };
}

// Tool result helpers.
export function ok(result, source) {
  return { content: [{ type: 'text', text: JSON.stringify(withMetadata(result, source)) }] };
}

// Real mode not built yet → an explicit error, never fake zeros the agent could read as "healthy".
export function notImplemented(source) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: `${source} is not implemented in real mode yet (run with MOCK=1)`, source }) }],
  };
}

export function mockMode() {
  return process.env.MOCK === '1';
}
