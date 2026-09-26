// PEAK server: auth, dashboard API, Slack interactivity, the agent's MCP endpoint,
// the monitor loop, and (in production) the built dashboard.
import express from 'express';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { authRoutes } from './auth.js';
import { api } from './routes/api.js';
import { slackRoutes } from './routes/slack.js';
import { handleMcp } from './agent/tools.js';
import { initAgent, mcpAuthorized, agentStatus } from './agent/runner.js';
import { kvSet, initDb, dbKind } from './db.js';
import { startMonitor } from './monitor.js';

const app = express();
app.disable('x-powered-by');
// Only behind a reverse proxy that sets X-Forwarded-For; otherwise clients could spoof their IP
// and dodge the per-IP rate limits.
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

app.use('/api/slack', slackRoutes); // own body parser (needs the raw body for signatures)
app.use(express.json({ limit: '1mb' }));

// Liveness: the process answers.
app.get('/api/health', (req, res) => res.json({ ok: true }));
// Readiness: the database is writable and the AI path (TrueForge + a model provider) is up.
app.get('/api/ready', async (req, res) => {
  const checks = { database: true, agent: agentStatus.ready };
  try {
    await kvSet('ready_probe', new Date().toISOString());
  } catch {
    checks.database = false;
  }
  const ok = checks.database && checks.agent;
  res.status(ok ? 200 : 503).json({ ok, checks, ...(agentStatus.error && !agentStatus.ready ? { agentError: agentStatus.error } : {}) });
});
app.use('/api/auth', authRoutes);
app.use('/api', api);

// The agent's tools. TrueForge sends the token in a header, so it never appears in URLs or logs.
app.all('/mcp', (req, res, next) => {
  if (!mcpAuthorized(req.headers.authorization)) return res.status(401).json({ error: 'unauthorized' });
  handleMcp(req, res).catch(next);
});

const dist = new URL('../../web/dist/', import.meta.url).pathname;
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/|\/mcp).*/, (req, res) => res.sendFile(`${dist}index.html`));
}

app.use((err, req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  if (!res.headersSent) res.status(status).json({ error: err.message ?? 'Server error' });
});

// Wait for the database (retrying a flaky network for ~1 minute) before accepting traffic.
for (let attempt = 1; ; attempt++) {
  try {
    await initDb();
    break;
  } catch (err) {
    const detail = err.errors?.map((e) => `${e.address ?? ''} ${e.code}`).join(', ') || err.message;
    if (attempt >= 12) {
      console.error(`[peak] database unreachable: ${detail}`);
      process.exit(1);
    }
    console.warn(`[peak] database not reachable yet (${detail}) — retrying in 5s`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
console.log(`[peak] database: ${dbKind()}`);

app.listen(config.port, () => {
  console.log(`[peak] server on http://localhost:${config.port} (app: ${config.appUrl})`);
  initAgent();
  startMonitor();
});
