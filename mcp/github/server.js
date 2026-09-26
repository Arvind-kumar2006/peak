import { createMcpServer, createHttpServer, withMetadata, mockMode, mockScenario } from '../_shared/index.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 7103);
const name = 'github-mcp';

function buildServer() {
  const server = createMcpServer(name);

  const isMock = mockMode();
  const scenario = mockScenario;

  const badSha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  const goodSha = 'f0e1d2c3b4a59687789a0b1c2d3e4f5a6b7c8d9e';
  const olderSha = 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0a1b2';

  const mockCommits = (scenario === 'A')
    ? [
        { sha: badSha, message: 'perf: reuse client for order lookup', author: 'dev@example.com', timestamp: '2026-09-26T10:00:00Z', filesChanged: ['src/routes/orders.js'] },
        { sha: goodSha, message: 'feat: add product filtering', author: 'dev@example.com', timestamp: '2026-09-25T14:30:00Z', filesChanged: ['src/routes/products.js'] },
        { sha: olderSha, message: 'fix: handle null user in auth', author: 'dev@example.com', timestamp: '2026-09-24T09:15:00Z', filesChanged: ['src/middleware/auth.js'] },
      ]
    : [
        { sha: goodSha, message: 'feat: add product filtering', author: 'dev@example.com', timestamp: '2026-09-25T14:30:00Z', filesChanged: ['src/routes/products.js'] },
        { sha: olderSha, message: 'fix: handle null user in auth', author: 'dev@example.com', timestamp: '2026-09-24T09:15:00Z', filesChanged: ['src/middleware/auth.js'] },
      ];

  const leakyDiff = `diff --git a/src/routes/orders.js b/src/routes/orders.js
index 1234567..abcdefg 100644
--- a/src/routes/orders.js
+++ b/src/routes/orders.js
@@ -10,7 +10,7 @@ export async function getOrders(req, res) {
   const client = await pool.connect()
   try {
     const result = await client.query('SELECT * FROM orders WHERE user_id = $1', [req.user.id])
-    client.release()
+    // client.release() - temporarily commented for perf testing
     return res.json(result.rows)
   } catch (err) {
     client.release()
`;

  server.registerTool(
    'list_recent_commits',
    {
      description: 'Lists recent commits in the repository',
      inputSchema: { sinceMinutes: z.number().int().positive().max(1440).default(120) },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMinutes = 120 }) => {
      let result;
      if (isMock) {
        result = { commits: mockCommits };
      } else {
        result = { commits: [] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'github-mcp.list_recent_commits')) }]
      };
    }
  );

  server.registerTool(
    'get_commit_diff',
    {
      description: 'Returns the diff for a specific commit',
      inputSchema: { sha: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ sha }) => {
      let result;
      if (isMock) {
        if (sha === badSha) {
          result = { sha, message: 'perf: reuse client for order lookup', files: [{ path: 'src/routes/orders.js', patch: leakyDiff }] };
        } else {
          result = { sha, message: 'other commit', files: [] };
        }
      } else {
        result = { sha, message: '', files: [] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'github-mcp.get_commit_diff')) }]
      };
    }
  );

  server.registerTool(
    'trigger_rollback',
    {
      description: 'Triggers a rollback to a previous deploy via Render API. Destructive: requires human approval.',
      inputSchema: { toDeployId: z.string().min(1), reason: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ toDeployId, reason }) => {
      const rollbackDeployId = isMock ? 'dep-rollback-mock' : undefined;
      const result = { ok: true, rollbackDeployId, at: new Date().toISOString() };
      console.log(`[${name}] trigger_rollback EXECUTED — toDeployId: ${toDeployId}, reason: ${reason}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'github-mcp.trigger_rollback')) }]
      };
    }
  );

  server.registerTool(
    'create_fix_pr',
    {
      description: 'Creates a fix PR with the proposed changes. Destructive: requires human approval. (Stretch goal)',
      inputSchema: { title: z.string(), body: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })) },
      annotations: { destructiveHint: true },
    },
    async ({ title, body, files }) => {
      const result = { ok: true, prUrl: isMock ? 'https://github.com/owner/repo/pull/123' : undefined };
      console.log(`[${name}] create_fix_pr EXECUTED — title: ${title}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'github-mcp.create_fix_pr')) }]
      };
    }
  );

  return server;
}

createHttpServer(name, PORT, buildServer);