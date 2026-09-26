import { createMcpServer, createHttpServer, withMetadata, mockMode, mockScenario } from '../_shared/index.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 7101);
const name = 'db-mcp';

function buildServer() {
  const server = createMcpServer(name);

  const isMock = mockMode();
  const scenario = mockScenario;

  const mockPoolStats = (scenario === 'A')
    ? { max: 10, inUse: 10, idle: 0, waiting: 12, idleInTransaction: 8 }
    : { max: 10, inUse: 3, idle: 7, waiting: 0, idleInTransaction: 1 };

  const mockSlowQueries = [
    { query: 'SELECT * FROM orders WHERE user_id = $1', meanMs: 2450, calls: 120 },
    { query: 'SELECT * FROM products WHERE category = $1', meanMs: 1800, calls: 85 },
  ];

  const mockLockWaits = (scenario === 'A')
    ? [{ pid: 1234, waitingOn: 5678, durationMs: 5200, query: 'SELECT * FROM orders WHERE user_id = $1 FOR UPDATE' }]
    : [];

  server.registerTool(
    'get_pool_stats',
    {
      description: 'Returns current database connection pool statistics',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      let result;
      if (isMock) {
        result = mockPoolStats;
      } else {
        result = { max: 0, inUse: 0, idle: 0, waiting: 0, idleInTransaction: 0 };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'db-mcp.get_pool_stats')) }]
      };
    }
  );

  server.registerTool(
    'get_slow_queries',
    {
      description: 'Returns slowest queries from pg_stat_statements',
      inputSchema: { limit: z.number().int().positive().max(20).default(5) },
      annotations: { readOnlyHint: true },
    },
    async ({ limit = 5 }) => {
      let result;
      if (isMock) {
        result = { queries: mockSlowQueries.slice(0, limit) };
      } else {
        result = { queries: [] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'db-mcp.get_slow_queries')) }]
      };
    }
  );

  server.registerTool(
    'get_lock_waits',
    {
      description: 'Returns current lock waits from pg_locks',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      let result;
      if (isMock) {
        result = { waits: mockLockWaits };
      } else {
        result = { waits: [] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'db-mcp.get_lock_waits')) }]
      };
    }
  );

  return server;
}

createHttpServer(name, PORT, buildServer);