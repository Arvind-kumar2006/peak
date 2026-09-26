import { config } from './config.js';
import { faults } from './faults.js';
import { logger } from './logger.js';
import { forceGC } from './gc.js';

/**
 * A real, bounded application cache holding pre-serialised response payloads.
 *
 * In healthy mode it evicts oldest-first at CACHE_MAX_ENTRIES. Under Scenario B
 * eviction is disabled, so entries accumulate and live memory climbs the way a
 * genuine leak does.
 */
const cache = new Map();

let inserted = 0;

/** Bytes of payload currently retained by the cache, tracked for logging only. */
let cacheBytes = 0;

function evictIfNeeded() {
  if (cache.size <= config.cache.maxEntries) return;
  const overflow = cache.size - config.cache.maxEntries;
  let i = 0;
  for (const [key, value] of cache) {
    if (i >= overflow) break;
    cacheBytes -= value.byteLength;
    cache.delete(key);
    i += 1;
  }
}

export function getCached(key) {
  // Under injected growth the cache never serves a hit. Without this, a warm
  // cache short-circuits every request before it reaches putCached, and the
  // memory incident silently never starts — Scenario B would fire or not fire
  // depending on cache warmth, which is exactly the kind of non-determinism
  // that kills a live demo.
  if (faults.cacheGrowth) return undefined;

  const hit = cache.get(key);
  if (!hit) return undefined;
  try {
    return JSON.parse(hit.toString('utf8'));
  } catch {
    // Never serve a corrupt entry.
    return undefined;
  }
}

/** Bounded write — the normal path. */
export function putCached(key, value) {
  if (faults.cacheGrowth) return growOne();
  const payload = Buffer.from(JSON.stringify(value));
  cache.set(key, payload);
  cacheBytes += payload.byteLength;
  evictIfNeeded();
  return false;
}

/**
 * Unbounded write with a real, committed allocation behind it.
 *
 * This MUST allocate a Buffer and write into it. The obvious
 * `'x'.repeat(CACHE_ENTRY_KB * 1024)` is a V8 cons-string rope: 150MB of
 * "strings" that cost ~2MB of RSS and never touch a page. That version moves
 * cache.entries while process.memoryMB stays flat, and the whole Scenario B
 * evidence chain quietly becomes a lie. `allocUnsafe` + `fill` commits real
 * pages, so the metric tracks reality.
 *
 * Each entry is a single large allocation, which Node backs with its own
 * mapping — so releasing the last reference hands the memory back rather than
 * leaving it stranded on the allocator's free list.
 */
function growOne() {
  const bytes = config.cache.entryKB * 1024;
  const payload = Buffer.allocUnsafe(bytes);
  payload.fill(0x78);
  cache.set(`inflight:${inserted}`, payload);
  cacheBytes += bytes;
  inserted += 1;
  if (inserted % 50 === 0) {
    logger.warn('cache growing without eviction', {
      entries: cache.size,
      retainedMB: Number((cacheBytes / 1048576).toFixed(1)),
    });
  }
  return true;
}

export function cacheSize() {
  return cache.size;
}

export function cacheBytesMB() {
  return Number((cacheBytes / 1048576).toFixed(1));
}

export function clearCache() {
  const cleared = cache.size;
  cache.clear();
  inserted = 0;
  cacheBytes = 0;
  // Ask for a major GC so the memory figure reflects the drop immediately.
  // Without this the Scenario B "below 60% of limit" bar can sit unmet for
  // minutes after the real fix has already run.
  forceGC();
  return cleared;
}

/**
 * Simulated GC pressure: latency climbs with cache size, which is what turns
 * Scenario B from "a memory number went up" into "users feel it". Tuned so the
 * p95 spike is obvious within a minute or two of demo traffic.
 */
export function cacheLatencyPenaltyMs() {
  if (!faults.cacheGrowth) return 0;
  return Math.min(config.cache.maxLatencyPenaltyMs, Math.round(cache.size / 8));
}
