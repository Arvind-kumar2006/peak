#!/usr/bin/env node
/**
 * Scenario B at realistic demo volume.
 *
 * The smoke test proves the mechanism. This proves the NUMBERS are legible:
 * memory has to climb to a genuinely alarming share of the Render limit while
 * the incident is live, and then fall back under 60% once clear_cache runs —
 * because that crossing is exactly Scenario B's "resolved" bar in
 * contracts/scenarios.md. A memory signal that never approaches the limit, or
 * an RSS that refuses to fall after the fix, breaks the demo silently.
 *
 *   node test/scenario-b-volume.mjs [--rps 8] [--target 0.75]
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

async function loadDotEnv() {
  try {
    const raw = await readFile(join(here, '..', '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const v = m[2].replace(/^["'](.*)["']$/, '$1');
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* rely on real env */ }
}
await loadDotEnv();

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const ADMIN = process.env.ADMIN_TOKEN || 'change-me';
const RPS = Number(process.argv.includes('--rps') ? process.argv[process.argv.indexOf('--rps') + 1] : 8);
const TARGET_RATIO = Number(process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : 0.75);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { 'x-admin-token': ADMIN, ...(opts.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const metrics = async () => (await api('/metrics')).body;
const ratio = (m) => m.process.memoryMB / m.process.memoryLimitMB;
const pct = (m) => `${(ratio(m) * 100).toFixed(0)}% (${m.process.memoryMB}/${m.process.memoryLimitMB}MB)`;

console.log(`Scenario B volume test against ${BASE} at ${RPS} rps, target peak ${(TARGET_RATIO * 100).toFixed(0)}% of limit\n`);

await api('/admin/reset', { method: 'POST' });
const before = await metrics();
console.log(`baseline: ${pct(before)}  cache.entries=${before.cache.entries}  p95=${before.http.p95Ms}ms`);

await api('/admin/inject/mem-leak', { method: 'POST' });
console.log('injected mem-leak — driving traffic...\n');

let peak = before;
let peakAt = 0;
let elapsed = 0;

// Drive the cache-writing endpoint at the target rate. Earlier this test issued
// a couple of requests per tick and starved itself, which made the app look
// like it was not leaking when the test was simply too slow.
const rps = RPS;
const every = Math.round(1000 / rps);
const startAt = Date.now();
let nextLog = 10000;

const driver = (async () => {
  while (Date.now() - startAt < 300000) {
    if (ratio(await metrics()) >= TARGET_RATIO) break;
    await Promise.all([api('/summary'), api('/summary'), api('/products')]);
    await sleep(every);
  }
})();

while (ratio(peak) < TARGET_RATIO && elapsed < 300000) {
  await Promise.all([api('/summary'), api('/products')]);
  await sleep(every);
  elapsed = Date.now() - startAt;
  peak = await metrics();
  peakAt = elapsed;
  if (elapsed >= nextLog) {
    nextLog += 10000;
    console.log(`  t+${(elapsed / 1000).toFixed(0)}s  mem ${pct(peak)}  entries=${peak.cache.entries}  p95=${peak.http.p95Ms}ms  rss=${peak._diag.rssMB}MB`);
  }
}
await driver;

console.log(`\npeak: ${pct(peak)} after ${(peakAt / 1000).toFixed(0)}s  cache.entries=${peak.cache.entries}  p95=${peak.http.p95Ms}ms`);

const peakOk = ratio(peak) >= TARGET_RATIO;
const p95Ok = peak.http.p95Ms >= 40;
const underLimit = peak.process.memoryMB < peak.process.memoryLimitMB;
const notCritical = ratio(peak) < 0.9;

console.log(`\nINCIDENT VISIBLE?`);
console.log(`  ${peakOk ? 'PASS' : 'FAIL'}  memory reached ${(TARGET_RATIO * 100).toFixed(0)}% of the limit`);
console.log(`  ${p95Ok ? 'PASS' : 'FAIL'}  p95 latency is visibly degraded (${peak.http.p95Ms}ms, need >= 40ms)`);
console.log(`  ${notCritical ? 'PASS' : 'FAIL'}  peak stayed below 90% so Render will not OOM-kill us mid-demo`);
console.log(`  ${underLimit ? 'PASS' : 'FAIL'}  peak under the hard limit`);

console.log(`\nAPPLYING THE FIX — POST /admin/cache/clear`);
const t0 = Date.now();
const cc = await api('/admin/cache/clear', { method: 'POST' });
const clearMs = Date.now() - t0;
console.log(`  cleared ${cc.body.cleared} entries in ${clearMs}ms`);

// Let the rolling windows turn over so p95 reflects post-fix latency. The
// contract's errorRate/p95 windows are 60s, so recovery is not visible until
// the pre-fix samples have aged out — same as it will be during the real demo.
console.log('  waiting out the 60s rolling window...');
await sleep(62000);
const after = await metrics();

console.log(`\nRECOVERED?  ${pct(after)}  cache.entries=${after.cache.entries}  p95=${after.http.p95Ms}ms  rss=${after._diag.rssMB}MB`);
const memRecovered = ratio(after) < 0.6;
const p95Recovered = after.http.p95Ms <= peak.http.p95Ms / 2;
const entriesRecovered = after.cache.entries <= 5;

console.log(`  ${memRecovered ? 'PASS' : 'FAIL'}  memory back under 60% of limit — the contract's "resolved" bar`);
console.log(`  ${p95Recovered ? 'PASS' : 'FAIL'}  p95 recovered from ${peak.http.p95Ms}ms to ${after.http.p95Ms}ms`);
console.log(`  ${entriesRecovered ? 'PASS' : 'FAIL'}  cache.entries back to baseline (${after.cache.entries})`);

await api('/admin/reset', { method: 'POST' });

const allOk = peakOk && p95Ok && notCritical && memRecovered && p95Recovered && entriesRecovered;
console.log(`\n${allOk ? 'Scenario B numbers are demo-legible.' : 'Scenario B numbers need tuning.'}`);
process.exit(allOk ? 0 : 1);
