// Connections from .env: any workspace that hasn't connected a source yet gets the one
// configured on the server (validated the same way as the Connections page). Same for a
// first service. Runs at startup and on signup; failures are logged and skipped.
import { db } from '../db.js';
import { listIntegrations, connect } from './index.js';
import { listServices, createService } from '../store.js';

const env = (k) => (process.env[k] ?? '').trim();

function fromEnv() {
  const out = {};
  if (env('GITHUB_TOKEN') && env('GITHUB_REPO')) out.github = { token: env('GITHUB_TOKEN'), repo: env('GITHUB_REPO'), branch: env('GITHUB_BRANCH') };
  if (env('SENTRY_AUTH_TOKEN') && env('SENTRY_ORG')) out.sentry = { token: env('SENTRY_AUTH_TOKEN'), org: env('SENTRY_ORG'), url: env('SENTRY_URL') };
  if (env('SLACK_BOT_TOKEN') || env('SLACK_WEBHOOK_URL')) out.slack = { botToken: env('SLACK_BOT_TOKEN'), webhookUrl: env('SLACK_WEBHOOK_URL'), channel: env('SLACK_CHANNEL') };
  return out;
}

export async function applyEnvDefaults(workspaceId) {
  const defaults = fromEnv();
  const connected = new Set(listIntegrations(workspaceId).filter((i) => i.connected).map((i) => i.kind));
  for (const [kind, body] of Object.entries(defaults)) {
    if (connected.has(kind)) continue;
    try {
      await connect(workspaceId, kind, body);
      console.log(`[defaults] ${workspaceId}: connected ${kind} from .env`);
    } catch (err) {
      console.warn(`[defaults] ${workspaceId}: ${kind} from .env not connected: ${err.message}`);
    }
  }
  const name = env('SERVICE_NAME');
  const healthUrl = env('SERVICE_HEALTH_URL');
  const sentryProject = env('SENTRY_PROJECT');
  if (name && (healthUrl || sentryProject) && listServices(workspaceId).length === 0) {
    createService(workspaceId, { name, healthUrl, sentryProject });
    console.log(`[defaults] ${workspaceId}: added service ${name} from .env`);
  }
}

export async function applyEnvDefaultsToAll() {
  for (const { id } of db.prepare('SELECT id FROM workspaces').all()) await applyEnvDefaults(id);
}
