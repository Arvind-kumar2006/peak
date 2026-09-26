// The incident-investigator AgentSpec. Model is filled in by trueforge-client (fallback order).
import { readFileSync } from 'node:fs';

export const AGENT_NAME = 'incident-investigator';

// MCP servers PEAK connects to (contracts/mcp-tools.md). Write tools are listed by name so the
// approval gate never depends on annotations being right.
export const MCP_SERVERS = [
  {
    name: 'db-mcp',
    url: process.env.DB_MCP_URL ?? 'http://localhost:7101/mcp',
    description: 'Postgres health: connection pool, idle-in-transaction backends, slow queries, lock waits',
    writeTools: [],
  },
  {
    name: 'cloud-mcp',
    url: process.env.CLOUD_MCP_URL ?? 'http://localhost:7102/mcp',
    description: 'Service status and deploys, live metrics and metric windows, Sentry errors, and remediation actions',
    writeTools: ['restart_service', 'scale_service', 'clear_cache'],
  },
  {
    name: 'github-mcp',
    url: process.env.GITHUB_MCP_URL ?? 'http://localhost:7103/mcp',
    description: 'Recent commits and diffs of the deployed repo, and rollback to a previous deploy',
    writeTools: ['trigger_rollback'],
    disableTools: ['create_fix_pr'], // stretch goal — keep the whitelist tight for the MVP
  },
  {
    name: 'report-mcp',
    url: process.env.REPORT_MCP_URL ?? 'http://localhost:7104/mcp',
    description: 'Submit the structured diagnosis and resolution reports',
    writeTools: [],
  },
];

export const WRITE_TOOLS = MCP_SERVERS.flatMap((s) => s.writeTools);

export function buildAgentSpec() {
  return {
    instructions: readFileSync(new URL('./instructions.md', import.meta.url), 'utf8'),
    mcp_servers: MCP_SERVERS.map((s) => ({
      name: s.name,
      preload: true,
      require_approval_for_tools: s.writeTools,
      ...(s.disableTools ? { disable_tools: s.disableTools } : {}),
    })),
    config: {
      iteration_limit: 40,
      dynamic_sub_agents: { enabled: false },
      ask_user_questions: { enabled: false },
      generative_ui: { enabled: false },
      web_search: { enabled: false },
    },
  };
}

// The scenario tag is deliberately NOT passed to the model: it must find the cause from evidence.
export const incidentPrompt = ({ description } = {}) =>
  `INCIDENT: ${description ?? 'Production alert: error rate and/or latency are elevated on the demo service.'}\n` +
  'Investigate, diagnose, and remediate following your runbook.';
