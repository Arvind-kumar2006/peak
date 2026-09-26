/**
 * Single source of truth for the running release identity.
 *
 * Every consumer — /health, /metrics, every log line, and the Sentry `release`
 * tag — reads from here. If these drift apart the agent sees contradictory
 * evidence (Sentry says a1b2c3d, the service says d4e5f6a) and either hedges
 * or misdiagnoses, so keep it in one place.
 *
 * Render injects RENDER_GIT_COMMIT per deploy, and updates it on rollback, so
 * `release` flips to the previous commit the moment a rollback completes.
 */
const raw = process.env.RENDER_GIT_COMMIT || process.env.RELEASE || 'local-dev';

export const RELEASE = {
  /** Full commit SHA as reported by the deploy platform. */
  full: raw,
  /** 7-char short SHA for log lines and dashboards. */
  short: raw.slice(0, 7),
  /** True when running on Render, so we can behave like production. */
  isRender: Boolean(process.env.RENDER),
  /** Render instance id — changes on every restart. Used to prove a restart
   *  happened, which is how `restart_service` differs from `trigger_rollback`. */
  instanceId: process.env.RENDER_INSTANCE_ID || null,
  serviceId: process.env.RENDER_SERVICE_ID || null,
  startedAt: new Date(),
};

export function uptimeSec() {
  return Math.round((Date.now() - RELEASE.startedAt.getTime()) / 1000);
}
