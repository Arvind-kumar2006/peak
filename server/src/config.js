// All runtime configuration, read once from the environment (repo-root .env).
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 4000),
  // Where people open the app (used in Slack links and OAuth redirects).
  appUrl: (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
  // How TrueForge reaches this server's MCP endpoint.
  serverUrl: (process.env.SERVER_URL ?? `http://localhost:${num(process.env.PORT, 4000)}`).replace(/\/+$/, ''),
  dataDir: process.env.DATA_DIR ?? new URL('../../data/', import.meta.url).pathname,
  appSecret: process.env.APP_SECRET ?? '',

  trueforgeUrl: (process.env.TRUEFORGE_URL ?? 'http://localhost:8790').replace(/\/+$/, ''),

  github: {
    clientId: process.env.GITHUB_CLIENT_ID ?? '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
    apiUrl: (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, ''),
  },
  slack: {
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
  },

  monitor: {
    intervalSec: num(process.env.MONITOR_INTERVAL_SEC, 10),
    errorThresholdPerMin: num(process.env.ERROR_THRESHOLD_PER_MIN, 5),
    failedChecksToAlert: num(process.env.FAILED_CHECKS_TO_ALERT, 2),
    incidentRetentionDays: num(process.env.INCIDENT_RETENTION_DAYS, 90),
  },
  verify: {
    // After the fix, wait for the service to report the new release (if it reports one) …
    deployTimeoutSec: num(process.env.VERIFY_DEPLOY_TIMEOUT_SEC, 600),
    // … then watch errors + health for this long. Resolved only if it stays clean.
    windowSec: num(process.env.VERIFY_WINDOW_SEC, 30),
  },
};
