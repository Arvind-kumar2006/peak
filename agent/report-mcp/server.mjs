// report-mcp (port 7104): how the agent hands structured results to PEAK.
// Tools are read-only (no approval): they validate the report and acknowledge it.
// The backend reads the submitted arguments from TrueForge session events
// (see getReports in lib/trueforge-client.mjs), so this server keeps no state.
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { diagnosisShape, resolutionShape } from '../report-schema.mjs';

const PORT = Number(process.env.PORT ?? 7104);
const name = 'report-mcp';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

function buildServer() {
  const server = new McpServer({ name, version: '0.1.0' });

  server.registerTool(
    'submit_diagnosis',
    {
      description:
        'Submit the root-cause diagnosis and proposed fix. MUST be called exactly once, after investigating and BEFORE calling any write/action tool. The human approver sees this report next to the Approve button.',
      inputSchema: diagnosisShape,
      annotations: { readOnlyHint: true },
    },
    async (report) => {
      console.log(`[${name}] diagnosis: ${report.rootCause.category} (${report.rootCause.confidence}) → ${report.proposedFix.action}`);
      const next =
        report.proposedFix.action === 'none'
          ? 'Recorded. No action proposed: call submit_resolution with verdict not_resolved and explain what a human should check.'
          : `Recorded. Now call ${report.proposedFix.action} with exactly the args you proposed. It will pause for human approval.`;
      return text({ ok: true, next });
    }
  );

  server.registerTool(
    'submit_resolution',
    {
      description:
        'Submit the final verdict after the action ran (or was rejected). Call exactly once, as the last tool call, after checking get_metrics_window.',
      inputSchema: resolutionShape,
      annotations: { readOnlyHint: true },
    },
    async (report) => {
      console.log(`[${name}] resolution: ${report.verdict} after ${report.actionTaken}`);
      return text({ ok: true, next: 'Recorded. Reply with a two-sentence post-incident summary and stop.' });
    }
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
  .listen(PORT, () => console.log(`[${name}] listening on http://localhost:${PORT}/mcp`));
