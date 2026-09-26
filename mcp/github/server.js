import { createMcpServer, createHttpServer, ok, notImplemented, mockMode } from '../_shared/index.js';
import { getState, recordAction, BAD_SHA, GOOD_SHA } from '../_shared/mockState.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 7103);
const name = 'github-mcp';

// Real diff of the Scenario A commit (5a824ff), so tuning on mocks matches the live demo.
const BAD_DIFF = readFileSync(new URL('./fixtures/scenario-a-bad-commit.diff', import.meta.url), 'utf8');

const minutesBefore = (iso, minutes) => new Date(Date.parse(iso) - minutes * 60_000).toISOString();

// Commit history relative to when the incident started. Scenario A: the bad commit landed
// 12 minutes before. Scenario B: nothing for over a day (the "quiet window" P1 asked for).
function mockCommits() {
  const state = getState();
  const history = [
    { sha: GOOD_SHA, message: 'docs(demo-app): README with run steps, verified scenario numbers, and per-owner handoff notes', author: 'praveen', minutesAgo: 26 * 60, filesChanged: ['demo-app/README.md'], diff: '' },
    { sha: '267f0460000000000000000000000000000000000', message: 'fix(db): never let a reaped connection kill the process, and reap orphans server-side', author: 'praveen', minutesAgo: 27 * 60, filesChanged: ['demo-app/src/db/pool.js', 'demo-app/src/reconciler.js'], diff: '' },
  ];
  if (state.scenario === 'A') {
    history.unshift({ sha: BAD_SHA, message: 'perf: reuse client for order lookup', author: 'praveen', minutesAgo: 12, filesChanged: ['demo-app/src/db/orders.js'], diff: BAD_DIFF });
  }
  return history.map(({ minutesAgo, ...c }) => ({ ...c, timestamp: minutesBefore(state.startedAt, minutesAgo) }));
}

function findCommit(sha) {
  const needle = sha.trim().toLowerCase();
  if (needle.length < 7) return null;
  return mockCommits().find((c) => c.sha.startsWith(needle)) ?? null;
}

function buildServer() {
  const server = createMcpServer(name);
  const isMock = mockMode();

  server.registerTool(
    'list_recent_commits',
    {
      description: 'Lists commits on the deployed branch within the last `sinceMinutes` minutes, newest first',
      inputSchema: { sinceMinutes: z.number().int().positive().max(1440 * 7).default(120) },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMinutes = 120 }) => {
      if (!isMock) return notImplemented('github-mcp.list_recent_commits');
      const cutoff = Date.now() - sinceMinutes * 60_000;
      const commits = mockCommits()
        .filter((c) => Date.parse(c.timestamp) >= cutoff)
        .map(({ diff, ...c }) => c);
      return ok({ sinceMinutes, commits }, 'github-mcp.list_recent_commits');
    }
  );

  server.registerTool(
    'get_commit_diff',
    {
      description: 'Returns the diff for a commit. Accepts a full SHA or a prefix of at least 7 characters',
      inputSchema: { sha: z.string().min(7) },
      annotations: { readOnlyHint: true },
    },
    async ({ sha }) => {
      if (!isMock) return notImplemented('github-mcp.get_commit_diff');
      const c = findCommit(sha);
      if (!c) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `no commit matching "${sha}"`, source: 'github-mcp.get_commit_diff' }) }] };
      }
      const files = c.filesChanged.map((path) => ({ path, patch: c.diff }));
      return ok({ sha: c.sha, message: c.message, author: c.author, timestamp: c.timestamp, files }, 'github-mcp.get_commit_diff');
    }
  );

  server.registerTool(
    'trigger_rollback',
    {
      description: 'Rolls the service back to a previous deploy via the Render API (use previousDeploy.id from get_service_status). Destructive: requires human approval.',
      inputSchema: { toDeployId: z.string().min(1), reason: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ toDeployId, reason }) => {
      if (!isMock) return notImplemented('github-mcp.trigger_rollback');
      const known = getState().scenario === 'A' ? ['dep-good'] : ['dep-older'];
      if (!known.includes(toDeployId)) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `unknown or invalid rollback target "${toDeployId}"`, validTargets: known }) }] };
      }
      console.log(`[${name}] trigger_rollback EXECUTED — toDeployId: ${toDeployId}, reason: ${reason}`);
      recordAction('trigger_rollback', { toDeployId, reason });
      return ok({ ok: true, rollbackDeployId: 'dep-rollback-1', at: new Date().toISOString() }, 'github-mcp.trigger_rollback');
    }
  );

  server.registerTool(
    'create_fix_pr',
    {
      description: 'Creates a fix PR with the proposed changes. Destructive: requires human approval. (Stretch goal)',
      inputSchema: { title: z.string(), body: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })) },
      annotations: { destructiveHint: true },
    },
    async ({ title }) => {
      console.log(`[${name}] create_fix_pr EXECUTED — title: ${title}`);
      if (!isMock) return notImplemented('github-mcp.create_fix_pr');
      return ok({ ok: true, prUrl: 'https://github.com/Arvind-kumar2006/Peak/pull/999' }, 'github-mcp.create_fix_pr');
    }
  );

  return server;
}

createHttpServer(name, PORT, buildServer);
