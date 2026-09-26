// Standalone migration runner: `npm run migrate`.
//
// The schema is also applied on boot, so this is only needed when you want to
// apply it without starting the server.

import { config } from '../config.js';
import { logger } from '../logger.js';
import { getStore } from './index.js';

if (!config.store.url) {
  logger.error('no PEAK_DATABASE_URL or DATABASE_URL set — nothing to migrate.');
  logger.error('the backend will run on the in-memory store instead.');
  process.exit(1);
}

const store = await getStore();
logger.info('migration complete', { store: store.kind });
await store.close();
