import { createMcpServer, createHttpServer, withMetadata, mockMode, mockScenario } from '../_shared/index.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 7102);
const name = 'cloud-mcp';

function buildServer() {
  const server = createMcpServer(name);

  const isMock = mockMode();
  const scenario = mockScenario;

  const badSha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  const goodSha = 'f0e1d2c3b4a59687789a0b1c2d3e4f5a6b7c8d9e';

  const mockServiceStatus = (scenario === 'A')
    ? { status: 'degraded', currentDeploy: { id: 'dep-bad', commitSha: badSha, createdAt: '2026-09-26T10:00:00Z' }, previousDeploy: { id: 'dep-good', commitSha: goodSha }, restartCount: 0 }
    : { status: 'degraded', currentDeploy: { id: 'dep-curr', commitSha: goodSha, createdAt: '2026-09-25T10:00:00Z' }, previousDeploy: { id: 'dep-prev', commitSha: 'prev-sha' }, restartCount: 2 };

  const mockMetricsBase = {
    timestamp: new Date().toISOString(),
    release: scenario === 'A' ? badSha : goodSha,
    http: { rpm: 240, errorRate: scenario === 'A' ? 0.42 : 0.004, p95Ms: scenario === 'A' ? 8500 : 120 },
    db: { pool: { max: 10, inUse: scenario === 'A' ? 10 : 3, idle: scenario === 'A' ? 0 : 7, waiting: scenario === 'A' ? 12 : 0 } },
    process: { memoryMB: scenario === 'B' ? 480 : 180, memoryLimitMB: 512 },
    cache: { entries: scenario === 'B' ? 950000 : 1200 }
  };

  const mockSentryErrors = (scenario === 'A')
    ? [{ title: 'TimeoutError: pool exhausted (10/10)', count: 247, firstSeen: '2026-09-26T10:05:00Z', lastSeen: '2026-09-26T10:15:00Z', release: badSha, culprit: 'orders.getOrders' }]
    : [];

  let windowSamples = [];

  function generateWindowSamples(s) {
    const samples = [];
    const now = Date.now();
    for (let i = 5; i >= 0; i--) {
      const ts = new Date(now - i * 10000).toISOString();
      if (s === 'A') {
        samples.push({
          timestamp: ts,
          release: badSha,
          http: { rpm: 240, errorRate: 0.42, p95Ms: 8500 },
          db: { pool: { max: 10, inUse: 10, idle: 0, waiting: 12 } },
          process: { memoryMB: 180, memoryLimitMB: 512 },
          cache: { entries: 1200 }
        });
      } else {
        samples.push({
          timestamp: ts,
          release: goodSha,
          http: { rpm: 240, errorRate: 0.004, p95Ms: 2100 },
          db: { pool: { max: 10, inUse: 3, idle: 7, waiting: 0 } },
          process: { memoryMB: 450 + i * 5, memoryLimitMB: 512 },
          cache: { entries: 800000 + i * 30000 }
        });
      }
    }
    return samples;
  }

  windowSamples = generateWindowSamples(scenario);

  server.registerTool(
    'get_service_status',
    {
      description: 'Returns current service status and deploy info',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      let result;
      if (isMock) {
        result = mockServiceStatus;
      } else {
        result = { status: 'unknown', currentDeploy: null, previousDeploy: null, restartCount: 0 };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'cloud-mcp.get_service_status')) }]
      };
    }
  );

  server.registerTool(
    'get_metrics',
    {
      description: 'Returns current metrics snapshot from the demo app',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      let result;
      if (isMock) {
        result = mockMetricsBase;
      } else {
        result = { timestamp: new Date().toISOString(), release: '', http: { rpm: 0, errorRate: 0, p95Ms: 0 }, db: { pool: { max: 10, inUse: 0, idle: 10, waiting: 0 } }, process: { memoryMB: 0, memoryLimitMB: 512 }, cache: { entries: 0 } };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'cloud-mcp.get_metrics')) }]
      };
    }
  );

  server.registerTool(
    'get_metrics_window',
    {
      description: 'Returns metrics samples over a time window for verification',
      inputSchema: { seconds: z.number().int().positive().max(300).default(60), intervalSec: z.number().int().positive().max(60).default(10) },
      annotations: { readOnlyHint: true },
    },
    async ({ seconds = 60, intervalSec = 10 }) => {
      let result;
      if (isMock) {
        result = { samples: windowSamples };
      } else {
        result = { samples: [] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'cloud-mcp.get_metrics_window')) }]
      };
    }
  );

  server.registerTool(
    'get_recent_errors',
    {
      description: 'Returns recent Sentry errors tagged with release SHA',
      inputSchema: { sinceMinutes: z.number().int().positive().max(1440).default(30) },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMinutes = 30 }) => {
      let result;
      if (isMock) {
        result = { issues: mockSentryErrors };
      } else {
        result = { issues: [] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'cloud-mcp.get_recent_errors')) }]
      };
    }
  );

  server.registerTool(
    'restart_service',
    {
      description: 'Restarts the demo service. Destructive: requires human approval.',
      inputSchema: { reason: z.string().describe('Why the restart is needed') },
      annotations: { destructiveHint: true },
    },
    async ({ reason }) => {
      const result = { ok: true, deployId: isMock ? 'dep-restart-mock' : undefined, at: new Date().toISOString() };
      console.log(`[${name}] restart_service EXECUTED — reason: ${reason}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'cloud-mcp.restart_service')) }]
      };
    }
  );

  server.registerTool(
    'scale_service',
    {
      description: 'Scales the demo service instances. Destructive: requires human approval.',
      inputSchema: { instances: z.number().int().min(1).max(3), reason: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ instances, reason }) => {
      const result = { ok: true, instances, at: new Date().toISOString() };
      console.log(`[${name}] scale_service EXECUTED — instances: ${instances}, reason: ${reason}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'cloud-mcp.scale_service')) }]
      };
    }
  );

  server.registerTool(
    'clear_cache',
    {
      description: 'Clears the in-process cache. Destructive: requires human approval.',
      inputSchema: { reason: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ reason }) => {
      const cleared = isMock ? 950000 : 0;
      const result = { ok: true, cleared, at: new Date().toISOString() };
      console.log(`[${name}] clear_cache EXECUTED — cleared: ${cleared}, reason: ${reason}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(withMetadata(result, 'cloud-mcp.clear_cache')) }]
      };
    }
  );

  return server;
}

createHttpServer(name, PORT, buildServer);