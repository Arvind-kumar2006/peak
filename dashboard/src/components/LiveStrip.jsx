// Live service vitals, always visible regardless of which incident is selected.
//
// During a demo the audience needs to see the *system* reacting, not just the
// agent's account of it. This strip is the ground truth: if the agent says
// "resolved", these numbers should visibly agree.

export function LiveStrip({ metrics, error }) {
  if (error) {
    return (
      <div className="live-strip">
        <span className="live-title">Service</span>
        <span className="alert alert-error inline">{error.message}</span>
      </div>
    );
  }
  if (!metrics) return null;

  const stale = metrics.stale;
  const synthetic = metrics.source === 'synthetic';
  const pool = metrics.db?.pool;
  const memoryPct = metrics.process?.memoryMB
    ? Math.round((metrics.process.memoryMB / (metrics.process.memoryLimitMB || 512)) * 100)
    : null;

  return (
    <div className="live-strip">
      <span className="live-title">Service</span>

      <Metric label="status" value={metrics.status ?? (stale ? 'unknown' : '—')} tone={healthTone(metrics, stale)} />
      <Metric label="error rate" value={pct(metrics.http?.errorRate)} tone={toneFor(metrics.http?.errorRate, 0.01, 0.05)} />
      <Metric label="p95" value={metrics.http?.p95Ms ? `${Math.round(metrics.http.p95Ms)}ms` : '—'} />
      <Metric label="rpm" value={metrics.http?.rpm ?? '—'} />
      {pool && (
        <Metric
          label="pool"
          value={`${pool.inUse}/${pool.max}`}
          tone={pool.waiting > 0 ? 'bad' : pool.inUse >= pool.max ? 'bad' : 'good'}
          title={`${pool.waiting} waiting`}
        />
      )}
      {memoryPct !== null && (
        <Metric
          label="memory"
          value={`${Math.round(metrics.process.memoryMB)}MB · ${memoryPct}%`}
          tone={memoryPct > 85 ? 'bad' : memoryPct > 60 ? 'warn' : 'good'}
        />
      )}

      {/* Never let synthetic or cached numbers pass as real. If the demo app is
          down we say so on screen rather than quietly drawing a plausible lie. */}
      {synthetic && (
        <span className="pill tone-warn" title="P1's demo app is not reachable — these numbers are generated">
          simulated data
        </span>
      )}
      {stale && <span className="pill tone-warn">stale</span>}
    </div>
  );
}

function Metric({ label, value, tone, title }) {
  return (
    <span className={`live-metric ${tone ? `tone-${tone}` : ''}`} title={title}>
      <span className="live-label">{label}</span>
      <span className="live-value">{value}</span>
    </span>
  );
}

const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

function healthTone(metrics, stale) {
  if (stale) return 'warn';
  if (metrics.status === 'down') return 'bad';
  if (metrics.status === 'degraded') return 'warn';
  return 'good';
}

function toneFor(value, warnAt, badAt) {
  if (!Number.isFinite(value)) return null;
  if (value >= badAt) return 'bad';
  if (value >= warnAt) return 'warn';
  return 'good';
}
