import * as Sentry from '@sentry/node';
import { config } from './config.js';
import { RELEASE } from './release.js';
import { logger } from './logger.js';

let enabled = false;

export function initSentry() {
  if (!config.sentry.dsn) {
    logger.warn('sentry disabled: SENTRY_DSN not set');
    return;
  }
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    // Ties every Sentry issue to a deploy. This is the link the agent follows
    // from "Sentry errors tagged a1b2c3d" to "commit a1b2c3d is the offender".
    release: RELEASE.full,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    attachStacktrace: true,
  });
  enabled = true;
  logger.info('sentry initialised', { environment: config.sentry.environment, release: RELEASE.short });
}

export function captureException(err, extra = {}) {
  if (!enabled) return;
  Sentry.captureException(err, {
    tags: {
      // Redundant with init({release}) but guarantees the tag survives even if
      // the event is created outside a request scope.
      release: RELEASE.short,
      service: 'peak-demo-app',
      ...(extra.tags || {}),
    },
    extra,
  });
}

export function isSentryEnabled() {
  return enabled;
}

export async function flushSentry(timeoutMs = 2000) {
  if (!enabled) return;
  await Sentry.flush(timeoutMs).catch(() => {});
}
