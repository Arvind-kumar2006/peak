// Incident timeline chart. Hand-rolled SVG, zero dependencies.
//
// This panel carries a specific argument: "the model says it's fixed" versus
// "here is the graph, and it is fixed". So it has to be honest:
//
//   - STEP line, not straight segments. A straight line between the last bad
//     sample and the first good one slopes down *before* the approval marker,
//     which reads as "it was already recovering" — the opposite of the truth.
//   - Before the approval is drawn red (the incident); after it, in the colour
//     of the agent's verdict, over a shaded verification window.
//   - The "approved" label sits inside the plot, left of the marker, so it is
//     never clipped at the edge.

import { useMemo, useState } from 'react';

const METRICS = [
  { key: 'errorRate', label: 'Error rate', format: (v) => `${(v * 100).toFixed(1)}%` },
  { key: 'p95Ms', label: 'p95', format: (v) => `${Math.round(v)}ms` },
  { key: 'poolInUse', label: 'Pool', format: (v) => `${Math.round(v)}` },
  { key: 'memoryMB', label: 'Memory', format: (v) => `${Math.round(v)}MB` },
  { key: 'cacheEntries', label: 'Cache', format: (v) => `${Math.round(v)}` },
];

// Which series tells each story best, so the chart opens on the right one.
const DEFAULT_METRIC = { 'conn-leak': 'errorRate', 'mem-leak': 'memoryMB' };

const W = 1040;
const H = 230;
const PAD = { top: 18, right: 14, bottom: 30, left: 56 };

const VERDICT_TONE = { resolved: 'good', mitigated: 'warn', not_resolved: 'bad', rejected: 'neutral' };

export function MetricsChart({ samples = [], decisionAt, resolution, scenario, active = false }) {
  const [chosen, setChosen] = useState(null);
  // A restart during a leak clears errors for a minute; the pool refilling is what shows it didn't work.
  const suggested = resolution?.verdict === 'mitigated' && scenario === 'conn-leak' ? 'poolInUse' : DEFAULT_METRIC[scenario];
  const metricKey = chosen ?? suggested ?? 'errorRate';
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];
  const tone = VERDICT_TONE[resolution?.verdict] ?? 'neutral';

  const view = useMemo(() => {
    const points = samples
      .map((s) => ({ t: new Date(s.at).getTime(), v: s[metric.key] }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);
    if (points.length < 2) return null;

    const t0 = points[0].t;
    const t1 = points.at(-1).t;
    const span = Math.max(t1 - t0, 1);
    const values = points.map((p) => p.v);
    // Include zero so a flat healthy line reads as flat-and-low.
    const min = Math.min(0, ...values);
    let max = Math.max(...values);
    if (max === min) max = min + 1;

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const x = (t) => PAD.left + ((t - t0) / span) * plotW;
    const y = (v) => PAD.top + plotH - ((v - min) / (max - min)) * plotH;
    const base = PAD.top + plotH;

    const markerT = decisionAt ? new Date(decisionAt).getTime() : null;
    const markerX = markerT && markerT >= t0 && markerT <= t1 ? x(markerT) : null;

    // Step path: hold each value until the next sample.
    const step = (pts) =>
      pts.map((p, i) => (i === 0 ? `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}` : `H${x(p.t).toFixed(1)} V${y(p.v).toFixed(1)}`)).join(' ');

    let beforePath;
    let afterPath = null;
    if (markerX === null) {
      beforePath = step(points);
    } else {
      const before = points.filter((p) => p.t <= markerT);
      const after = points.filter((p) => p.t > markerT);
      const held = before.at(-1) ?? points[0];
      beforePath = step([...before, { t: markerT, v: held.v }]);
      afterPath = after.length ? step([{ t: markerT, v: held.v }, ...after]) : null;
    }

    return { t0, t1, min, max, base, markerX, beforePath, afterPath, x };
  }, [samples, metric.key, decisionAt]);

  const markerLabel = resolution?.actionTaken ? 'approved' : 'decision';

  return (
    <section className="card">
      <header className="card-head">
        <h2>{metric.label} · incident timeline</h2>
        <div className="metric-tabs" role="tablist" aria-label="Metric">
          {METRICS.map((m) => (
            <button
              key={m.key}
              role="tab"
              aria-selected={m.key === metric.key}
              className={`tab ${m.key === metric.key ? 'tab-active' : ''}`}
              onClick={() => setChosen(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </header>

      {!view ? (
        <p className="chart-caption">Collecting samples… the chart appears once the incident has run for a few seconds.</p>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`${metric.label} over time`}>
            {view.markerX !== null && view.afterPath && (
              <rect
                x={view.markerX}
                y={PAD.top - 2}
                width={W - PAD.right - view.markerX}
                height={view.base - PAD.top + 2}
                className={`window-${tone}`}
              />
            )}
            {[0, 0.5, 1].map((f) => {
              const v = view.min + (view.max - view.min) * f;
              const py = PAD.top + (H - PAD.top - PAD.bottom) * (1 - f);
              return (
                <g key={f}>
                  <line x1={PAD.left} y1={py} x2={W - PAD.right} y2={py} className={f === 0 ? 'axis' : 'grid'} />
                  <text x={PAD.left - 8} y={py + 4} className="axis-label" textAnchor="end">
                    {metric.format(v)}
                  </text>
                </g>
              );
            })}

            <path d={view.beforePath} className={`chart-line ${view.markerX === null && !active ? 'line-plain' : 'line-before'}`} />
            {view.afterPath && <path d={view.afterPath} className={`chart-line line-after-${tone}`} />}

            {view.markerX !== null && (
              <g>
                <line x1={view.markerX} y1={PAD.top - 2} x2={view.markerX} y2={view.base} className="chart-marker" />
                <rect x={Math.max(PAD.left, view.markerX - 80)} y={PAD.top + 6} width="72" height="22" rx="5" className="marker-bg" />
                <text x={Math.max(PAD.left, view.markerX - 80) + 36} y={PAD.top + 21} className="marker-label" textAnchor="middle">
                  {markerLabel}
                </text>
              </g>
            )}

            <text x={PAD.left} y={H - 8} className="axis-label">
              {new Date(view.t0).toLocaleTimeString()}
            </text>
            {view.markerX !== null && view.markerX - PAD.left > 140 && W - PAD.right - view.markerX > 140 && (
              <text x={view.markerX} y={H - 8} className="axis-label" textAnchor="middle">
                {new Date(decisionAt).toLocaleTimeString()}
              </text>
            )}
            <text x={W - PAD.right} y={H - 8} className="axis-label" textAnchor="end">
              {new Date(view.t1).toLocaleTimeString()}
            </text>
          </svg>
          <p className="chart-caption">
            Each step is one measured sample — nothing is smoothed between readings.
            {view.markerX !== null && ' Shaded: after the human decision.'}
          </p>
        </>
      )}
    </section>
  );
}
