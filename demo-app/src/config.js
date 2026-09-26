const num = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const bool = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v));
};

export const config = {
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL || '',
  adminToken: process.env.ADMIN_TOKEN || 'change-me',

  pool: {
    // 10 matches contracts/demo-app-api.md. Do not change without a contract PR.
    max: num(process.env.POOL_MAX, 10),
    // Without this a saturated pool hangs requests forever and we never see the
    // 500s that make Scenario A legible. 2s keeps the symptom chain quick.
    connectionTimeoutMillis: num(process.env.POOL_CONNECT_TIMEOUT_MS, 2000),
    idleTimeoutMillis: num(process.env.POOL_IDLE_TIMEOUT_MS, 10000),
    // Server-side reaper for transactions stranded by a killed process.
    //
    // Must stay comfortably ABOVE POOL_MAX * RECONCILE_INTERVAL_SEC (60s), which
    // is how long Scenario A takes to saturate the pool. At 60s the reaper would
    // start killing connections just as the incident peaks, which would flap the
    // metrics and muddy the evidence the agent is about to reason over. This
    // timeout exists to clean up orphans left behind by a dead process, not to
    // interfere with a live one. 5 minutes is well clear of a Render rollback.
    idleInTransactionTimeoutMs: num(process.env.IDLE_IN_TRANSACTION_TIMEOUT_MS, 300000),
  },

  windows: {
    // contracts/demo-app-api.md says errorRate is a fraction over the last 60s.
    // 60s is the contract default; the knob exists because 60s rolling + 60s
    // stability means "resolved" can take ~2min to declare. See README.
    errorRateSec: num(process.env.ERROR_RATE_WINDOW_SEC, 60),
    latencySec: num(process.env.LATENCY_WINDOW_SEC, 60),
  },

  // Mirrors the Render instance memory so `process.memoryMB` is judged against
  // the limit that would actually OOM us.
  memoryLimitMB: num(process.env.MEMORY_LIMIT_MB, 512),

  reconcile: {
    // Background page scan. Leaks one client per tick when the batch path is
    // buggy, so this sets how fast Scenario A saturates the pool.
    intervalSec: num(process.env.RECONCILE_INTERVAL_SEC, 6),
    pages: num(process.env.RECONCILE_PAGES, 3),
  },

  cache: {
    // Healthy cache is bounded; injected growth is not.
    maxEntries: num(process.env.CACHE_MAX_ENTRIES, 2000),
    // 512KB per entry is a chunky cached payload, but it is what makes memory
    // visibly climb to ~75% of a 512MB instance within ~2 minutes of demo
    // traffic. Small entries would move cache.entries without moving
    // process.memoryMB, and the memory evidence would be theatre.
    entryKB: num(process.env.CACHE_ENTRY_KB, 512),
    growEveryN: num(process.env.CACHE_GROWTH_EVERY_N, 1),
    // Ceiling on the simulated GC pause so Scenario B degrades visibly without
    // turning the demo into a full outage.
    maxLatencyPenaltyMs: num(process.env.CACHE_MAX_PENALTY_MS, 400),
  },

  traffic: {
    enabled: bool(process.env.TRAFFIC_ENABLED, false),
    rps: num(process.env.TRAFFIC_RPS, 10),
    // Cycled round-robin. Half the traffic must hit /summary — it is the only
    // cache-writing endpoint, so an /orders-only mix never starts the Scenario B
    // memory climb. At 10 rps that is ~5 cache writes/s and peak memory in
    // roughly 2.5 minutes, which is the pacing a narrated demo wants.
    paths: process.env.TRAFFIC_PATHS
      || '/orders?limit=20&offset=0,/summary,/products?limit=20,/summary',
  },

  sentry: {
    dsn: process.env.SENTRY_DSN || '',
    environment: process.env.SENTRY_ENVIRONMENT || (process.env.RENDER ? 'production' : 'local'),
  },

  logLevel: process.env.LOG_LEVEL || 'info',
};

export const scenarios = ['conn-leak', 'mem-leak'];
