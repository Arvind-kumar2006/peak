/**
 * Injected fault flags. `POST /admin/inject/:scenario` flips these;
 * `POST /admin/reset` clears them. State lives in memory, which is deliberate:
 * a restart or a rollback genuinely wipes it, so `restart_service` and
 * `trigger_rollback` behave differently — which is the whole point of the
 * Scenario A trap.
 */
export const faults = {
  /** Scenario A: reconciler uses the batched page scan (the leaky path). */
  connLeak: false,
  /** Scenario B: cache grows unbounded instead of evicting. */
  cacheGrowth: false,
  /** When each fault was injected — becomes the incident window. */
  injectedAt: {},
  /** How many times a fault was injected, for the reset log line. */
  count: {},
};

export const SCENARIOS = ['conn-leak', 'mem-leak'];

/**
 * Scenario name -> the flag each one controls.
 *
 * The hyphenated contract names cannot be used as flag keys directly: writing
 * faults['conn-leak'] would create a key nothing reads, and the fault would
 * silently never activate. Everything goes through this map.
 */
export const SCENARIO_FLAGS = {
  'conn-leak': 'connLeak',
  'mem-leak': 'cacheGrowth',
};

export function inject(scenario) {
  const flag = SCENARIO_FLAGS[scenario];
  if (!flag) throw new Error(`unknown scenario: ${scenario}`);
  const at = new Date().toISOString();
  faults[flag] = true;
  faults.injectedAt[scenario] = at;
  faults.count[scenario] = (faults.count[scenario] || 0) + 1;
  return { injected: scenario, at };
}

export function clearFaults() {
  const cleared = Object.entries(SCENARIO_FLAGS)
    .filter(([, flag]) => faults[flag] === true)
    .map(([scenario]) => scenario);
  for (const flag of Object.values(SCENARIO_FLAGS)) faults[flag] = false;
  return cleared;
}
