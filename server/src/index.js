// PEAK server: auth, dashboard API, Slack interactivity, the agent's MCP endpoint,
// the monitor loop, and (in production) the built dashboard.
import express from 'express';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { authRoutes } from './auth.js';
import { api } from './routes/api.js';
import { slackRoutes } from './routes/slack.js';
import { handleMcp } from './agent/tools.js';
import { initAgent, mcpToken } from './agent/runner.js';
import { startMonitor } from './monitor.js';
import { applyEnvDefaultsToAll } from './integrations/defaults.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use('/api/slack', slackRoutes); // own body parser (needs the raw body for signatures)
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api', api);

app.all('/mcp/:token', (req, res, next) => {
  if (req.params.token !== mcpToken) return res.status(404).end();
  handleMcp(req, res).catch(next);
});

const dist = new URL('../../web/dist/', import.meta.url).pathname;
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/|\/mcp\/).*/, (req, res) => res.sendFile(`${dist}index.html`));
}

app.use((err, req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  if (!res.headersSent) res.status(status).json({ error: err.message ?? 'Server error' });
});

app.listen(config.port, () => {
  console.log(`[peak] server on http://localhost:${config.port} (app: ${config.appUrl})`);
  initAgent();
  applyEnvDefaultsToAll().finally(startMonitor);
});
