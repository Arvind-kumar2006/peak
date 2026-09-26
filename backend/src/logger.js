// Minimal structured logger. One line per event, JSON in production-ish mode
// so a rehearsal transcript is greppable, human-readable locally.
//
// P1's demo-app has its own logger; this is deliberately not shared because
// the two services log different things and coupling them would mean a change
// in one breaking the other's format mid-demo.

const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function emit(level, msg, fields) {
  const time = new Date().toISOString().slice(11, 23);
  const extra = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
  if (useColor) {
    process.stdout.write(
      `${COLORS[level] ?? ''}${time} ${level.toUpperCase().padEnd(5)}${RESET} ${msg}${extra}\n`,
    );
  } else {
    process.stdout.write(`${time} ${level.toUpperCase().padEnd(5)} ${msg}${extra}\n`);
  }
}

export const logger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
