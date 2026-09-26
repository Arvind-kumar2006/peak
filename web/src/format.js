export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

export function ago(iso, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.round((now - new Date(iso)) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const short = (sha) => (sha ? sha.slice(0, 7) : '');

export const STATUS = {
  investigating: { label: 'Investigating', tone: 'warn' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'accent' },
  fixing: { label: 'Applying fix', tone: 'warn' },
  awaiting_merge: { label: 'Waiting for merge', tone: 'info' },
  verifying: { label: 'Verifying', tone: 'warn' },
  resolved: { label: 'Resolved', tone: 'good' },
  unresolved: { label: 'Not recovered', tone: 'bad' },
  needs_attention: { label: 'Needs a human', tone: 'bad' },
  rejected: { label: 'Fix rejected', tone: 'muted' },
  failed: { label: 'Agent failed', tone: 'bad' },
};

export const SERVICE_STATUS = {
  healthy: { label: 'Healthy', tone: 'good' },
  degraded: { label: 'Degraded', tone: 'warn' },
  down: { label: 'Down', tone: 'bad' },
  unknown: { label: 'No data yet', tone: 'muted' },
};
