import v8 from 'node:v8';
import vm from 'node:vm';

/**
 * Best-effort forced garbage collection.
 *
 * Scenario B's "resolved" bar is `process.memoryMB` dropping back under 60% of
 * the limit. We report real RSS, and RSS does not fall on its own when a few
 * hundred MB of large strings become garbage — V8 will get there eventually, but
 * not on the timescale the demo needs. Each entry is large enough to land in
 * V8's large-object space, so a major GC genuinely reclaims it; we just have to
 * ask for one at the right moment.
 *
 * --expose-gc gives us global.gc directly (see package.json "start"). The vm
 * fallback covers `node src/index.js` without the flag.
 */
let resolved;

export function forceGC() {
  try {
    if (typeof global.gc === 'function') {
      global.gc();
      return true;
    }
    if (resolved === undefined) {
      v8.setFlagsFromString('--expose-gc');
      resolved = vm.runInNewContext('gc');
      v8.setFlagsFromString('--no-expose-gc');
    }
    resolved();
    return true;
  } catch {
    return false;
  }
}
