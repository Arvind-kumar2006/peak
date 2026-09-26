// The incident-investigator AgentSpec. The model is filled in by the TrueForge client
// (provider fallback order); the MCP server is this PEAK server's /mcp endpoint.
import { readFileSync } from 'node:fs';
import { config } from '../config.js';

// Unique per PEAK server, so two servers sharing one TrueForge (e.g. dev + a test instance)
// don't overwrite each other's MCP registration.
export const MCP_SERVER_NAME = process.env.PEAK_MCP_NAME || `peak-${config.port}`;
// Listed by name so the approval gate never depends on tool annotations being right.
export const WRITE_TOOLS = ['revert_commit', 'apply_patch'];

export function buildAgentSpec() {
  return {
    instructions: readFileSync(new URL('./instructions.md', import.meta.url), 'utf8'),
    mcp_servers: [{ name: MCP_SERVER_NAME, preload: true, require_approval_for_tools: WRITE_TOOLS }],
    config: {
      iteration_limit: 30,
      dynamic_sub_agents: { enabled: false },
      ask_user_questions: { enabled: false },
      generative_ui: { enabled: false },
      web_search: { enabled: false },
    },
  };
}

export const incidentPrompt = (incident, service) =>
  `INCIDENT ${incident.id}\n` +
  `Service: ${service.name}\n` +
  `Alert: ${incident.title}\n` +
  `Started: ${incident.startedAt}\n\n` +
  `Investigate, diagnose and remediate following your runbook. incident_id = "${incident.id}".`;
