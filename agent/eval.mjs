// Accuracy eval: run each scenario N times per provider, check the agent against the
// expected diagnosis, action, and verdict (contracts/scenarios.md). Needs MCP servers in MOCK=1.
//
//   node eval.mjs [--runs 10] [--providers openai,xai] [--scenarios A,B]
//
// Each provider is evaluated on its own (no fallback), since Grok must pass by itself.
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { providersFromEnv, modelRef } from './lib/providers.mjs';
import { createClient } from './lib/trueforge-client.mjs';
import { runIncident } from './run-incident.mjs';

const { values: opts } = parseArgs({
  options: {
    runs: { type: 'string', default: '10' },
    providers: { type: 'string' },
    scenarios: { type: 'string', default: 'A,B' },
  },
});

// Expected outcomes per scenario. `acceptable` actions pass but are flagged.
const EXPECT = {
  A: { category: 'code', commitPrefix: '5a824ff', actions: ['trigger_rollback'], verdict: 'resolved' },
  B: { category: 'infra', commitPrefix: null, actions: ['clear_cache', 'restart_service'], verdict: 'resolved' },
};

function grade(scenario, r) {
  const e = EXPECT[scenario];
  const d = r.diagnosis;
  const checks = {
    paused: r.paused,
    diagnosis: Boolean(d),
    category: d?.rootCause.category === e.category,
    commit: e.commitPrefix ? Boolean(d?.rootCause.commitSha?.startsWith(e.commitPrefix)) : !d?.rootCause.commitSha,
    evidence: (d?.evidence?.length ?? 0) >= 3,
    action: e.actions.includes(r.pending?.[0]?.tool),
    argsMatch: Boolean(d && r.pending?.[0] && d.proposedFix.action === r.pending[0].tool),
    verdict: r.resolution?.verdict === e.verdict,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

if (opts.providers) process.env.MODEL_PROVIDERS = opts.providers;
const providers = providersFromEnv();
const runs = Number(opts.runs);
const scenarios = opts.scenarios.split(',');
const results = [];

for (const provider of providers) {
  const tf = createClient({ providers: [provider], log: () => {} });
  await tf.registerProviders();
  for (const scenario of scenarios) {
    for (let i = 1; i <= runs; i++) {
      let r;
      try {
        r = await runIncident({ tf, scenario, log: () => {} });
      } catch (err) {
        r = { error: err.message };
      }
      const g = r.error ? { pass: false, checks: { error: r.error } } : grade(scenario, r);
      results.push({ provider: modelRef(provider), scenario, run: i, ...g, secondsToApproval: r.secondsToApproval, secondsTotal: r.secondsTotal, sessionId: r.sessionId, action: r.pending?.[0]?.tool, verdict: r.resolution?.verdict });
      const failed = Object.entries(g.checks).filter(([, v]) => v !== true).map(([k, v]) => (typeof v === 'string' ? `${k}: ${v}` : k));
      console.log(`${g.pass ? '✓' : '✗'} ${modelRef(provider)} ${scenario} #${i}  ${r.pending?.[0]?.tool ?? '-'} → ${r.resolution?.verdict ?? '-'}  ${r.secondsToApproval?.toFixed(1) ?? '-'}s${failed.length ? `  FAILED: ${failed.join(', ')}` : ''}`);
    }
  }
}

console.log('\nprovider                 scenario  pass      avg s to approval');
for (const provider of new Set(results.map((r) => r.provider))) {
  for (const scenario of scenarios) {
    const rs = results.filter((r) => r.provider === provider && r.scenario === scenario);
    const passed = rs.filter((r) => r.pass).length;
    const avg = rs.filter((r) => r.secondsToApproval).reduce((s, r) => s + r.secondsToApproval, 0) / (rs.length || 1);
    console.log(`${provider.padEnd(24)} ${scenario.padEnd(9)} ${`${passed}/${rs.length}`.padEnd(9)} ${avg.toFixed(1)}`);
  }
}

mkdirSync(new URL('./eval-results/', import.meta.url), { recursive: true });
const file = new URL(`./eval-results/eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`\nSaved ${file.pathname}`);
const target = 0.9;
const worst = Math.min(...[...new Set(results.map((r) => `${r.provider}|${r.scenario}`))].map((k) => {
  const rs = results.filter((r) => `${r.provider}|${r.scenario}` === k);
  return rs.filter((r) => r.pass).length / rs.length;
}));
console.log(worst >= target ? `✓ Meets the PRD target (≥ ${target * 100}% per scenario per provider)` : `✗ Below the PRD target of ${target * 100}% per scenario per provider`);
process.exit(worst >= target ? 0 : 1);
