import { RELEASE } from './release.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 20;

/**
 * Structured JSON lines. Two reasons:
 *  1. Every line carries the release SHA, which is the evidence the agent needs
 *     to tie Sentry errors to a deploy.
 *  2. Render's log search is substring-based, so distinctive messages like
 *     "pool exhausted (10/10)" are greppable mid-demo.
 */
function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    release: RELEASE.short,
    instance: RELEASE.instanceId,
    msg,
    ...fields,
  };
  const stream = LEVELS[level] >= LEVELS.error ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
