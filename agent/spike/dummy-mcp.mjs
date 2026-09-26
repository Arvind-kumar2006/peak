// Minimal MCP server for the TrueForge approval spike.
// One read tool + one destructive tool, Streamable HTTP at /mcp (stateless).
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 7199);
let healthy = false;

function buildServer() {
  const server = new McpServer({ name: 'spike-mcp', version: '0.0.1' });

  server.registerTool(
    'get_health',
    {
      description: 'Returns the current health of the demo service.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ healthy, errorRate: healthy ? 0.001 : 0.42, observedAt: new Date().toISOString() }) }],
    }),
  );

  server.registerTool(
    'restart_service',
    {
      description: 'Restarts the demo service. Destructive: requires human approval.',
      inputSchema: { reason: z.string().describe('Why the restart is needed') },
      annotations: { destructiveHint: true },
    },
    async ({ reason }) => {
      console.log(`[spike-mcp] restart_service EXECUTED — reason: ${reason}`);
      healthy = true;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, at: new Date().toISOString() }) }] };
    },
  );

  return server;
}

http
  .createServer(async (req, res) => {
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
  })
  .listen(PORT, () => console.log(`[spike-mcp] listening on http://localhost:${PORT}/mcp`));
