// Local development: TrueForge, the Groq proxy (when Groq is a provider), the PEAK server
// and the dashboard, with prefixed logs. Ctrl-C stops everything.
//
//   npm run dev
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const env = { ...process.env };
if (existsSync(`${root}.env`)) {
  for (const line of readFileSync(`${root}.env`, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/.exec(line);
    if (m && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const trueforgeUrl = env.TRUEFORGE_URL ?? 'http://localhost:8790';
const trueforgeUp = await fetch(`${trueforgeUrl}/api/v1/agents`).then((r) => r.ok).catch(() => false);
const groqProxyUp = await fetch(`${(env.GROQ_BASE_URL ?? 'http://localhost:7310/v1').replace(/\/v1\/?$/, '')}/v1/models`).then(() => true).catch(() => false);
const providers = (env.MODEL_PROVIDERS ?? 'groq,gemini,openai,xai').split(',').map((s) => s.trim());

const procs = [
  !trueforgeUp && {
    name: 'trueforge',
    color: 35,
    cmd: 'npx',
    args: ['-y', '@truefoundry/trueforge@0.2.1', '--port', new URL(trueforgeUrl).port || '8790'],
    env: { OUTBOUND_URL_ALLOWED_HOSTS: '["localhost","127.0.0.1"]' },
  },
  providers.includes('groq') && env.GROQ_API_KEY && !groqProxyUp && { name: 'groq-proxy', color: 33, cmd: 'node', args: ['server/model/groq-proxy.js'] },
  { name: 'server', color: 32, cmd: 'npm', args: ['run', 'dev', '-w', 'server'] },
  { name: 'web', color: 36, cmd: 'npm', args: ['run', 'dev', '-w', 'web'] },
].filter(Boolean);

if (trueforgeUp) console.log(`\x1b[35m[trueforge]\x1b[0m already running at ${trueforgeUrl}`);

const children = procs.map((p) => {
  const child = spawn(p.cmd, p.args, { cwd: root, env: { ...env, ...p.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${prefix}exited (${code})`));
  return child;
});

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
