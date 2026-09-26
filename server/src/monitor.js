// Watches every service: health endpoint + Sentry error rate on a fixed interval.
// Opens an incident (and starts the agent) when a service crosses a threshold.
import { config } from './config.js';
import { adapters } from './integrations/index.js';
import { allServices, recordCheck, openIncidentFor, createIncident, addEvent, pruneSamples, pruneIncidents } from './store.js';
import { db } from './db.js';
import { checkHealth } from './health.js';
import { publish } from './events.js';
import { notify } from './notify.js';
import { startInvestigation } from './agent/runner.js';

// After an incident that ended without a verified fix, don't reopen one for the same
// service right away: a human owns it now.
const COOLDOWN_MIN = 15;
const lastError = new Map();

export async function checkService(service) {
  const { sentry } = adapters(service.workspaceId);
  const health = service.healthUrl ? await checkHealth(service.healthUrl) : null;

  let errorsPerMin = null;
  if (sentry && service.sentryProject) {
    try {
      errorsPerMin = await sentry.errorCount(service.sentryProject, new Date(Date.now() - 60_000).toISOString());
      lastError.delete(service.id);
    } catch (err) {
      if (lastError.get(service.id) !== err.message) console.warn(`[monitor] ${service.name}: ${err.message}`);
      lastError.set(service.id, err.message);
    }
  }

  const failedChecks = health && !health.healthy ? service.failedChecks + 1 : 0;
  // Slow = healthy response over the service's latency threshold (if it has one).
  const isSlow = !!(health?.healthy && service.latencyThresholdMs && health.latencyMs > service.latencyThresholdMs);
  const slowChecks = isSlow ? service.slowChecks + 1 : 0;
  const down = failedChecks >= config.monitor.failedChecksToAlert;
  const slow = slowChecks >= config.monitor.failedChecksToAlert;
  const spiking = errorsPerMin != null && errorsPerMin >= config.monitor.errorThresholdPerMin;
  const status = !health && errorsPerMin == null ? 'unknown' : down ? 'down' : spiking || failedChecks > 0 || slow ? 'degraded' : 'healthy';

  recordCheck(service.id, {
    status,
    release: health?.release,
    failedChecks,
    slowChecks,
    sample: { healthy: health?.healthy ?? null, latencyMs: health?.latencyMs ?? null, errorsPerMin, release: health?.release ?? null },
  });

  if ((down || spiking || slow) && !service.mutedUntil && !openIncidentFor(service.id) && !recentlyHandedOff(service.id)) {
    const title = spiking
      ? `Error spike on ${service.name}: ${errorsPerMin} errors/min${down ? ', health check failing' : ''}`
      : down
        ? `${service.name} health check failing: ${health.error}`
        : `Slow responses on ${service.name}: ${health.latencyMs}ms (threshold ${service.latencyThresholdMs}ms)`;
    const incident = createIncident({
      workspaceId: service.workspaceId,
      serviceId: service.id,
      title,
      signal: {
        errorsPerMin,
        threshold: config.monitor.errorThresholdPerMin,
        latencyMs: health?.latencyMs ?? null,
        latencyThresholdMs: service.latencyThresholdMs ?? null,
        health,
        failedChecks,
        slowChecks,
        release: health?.release ?? service.release,
      },
    });
    addEvent(incident.id, 'detected', `Incident detected: ${title}`, incident.signal);
    console.log(`[monitor] incident ${incident.id} on ${service.name}: ${title}`);
    notify(incident.id);
    startInvestigation(incident.id);
  }
  return status;
}

function recentlyHandedOff(serviceId) {
  const since = new Date(Date.now() - COOLDOWN_MIN * 60_000).toISOString();
  return !!db
    .prepare("SELECT 1 FROM incidents WHERE service_id = ? AND status IN ('needs_attention','rejected','failed','unresolved') AND resolved_at >= ? LIMIT 1")
    .get(serviceId, since);
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const services = allServices();
    await Promise.allSettled(services.map(checkService));
    for (const ws of new Set(services.map((s) => s.workspaceId))) publish(ws);
  } finally {
    ticking = false;
  }
}

export function startMonitor() {
  setInterval(tick, config.monitor.intervalSec * 1000);
  const prune = () => {
    pruneSamples();
    pruneIncidents(config.monitor.incidentRetentionDays);
  };
  setInterval(prune, 3600_000);
  prune();
  tick();
}
