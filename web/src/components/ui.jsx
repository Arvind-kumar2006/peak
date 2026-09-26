export function Badge({ tone = 'muted', children, pulse }) {
  return (
    <span className={`badge ${tone}`}>
      <span className={`dot ${pulse ? 'pulse' : ''}`} />
      {children}
    </span>
  );
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return <div className="error-note">{error.message ?? String(error)}</div>;
}

// Tiny bar chart of errors/min per sample. Red when above the alert threshold.
export function Sparkline({ samples, threshold, height = 32 }) {
  const values = samples.map((s) => s.errorsPerMin);
  if (!values.some((v) => v != null)) {
    const health = samples.map((s) => s.healthy);
    if (!health.some((h) => h != null)) return <div className="spark-empty">no data yet</div>;
    return (
      <div className="spark health" style={{ height }}>
        {health.map((h, i) => (
          <span key={i} className={h === false ? 'bad' : h ? 'good' : ''} style={{ height: '100%' }} />
        ))}
      </div>
    );
  }
  const max = Math.max(threshold * 2, ...values.map((v) => v ?? 0));
  return (
    <div className="spark" style={{ height }} title="errors per minute, last 30 min">
      {values.map((v, i) => (
        <span key={i} className={v >= threshold ? 'bad' : samples[i].healthy === false ? 'warn' : ''} style={{ height: `${Math.max(4, ((v ?? 0) / max) * 100)}%` }} />
      ))}
    </div>
  );
}
