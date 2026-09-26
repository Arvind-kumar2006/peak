import http from 'node:http';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * In-process background traffic.
 *
 * The demo has to show metrics moving with nobody clicking, and the load has to
 * come from the same process that serves the endpoints — otherwise Render's
 * single free instance and the app's own pool behaviour don't line up with what
 * the audience sees on screen.
 *
 * The path list is cycled rather than hit repeatedly because Scenario B needs
 * the cache-writing endpoint in the mix: traffic that only hits /orders never
 * populates the cache and the memory incident never starts.
 *
 * This deliberately does NOT hit /metrics or /admin/*, so it doesn't pollute
 * the very metrics it exists to move.
 */
let timer = null;
let inFlight = 0;
let sent = 0;
let cursor = 0;

const PATHS = config.traffic.paths
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

function hit(port, path) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', timeout: 5000 },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end();
  });
}

async function loop(port) {
  if (inFlight > 50) return; // don't self-inflict a queue during Scenario A
  inFlight += 1;
  sent += 1;
  const path = PATHS.length ? PATHS[cursor++ % PATHS.length] : '/';
  try {
    await hit(port, path);
  } finally {
    inFlight -= 1;
  }
}

export function startTraffic(port) {
  if (!config.traffic.enabled || timer) return;
  const everyMs = Math.max(50, Math.round(1000 / Math.max(0.1, config.traffic.rps)));
  timer = setInterval(() => {
    loop(port).catch(() => {});
  }, everyMs);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('traffic generator started', { rps: config.traffic.rps, paths: PATHS });
}

export function stopTraffic() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function trafficStats() {
  return { enabled: config.traffic.enabled, rps: config.traffic.rps, sent, inFlight, paths: PATHS };
}
