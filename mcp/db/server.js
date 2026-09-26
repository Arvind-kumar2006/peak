import { createMcpServer, createHttpServer, ok, notImplemented, mockMode } from '../_shared/index.js';
import { getState, metricsAt, effectOf } from '../_shared/mockState.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 7101);
const name = 'db-mcp';

// Mock pool view. Scenario A's leak holds clients inside an open transaction that is
// never committed, so pg_stat_activity shows them as `idle in transaction` (P1's design).
function mockPoolStats() {
  const state = getState();
  const { pool } = metricsAt(state).db;
  const leaking = state.scenario === 'A' && effectOf(state) !== 'fixed';
  return { ...pool, idleInTransaction: leaking ? Math.max(0, pool.inUse - 1) : 0 };
}

// The leaked transactions show up as long-running reconcile queries; nothing is slow otherwise.
function mockSlowQueries(limit) {
  const { idleInTransaction } = mockPoolStats();
  if (idleInTransaction === 0) return [];
  return [
    {
      query: 'SELECT id, status, total_cents FROM orders ORDER BY created_at DESC LIMIT $1',
      meanMs: 4,
      calls: 310,
      note: `${idleInTransaction} backends idle in transaction after this query (transaction opened, never committed)`,
    },
  ].slice(0, limit);
}

function buildServer() {
  const server = createMcpServer(name);
  const isMock = mockMode();

  server.registerTool(
    'get_pool_stats',
    {
      description: 'Returns current database connection pool statistics, including backends stuck `idle in transaction`',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => (isMock ? ok(mockPoolStats(), 'db-mcp.get_pool_stats') : notImplemented('db-mcp.get_pool_stats'))
  );

  server.registerTool(
    'get_slow_queries',
    {
      description: 'Returns slowest / long-running queries from pg_stat_activity and pg_stat_statements',
      inputSchema: { limit: z.number().int().positive().max(20).default(5) },
      annotations: { readOnlyHint: true },
    },
    async ({ limit = 5 }) =>
      isMock ? ok({ queries: mockSlowQueries(limit) }, 'db-mcp.get_slow_queries') : notImplemented('db-mcp.get_slow_queries')
  );

  server.registerTool(
    'get_lock_waits',
    {
      description: 'Returns current lock waits from pg_locks',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    // The demo app takes no explicit locks; neither scenario produces lock waits.
    async () => (isMock ? ok({ waits: [] }, 'db-mcp.get_lock_waits') : notImplemented('db-mcp.get_lock_waits'))
  );

  return server;
}

createHttpServer(name, PORT, buildServer);
