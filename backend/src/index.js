// Entry point. Wires the store, the app, and the two background loops, then
// shuts all of it down cleanly on Ctrl-C — a rehearsal involves a lot of
// restarts, and a half-torn-down process holding a Neon connection is a bad way
// to lose five minutes.

import { config } from './config.js';
import { logger } from './logger.js';
import { getStore } from './store/index.js';
import { createApp } from './app.js';

const store = await getStore();
const { app, poller, sampler } = await createApp({ store });

const server = app.listen(config.port, () => {
  logger.info(`PEAK backend listening on http://localhost:${config.port}`);
  logger.info(`  incidents   POST/GET http://localhost:${config.port}/api/incidents`);
  logger.info(`  metrics     GET      http://localhost:${config.port}/api/metrics`);
  logger.info(`  demo reset  POST     http://localhost:${config.port}/api/demo/reset`);
  logger.info(`  health      GET      http://localhost:${config.port}/api/health`);
});

poller.start();
sampler.start();

// Housekeeping: a long rehearsal accumulates samples. Once an hour is plenty.
const pruneTimer = setInterval(() => store.prune().catch(() => {}), 60 * 60 * 1000);
pruneTimer.unref?.();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  poller.stop();
  sampler.stop();
  clearInterval(pruneTimer);
  server.close();
  try {
    await store.close();
  } catch (err) {
    logger.warn('store close failed', { err: err.message });
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// An unhandled rejection during a live demo means something is already broken;
// log it loudly and keep serving rather than dying silently on stage.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection (continuing)', { err: reason?.message ?? String(reason) });
});
