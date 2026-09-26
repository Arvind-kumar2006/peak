// Live service vitals, always visible regardless of which incident is selected.
//
// During a demo the audience needs to see the *system* reacting, not just the
// agent's account of it. This strip is the ground truth: if the agent says
// "resolved", these numbers should visibly agree.
//
// Health is derived here from the numbers, using the same thresholds the agent's
// runbook uses for "healthy" (agent/instructions.md). /metrics has no status
// field, so reading `metrics.status` showed a permanent "—" even at 30% errors.

export function serviceHealth(m) {
  if (!m) return null;
  const pool = m.db?.pool;
  const mem = m.process;
  const problems = [];
  if (Number.isFinite(m.http?.errorRate) && m.http.errorRate >= 0.01) problems.push('errors');
  if (pool && (pool.waiting > 0 || pool.inUse >= pool.max)) problems.push('pool');
  if (mem?.memoryMB && mem.memoryMB >= 0.6 * (mem.memoryLimitMB || 512)) problems.push('memory');
  if (Number.isFinite(m.http?.p95Ms) && m.http.p95Ms >= 150) problems.push('latency');
  if (m.stale) return { label: 'Unknown', tone: 'warn', problems };
  return problems.length ? { label: 'Degraded', tone: 'bad', problems } : { label: 'Healthy', tone: 'good', problems };
}

export function LiveStrip({ metrics, error }) {
  if (error) {
    return (
      <div className="live-strip">
        <span className="live-label">Service</span>
        <span className="alert alert-error inline">{error.message}</span>
      </div>
    );
  }
  if (!metrics) return null;

  const health = serviceHealth(metrics);
  const pool = metrics.db?.pool;
  const mem = metrics.process;
  const memoryPct = mem?.memoryMB ? Math.round((mem.memoryMB / (mem.memoryLimitMB || 512)) * 100) : null;
  const bad = (cond) => (cond ? 'tone-bad' : 'tone-good');

  return (
    <div className="live-strip" aria-label="Live service vitals">
      <span className={`live-health tone-${health.tone}`}>
        <span className="live-dot" />
        {health.label}
      </span>
      <Metric label="Error rate" value={pct(metrics.http?.errorRate)} tone={bad(metrics.http?.errorRate >= 0.01)} />
      <Metric
        label="p95"
        value={Number.isFinite(metrics.http?.p95Ms) ? `${Math.round(metrics.http.p95Ms)}ms` : '—'}
        tone={bad(metrics.http?.p95Ms >= 150)}
      />
      {pool && (
        <Metric
          label="DB pool"
          value={`${pool.inUse}/${pool.max}${pool.waiting ? ` · ${pool.waiting} waiting` : ''}`}
          tone={bad(pool.waiting > 0 || pool.inUse >= pool.max)}
        />
      )}
      {memoryPct !== null && (
        <Metric
          label="Memory"
          value={`${Math.round(mem.memoryMB)}MB · ${memoryPct}%`}
          tone={memoryPct >= 60 ? 'tone-bad' : null}
        />
      )}
      {metrics.release && metrics.release !== 'synthetic' && <Metric label="Release" value={metrics.release} />}

      {/* Never let generated or cached numbers pass as real. */}
      {metrics.source === 'synthetic' && (
        <span className="pill tone-warn" title="The demo app is not reachable — these numbers are generated">
          simulated data
        </span>
      )}
      {metrics.source === 'mock' && (
        <span className="pill tone-neutral" title="Numbers come from the MCP servers' simulated world (MOCK=1)">
          mock world
        </span>
      )}
      {metrics.stale && <span className="pill tone-warn">stale</span>}
    </div>
  );
}

function Metric({ label, value, tone }) {
  return (
    <span className="live-metric">
      <span className="live-label">{label}</span>
      <span className={`live-value ${tone ?? ''}`}>{value}</span>
    </span>
  );
}

const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
