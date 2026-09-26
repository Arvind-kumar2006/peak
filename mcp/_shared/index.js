import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http from 'node:http';
import { z } from 'zod';

export function createMcpServer(name, version = '0.1.0') {
  return new McpServer({ name, version });
}

export function createHttpServer(name, port, buildServer) {
  return http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }).listen(port, () => console.log(`[${name}] listening on http://localhost:${port}/mcp`));
}

export function withMetadata(result, source) {
  return {
    ...result,
    source,
    observedAt: new Date().toISOString()
  };
}

export function mockMode() {
  return process.env.MOCK === '1';
}

export const mockScenario = process.env.MOCK_SCENARIO ?? 'A';