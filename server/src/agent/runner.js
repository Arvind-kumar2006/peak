// Runs the incident agent on TrueForge: start the investigation, park the incident when the
// fix pauses for approval, resume on the human's decision, and settle the final status.
import { config } from '../config.js';
import { kvOnce } from '../db.js';
import { token } from '../crypto.js';
import { providersFromEnv, modelRef } from './providers.js';
import { createClient } from './trueforge.js';
import { buildAgentSpec, incidentPrompt, MCP_SERVER_NAME } from './spec.js';
import { getIncident, getService, updateIncident, transition, addEvent, listEvents, incidentsInStatus } from '../store.js';
import { notify } from '../notify.js';
import { startVerification } from '../verify.js';
import { publish } from '../events.js';

export const mcpToken = kvOnce('mcp_token', () => token(24));

let tf = null;
export const agentStatus = { ready: false, providers: [], error: null };

const log = (...a) => console.log('[agent]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Register model providers and PEAK's MCP endpoint with TrueForge. Retries until TrueForge is up.
export async function initAgent() {
  try {
    const providers = providersFromEnv();
    tf = createClient({ baseUrl: config.trueforgeUrl, providers, log });
    agentStatus.providers = providers.map(modelRef);
  } catch (err) {
    agentStatus.error = err.message;
    log(err.message);
    return;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await tf.registerProviders();
      await tf.registerMcpServer({
        name: MCP_SERVER_NAME,
        url: `${config.serverUrl}/mcp/${mcpToken}`,
        description: 'PEAK: incident details, Sentry errors, GitHub commits and diffs, service health, diagnosis report, and revert_commit',
      });
      const tools = await tf.api('GET', `/mcp-servers/${MCP_SERVER_NAME}/tools`);
      log(`TrueForge ready — tools: ${tools.map((t) => t.name).join(', ')}`);
      Object.assign(agentStatus, { ready: true, error: null });
      await resumeAfterRestart();
      return;
    } catch (err) {
      agentStatus.error = `TrueForge not reachable at ${config.trueforgeUrl}: ${err.message}`;
      if (attempt === 1 || attempt % 12 === 0) log(agentStatus.error, '— retrying');
      await sleep(5000);
    }
  }
}

const saveAgent = (incidentId, patch) => {
  const current = getIncident(incidentId).agent ?? {};
  updateIncident(incidentId, { agent: { ...current, ...patch } });
};
const onTurn = (incidentId) => (turnId) => saveAgent(incidentId, { turnId });

function changed(incidentId) {
  publish(getIncident(incidentId).workspaceId);
  notify(incidentId);
}

function fail(incidentId, message) {
  const inc = transition(incidentId, ['investigating', 'awaiting_approval', 'fixing'], 'failed', { resolvedAt: new Date().toISOString() });
  saveAgent(incidentId, { error: message });
  addEvent(incidentId, 'agent.error', 'Agent stopped', { error: message });
  if (inc) changed(incidentId);
}

export function startInvestigation(incidentId) {
  run(incidentId).catch((err) => fail(incidentId, err.message));
}

async function run(incidentId) {
  if (!agentStatus.ready) throw new Error(agentStatus.error ?? 'Agent is not ready');
  const incident = getIncident(incidentId);
  const service = getService(incident.serviceId);
  const session = await tf.createSession(buildAgentSpec(), { incidentId });
  saveAgent(incidentId, { sessionId: session.id, sessionUrl: tf.sessionUrl(session), provider: agentStatus.providers[0] });
  addEvent(incidentId, 'agent', 'AI investigator started', { sessionId: session.id });
  publish(incident.workspaceId);
  const result = await tf.start(session, incidentPrompt(incident, service), { onTurn: onTurn(incidentId) });
  await settle(incidentId, session, result);
}

