#!/usr/bin/env node
/**
 * Standalone load generator.
 *
 * The app generates its own traffic when TRAFFIC_ENABLED=on (the normal demo
 * path), but you sometimes need to drive load against an already-running
 * instance — for example to push a remote Render service into Scenario A
 * degradation right before a rehearsal.
 *
 *   node scripts/load.js --url https://peak-demo.onrender.com --rps 20 --path /orders
 *   node scripts/load.js --url http://localhost:3000 --rps 30 --duration 120
 */
import http from 'node:http';
import https from 'node:https';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg('url', process.env.DEMO_APP_URL || 'http://localhost:3000');
const rps = Number(arg('rps', '10'));
const durationSec = Number(arg('duration', '0'));
const path = arg('path', '/orders?limit=20&offset=0');
const workers = Number(arg('workers', String(rps)));

const target = new URL(path, url);
const client = target.protocol === 'https:' ? https : http;

console.log(`load -> ${target.href}  rps=${rps} workers=${workers} duration=${durationSec || 'until Ctrl-C'}s`);

let sent = 0;
let ok = 0;
let failed = 0;
let inFlight = 0;

function fire() {
  if (inFlight > workers * 2) return;
  inFlight += 1;
  sent += 1;
  const req = client.request(
    { hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname + target.search, method: 'GET', timeout: 10000 },
    (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode < 500) ok += 1;
        else failed += 1;
        inFlight -= 1;
      });
    },
  );
  req.on('error', () => {
    failed += 1;
    inFlight -= 1;
  });
  req.on('timeout', () => {
    req.destroy();
    failed += 1;
    inFlight -= 1;
  });
  req.end();
}

const everyMs = Math.max(10, Math.round(1000 / Math.max(0.1, rps)));
const timer = setInterval(fire, everyMs);

const reporter = setInterval(() => {
  console.log(`sent=${sent} ok=${ok} failed=${failed} inFlight=${inFlight}`);
}, 5000);

function stop(code = 0) {
  clearInterval(timer);
  clearInterval(reporter);
  console.log(`done. sent=${sent} ok=${ok} failed=${failed}`);
  process.exit(code);
}

if (durationSec > 0) setTimeout(() => stop(0), durationSec * 1000);
process.on('SIGINT', () => stop(0));
