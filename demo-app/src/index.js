import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { RELEASE, uptimeSec } from './release.js';
import { initSentry, flushSentry } from './sentry.js';
import { getPool, closePool } from './db/pool.js';
import { startReconciler, stopReconciler } from './reconciler.js';
import { startTraffic, stopTraffic, trafficStats } from './traffic.js';

if (!config.databaseUrl) {
  logger.error('DATABASE_URL is required — copy .env.example to .env and fill it in');
  process.exit(1);
}

initSentry();

// Fail fast and loudly if the DB is unreachable: a demo app that boots but
// cannot serve traffic is worse than one that refuses to start.
try {
  const pool = getPool();
  const client = await pool.connect();
  await client.query('SELECT 1');
  client.release();
  logger.info('database reachable', { max: pool.options.max });
} catch (err) {
  logger.error('database unreachable', { error: err.message });
  process.exit(1);
}

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  logger.info('demo-app listening', {
    port: config.port,
    host: config.host,
    release: RELEASE.short,
    env: config.sentry.environment,
  });
  startReconciler();
  startTraffic(config.port);
});

// Render sends SIGTERM on deploy and rollback. Exiting cleanly matters: a crash
// loop during a rollback would wreck the very recovery we are demoing.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal, uptimeSec: uptimeSec() });
  stopReconciler();
  stopTraffic();
  server.close();
  await closePool();
  await flushSentry();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { error: String(reason?.message || reason) });
});

process.on('exit', () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'exit', traffic: trafficStats() }));
});