// Decide what the end of a turn means for the incident.
async function settle(incidentId, session, result) {
  saveAgent(incidentId, { provider: result.provider ?? getIncident(incidentId).agent?.provider });

  if (result.kind === 'approval') {
    const [pending] = (await tf.getPendingAction(session, result)) ?? [];
    const paused = { turnId: result.turnId, threadId: result.threadId, toolCalls: result.toolCalls };
    const inc = transition(incidentId, ['investigating'], 'awaiting_approval', { pendingAction: { ...pending, paused } });
    if (!inc) return;
    addEvent(incidentId, 'approval', 'Fix proposed: waiting for approval', { tool: pending?.tool, args: pending?.args });
    changed(incidentId);
    return;
  }

  const incident = getIncident(incidentId);
  const summary = typeof result.state?.output?.content === 'string' ? result.state.output.content : null;
  if (summary) saveAgent(incidentId, { summary });

  if (result.state?.status !== 'done') return fail(incidentId, result.state?.message ?? `Agent turn ended with status ${result.state?.status}`);

  if (incident.status === 'investigating') {
    if (!incident.diagnosis) return fail(incidentId, 'The agent finished without submitting a diagnosis');
    transition(incidentId, ['investigating'], 'needs_attention', { resolvedAt: new Date().toISOString() });
    addEvent(incidentId, 'needs_attention', incident.diagnosis.proposed_fix?.type === 'none' ? 'No safe automatic fix: handed to a human' : 'Agent did not apply its proposed fix');
    return changed(incidentId);
  }
  if (incident.status === 'fixing' && !incident.fix) {
    const toolError = listEvents(incidentId).findLast((e) => e.kind === 'agent.tool_error' && e.detail?.tool === 'revert_commit');
    return fail(incidentId, toolError ? `Revert failed: ${toolError.detail.error}` : 'The fix was approved but the agent did not apply it');
  }
  if (incident.status === 'fixing' && incident.fix) startVerification(incidentId);
  publish(incident.workspaceId);
}

// Human decision from the dashboard or Slack.
export async function decide(incidentId, { decision, by, reason }) {
  const incident = getIncident(incidentId);
  if (!incident) throw Object.assign(new Error('Incident not found'), { status: 404 });
  if (!tf) throw Object.assign(new Error('Agent is not configured'), { status: 503 });
  const approval = { decision: decision === 'approve' ? 'approved' : 'rejected', by, reason: reason || null, at: new Date().toISOString() };
  const to = decision === 'approve' ? 'fixing' : 'rejected';
  const inc = transition(incidentId, ['awaiting_approval'], to, { approval, ...(to === 'rejected' ? { resolvedAt: approval.at } : {}) });
  if (!inc) throw Object.assign(new Error(`Incident is ${incident.status}; nothing to ${decision}`), { status: 409 });
  addEvent(incidentId, 'approval', decision === 'approve' ? `Fix approved by ${by}` : `Fix rejected by ${by}`, approval);
  changed(incidentId);

  const session = await tf.loadSession(incident.agent.sessionId);
  const paused = { kind: 'approval', ...inc.pendingAction.paused };
  const resume = decision === 'approve'
    ? tf.approve(session, paused, { onTurn: onTurn(incidentId) })
    : tf.reject(session, paused, reason || `Rejected by ${by}`, { onTurn: onTurn(incidentId) });
  resume.then((result) => settle(incidentId, session, result)).catch((err) => (decision === 'approve' ? fail(incidentId, err.message) : log(err.message)));
  return inc;
}

// After a server restart: re-attach to turns still running and restart verifications.
async function resumeAfterRestart() {
  for (const inc of incidentsInStatus(['investigating', 'fixing', 'verifying'])) {
    if (inc.fix) {
      if (inc.status === 'verifying') transition(inc.id, ['verifying'], 'fixing');
      startVerification(inc.id);
      continue;
    }
    if (!inc.agent?.sessionId || !inc.agent?.turnId) {
      fail(inc.id, 'Server restarted before the investigation started');
      continue;
    }
    log(`re-attaching to incident ${inc.id} (turn ${inc.agent.turnId})`);
    (async () => {
      const session = await tf.loadSession(inc.agent.sessionId);
      const result = await tf.waitForTurn(session.id, inc.agent.turnId);
      await settle(inc.id, session, result);
    })().catch((err) => fail(inc.id, err.message));
  }
}

export const agentReady = () => agentStatus.ready;
