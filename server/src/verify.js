// After the fix: wait until the service runs the revert (when it reports its release),
// then watch health and error rate for a window. Resolved only if it stays clean.
import { config } from './config.js';
import { adapters } from './integrations/index.js';
import { getIncident, getService, listSamples, updateIncident, addEvent, transition } from './store.js';
import { checkHealth, sameCommit } from './health.js';
import { publish } from './events.js';
import { notify } from './notify.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = new Set();
const POLL_MS = 5000;

export function startVerification(incidentId) {
  if (running.has(incidentId)) return;
  running.add(incidentId);
  verify(incidentId)
    .catch(async (err) => {
      await addEvent(incidentId, 'verify.error', 'Verification crashed', { error: err.message }).catch(() => {});
      await finish(incidentId, 'unresolved', { error: err.message }).catch((e) => console.error('[verify]', e.message));
    })
    .finally(() => running.delete(incidentId));
}

async function verify(incidentId) {
  const incident = (await transition(incidentId, ['fixing'], 'verifying')) ?? (await getIncident(incidentId));
  if (incident.status !== 'verifying') return;
  const service = await getService(incident.serviceId);
  const { sentry } = await adapters(incident.workspaceId);
  const errorsOn = sentry && service.sentryProject;
  publish(incident.workspaceId);
  notify(incidentId);

  // Peak error rate between detection and the fix, for the before/after report.
  const during = (await listSamples(service.id, { since: incident.startedAt })).filter((s) => s.at <= incident.fix.appliedAt);
  const before = {
    errorsPerMin: Math.max(0, ...during.map((s) => s.errorsPerMin ?? 0), incident.signal?.errorsPerMin ?? 0),
    healthy: during.length ? during.at(-1).healthy : null,
  };

  // 1. Deployment. Only checkable if the health endpoint reports a release.
  const deploy = { release: null, confirmed: false, waitedSec: 0 };
  if (service.healthUrl && service.release) {
    await addEvent(incidentId, 'verify', 'Waiting for the revert to deploy', { revertSha: incident.fix.revertSha });
    const started = Date.now();
    while (Date.now() - started < config.verify.deployTimeoutSec * 1000) {
      const h = await checkHealth(service.healthUrl);
      deploy.release = h.release ?? deploy.release;
      if (sameCommit(h.release, incident.fix.revertSha)) {
        deploy.confirmed = true;
        break;
      }
      await sleep(POLL_MS);
    }
    deploy.waitedSec = Math.round((Date.now() - started) / 1000);
    await addEvent(incidentId, 'verify', deploy.confirmed ? `Deployed ${deploy.release.slice(0, 7)} after ${deploy.waitedSec}s` : `Revert not seen on the service after ${deploy.waitedSec}s`, deploy);
  }

  // 2. Watch window.
  const windowStart = new Date().toISOString();
  await addEvent(incidentId, 'verify', `Watching health and errors for ${config.verify.windowSec}s`);
  publish(incident.workspaceId);
  const checks = [];
  const end = Date.now() + config.verify.windowSec * 1000;
  while (Date.now() < end) {
    await sleep(Math.min(POLL_MS, end - Date.now()));
    const health = service.healthUrl ? await checkHealth(service.healthUrl) : null;
    checks.push({ at: new Date().toISOString(), healthy: health?.healthy ?? null, release: health?.release ?? null });
  }

  const minutes = Math.max(config.verify.windowSec / 60, 1 / 60);
  const errors = errorsOn ? await sentry.errorCount(service.sentryProject, windowStart) : null;
  const after = {
    errorsPerMin: errors == null ? null : Math.round(errors / minutes),
    errorsInWindow: errors,
    healthy: checks.some((c) => c.healthy != null) ? checks.every((c) => c.healthy !== false) : null,
  };

  const errorsOk = after.errorsPerMin == null || after.errorsPerMin < config.monitor.errorThresholdPerMin;
  const healthOk = after.healthy !== false;
  const deployOk = !service.release || deploy.confirmed;
  const verdict = errorsOk && healthOk && deployOk ? 'resolved' : 'unresolved';
  const reasons = [
    !deployOk && 'the revert was not seen running on the service',
    !healthOk && 'health checks still fail',
    !errorsOk && `errors are still at ${after.errorsPerMin}/min`,
  ].filter(Boolean);

  await finish(incidentId, verdict, { before, after, deploy, windowSec: config.verify.windowSec, checks, reason: reasons.join('; ') || null });
}

async function finish(incidentId, verdict, verification) {
  const incident = await transition(incidentId, ['verifying', 'fixing'], verdict, {
    verification: { verdict, ...verification, finishedAt: new Date().toISOString() },
    resolvedAt: new Date().toISOString(),
  });
  if (!incident) return;
  await addEvent(incidentId, verdict === 'resolved' ? 'resolved' : 'unresolved', verdict === 'resolved' ? 'Recovery verified: incident resolved' : `Not recovered: ${verification.reason ?? verification.error}`, verification);
  publish(incident.workspaceId);
  notify(incidentId);
}
