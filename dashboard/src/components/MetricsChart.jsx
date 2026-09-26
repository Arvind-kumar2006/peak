// Before/after metrics chart. Hand-rolled SVG, zero dependencies.
//
// This panel carries a specific argument: "the model says it's fixed" versus
// "here is the graph, and it is fixed". A real series with the action marked on
// it does the second job, so it needs to be legible from across a room.
//
// Why no chart library: Recharts is ~200KB, a version matrix, and a build
// plugin, in exchange for a line chart and a vertical rule. That is a bad trade
// two hours before a demo. This is ~150 lines of arithmetic.
//
// The vertical marker is the whole point — it is the moment the human approved
// the action, and everything to its right is the recovery.

import { useMemo, useState } from 'react';

// Metrics worth plotting, chosen for legibility on a projector. errorRate is
// the default because it is the signal both scenarios are judged on.
const METRICS = [
  { key: 'errorRate', label: 'Error rate', format: (v) => `${(v * 100).toFixed(1)}%` },
  { key: 'p95Ms', label: 'p95 latency', format: (v) => `${Math.round(v)}ms` },
  { key: 'memoryMB', label: 'Memory', format: (v) => `${Math.round(v)}MB` },
  { key: 'poolInUse', label: 'Pool in use', format: (v) => `${Math.round(v)}` },
  { key: 'cacheEntries', label: 'Cache entries', format: (v) => `${Math.round(v)}` },
];

const W = 720;
const H = 220;
const PAD = { top: 16, right: 16, bottom: 26, left: 52 };

export function MetricsChart({ samples = [], decisionAt, resolution }) {
  const [metricKey, setMetricKey] = useState('errorRate');
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];

  const view = useMemo(() => {
    const points = samples
      .map((s) => ({ t: new Date(s.at).getTime(), v: s[metric.key] }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);

    if (points.length < 2) return { points: [], path: null, area: null, min: 0, max: 1, markerX: null };

    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const span = Math.max(t1 - t0, 1);
    const values = points.map((p) => p.v);
    // Include zero so a flat healthy line reads as flat-and-low rather than
    // auto-scaling to fill the panel and looking dramatic.
    let min = Math.min(0, ...values);
    let max = Math.max(...values);
    if (max === min) max = min + 1; // avoid a zero-height plot

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const x = (t) => PAD.left + ((t - t0) / span) * plotW;
    const y = (v) => PAD.top + plotH - ((v - min) / (max - min)) * plotH;

    const coords = points.map((p) => [x(p.t), y(p.v)]);
    const line = coords.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
    const base = PAD.top + plotH;
    const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${base} L${coords[0][0].toFixed(1)},${base} Z`;

    const markerT = decisionAt ? new Date(decisionAt).getTime() : null;
    const markerX = markerT && markerT >= t0 && markerT <= t1 ? x(markerT) : null;

    return { points, coords, line, area, min, max, markerX, t0, t1, base };
  }, [samples, metric.key, decisionAt]);

  const before = averageBefore(samples, decisionAt, metric.key);
  const after = averageAfter(samples, decisionAt, metric.key);

  return (
    <section className="card">
      <header className="card-head">
        <h2>Metrics</h2>
        <div className="metric-tabs" role="tablist">
          {METRICS.map((m) => (
            <button
              key={m.key}
              role="tab"
              aria-selected={m.key === metric.key}
              className={`tab ${m.key === metric.key ? 'tab-active' : ''}`}
              onClick={() => setMetricKey(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </header>

      {view.points.length < 2 ? (
        <p className="muted">
          Collecting samples… The chart appears once the incident has been running for a few seconds.
        </p>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`${metric.label} over time`}>
            {/* Horizontal guides + y labels */}
            {[0, 0.5, 1].map((f) => {
              const v = view.min + (view.max - view.min) * f;
              const py = PAD.top + (H - PAD.top - PAD.bottom) * (1 - f);
              return (
                <g key={f}>
                  <line x1={PAD.left} y1={py} x2={W - PAD.right} y2={py} className="grid" />
                  <text x={PAD.left - 8} y={py + 4} className="axis-label" textAnchor="end">
                    {metric.format(v)}
                  </text>
                </g>
              );
            })}

            <path d={view.area} className="chart-area" />
            <path d={view.line} className="chart-line" />

            {view.markerX !== null && (
              <>
                <line x1={view.markerX} y1={PAD.top} x2={view.markerX} y2={view.base} className="chart-marker" />
                <text x={view.markerX + 6} y={PAD.top + 12} className="marker-label">
                  approved
                </text>
              </>
            )}

            <text x={PAD.left} y={H - 8} className="axis-label">
              {new Date(view.t0).toLocaleTimeString()}
            </text>
            <text x={W - PAD.right} y={H - 8} className="axis-label" textAnchor="end">
              {new Date(view.t1).toLocaleTimeString()}
            </text>
          </svg>

          <div className="beforeafter">
            <div>
              <span className="label">Before</span>
              <span className="value big">{before === null ? '—' : metric.format(before)}</span>
            </div>
            <div className="arrow">→</div>
            <div>
              <span className="label">After</span>
              <span className={`value big ${after !== null && before !== null && after < before ? 'good-text' : ''}`}>
                {after === null ? '—' : metric.format(after)}
              </span>
            </div>
            {resolution?.reasoning && <p className="verdict">{resolution.reasoning}</p>}
          </div>
        </>
      )}
    </section>
  );
}

function averageBefore(samples, decisionAt, key) {
  return average(samples.filter((s) => (!decisionAt || new Date(s.at) < new Date(decisionAt))), key);
}
function averageAfter(samples, decisionAt, key) {
  if (!decisionAt) return null;
  return average(samples.filter((s) => new Date(s.at) >= new Date(decisionAt)), key);
}
function average(list, key) {
  const values = list.map((s) => s[key]).filter((v) => Number.isFinite(v));
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
