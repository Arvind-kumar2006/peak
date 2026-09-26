// Run one incident end to end from the terminal — the same calls P4's backend makes.
//
//   node run-incident.mjs [--scenario A|B] [--decision allow|deny] [--description "..."]
//
// --scenario resets the mock world first (MCP servers in MOCK=1). Prereqs: TrueForge,
// MCP servers, report-mcp running and `npm run setup` done.
import { parseArgs } from 'node:util';
import { providersFromEnv } from './lib/providers.mjs';
import { createClient } from './lib/trueforge-client.mjs';
import { buildAgentSpec, incidentPrompt } from './agent-spec.mjs';

const MOCK_CONTROL_URL = process.env.MOCK_CONTROL_URL ?? 'http://localhost:7101/mock/state';

export async function runIncident({ tf, scenario, decision = 'allow', description, log = console.log }) {
  if (scenario) {
    const res = await fetch(MOCK_CONTROL_URL, { method: 'POST', body: JSON.stringify({ scenario }) });
    if (!res.ok) throw new Error(`mock reset failed: ${res.status} (are the MCP servers running with MOCK=1?)`);
  }
  const t0 = Date.now();
  const session = await tf.createSession(buildAgentSpec(), { incidentId: `inc-${Date.now()}`, ...(scenario ? { scenario } : {}) });
  log(`session: ${tf.sessionUrl(session)}`);

  const paused = await tf.start(session, incidentPrompt({ description }));
  const { diagnosis } = await tf.getReports(session.id);
  const pending = await tf.getPendingAction(session, paused);
  const tApproval = Date.now();

  let done = paused;
  if (paused.kind === 'approval') {
    log(`awaiting approval (${((tApproval - t0) / 1000).toFixed(1)}s): ${pending.map((p) => `${p.server}.${p.tool}(${JSON.stringify(p.args)})`).join(', ')}`);
    done = decision === 'allow' ? await tf.approve(session, paused) : await tf.reject(session, paused, 'Rejected by operator');
  }
  const { resolution } = await tf.getReports(session.id);
  return {
    sessionId: session.id,
    provider: done.provider,
    paused: paused.kind === 'approval',
    pending,
    diagnosis,
    resolution,
    finalState: done.state?.status ?? null,
    finalMessage: done.state?.output?.content ?? null,
    secondsToApproval: (tApproval - t0) / 1000,
    secondsTotal: (Date.now() - t0) / 1000,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: opts } = parseArgs({
    options: {
      scenario: { type: 'string' },
      decision: { type: 'string', default: 'allow' },
      description: { type: 'string' },
    },
  });
  const tf = createClient({ providers: providersFromEnv() });
  const r = await runIncident({ tf, scenario: opts.scenario, decision: opts.decision, description: opts.description });
  const d = r.diagnosis;
  console.log('\n── Diagnosis');
  if (d) {
    console.log(`${d.summary}\n  category: ${d.rootCause.category}  confidence: ${d.rootCause.confidence}  commit: ${d.rootCause.commitSha ?? '—'}`);
    for (const e of d.evidence) console.log(`  • [${e.tool}] ${e.claim}: ${e.observation}`);
    console.log(`  fix: ${d.proposedFix.action} ${JSON.stringify(d.proposedFix.args)} (${d.proposedFix.expectedOutcome})`);
  } else console.log('  (no submit_diagnosis call)');
  console.log('\n── Resolution');
  console.log(r.resolution ? `  ${r.resolution.verdict}: ${r.resolution.reasoning}\n  follow-up: ${r.resolution.followUp}` : '  (no submit_resolution call)');
  console.log(`\n── ${r.finalState} on ${r.provider} in ${r.secondsTotal.toFixed(1)}s (approval requested after ${r.secondsToApproval.toFixed(1)}s)`);
  console.log(r.finalMessage ?? '');
}
