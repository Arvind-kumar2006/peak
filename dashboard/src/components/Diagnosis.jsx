// Diagnosis, evidence and outcome panels.
//
// The schema is two-phase and the UI follows it: a Diagnosis exists from the
// moment the agent proposes a fix (it sits beside the Approve button), and a
// Resolution arrives at the end carrying the verdict. The field that earns this
// project's credibility is `ruledOut` — what the agent considered and threw
// away — so it always gets its own block.

import { CategoryBadge, ConfidenceBar } from './StatusBadge.jsx';

export function DiagnosisCard({ diagnosis }) {
  if (!diagnosis) return null;
  const { rootCause, proposedFix } = diagnosis;

  // No summary line here: the page headline already is the summary.
  return (
    <section className="card">
      <header className="card-head">
        <h2>Diagnosis</h2>
        <CategoryBadge category={rootCause.category} />
      </header>
      <dl className="kv kv-wide">
        <dt>Cause</dt>
        <dd>{rootCause.description || <em className="muted">not stated</em>}</dd>
        <dt>Confidence</dt>
        <dd>
          <ConfidenceBar value={rootCause.confidence} />
        </dd>
        {rootCause.commitSha && (
          <>
            <dt>Commit</dt>
            <dd className="sha">{rootCause.commitSha}</dd>
          </>
        )}
        {proposedFix?.reasoning && (
          <>
            <dt>Why this fix</dt>
            <dd>{proposedFix.reasoning}</dd>
          </>
        )}
      </dl>
      {diagnosis.ruledOut?.length > 0 && (
        <div className="divider-dashed">
          <span className="eyebrow">Ruled out</span>
          <ul className="ruledout">
            {diagnosis.ruledOut.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function EvidenceList({ evidence }) {
  if (!evidence?.length) return null;
  return (
    <section className="card">
      <header className="card-head">
        <h2>Evidence</h2>
        <span className="muted small">{evidence.length} cited, each from a tool call</span>
      </header>
      <ol className="evidence">
        {evidence.map((item, i) => (
          <li key={i}>
            <span className="evidence-claim">{item.claim}</span>
            <span className="evidence-meta">
              <span className="tool">{item.tool}</span>
              {item.observation}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const VERDICT = {
  resolved: { tone: 'good', title: 'Outcome · measured, not claimed' },
  mitigated: { tone: 'warn', title: 'Why this is not “resolved”' },
  not_resolved: { tone: 'bad', title: 'The service did not recover' },
  rejected: { tone: 'neutral', title: 'Action rejected — nothing was run' },
};

// before/after keys the agent reports (agent/report-schema.mjs metricsSummary).
const TILES = [
  { key: 'errorRate', label: 'Error rate', fmt: (v) => `${(v * 100).toFixed(1)}%` },
  { key: 'p95Ms', label: 'p95 latency', fmt: (v) => `${Math.round(v)}ms` },
  { key: 'poolInUse', label: 'DB clients in use', fmt: (v) => String(Math.round(v)) },
  { key: 'memoryMB', label: 'Memory', fmt: (v) => `${Math.round(v)}MB` },
  { key: 'release', label: 'Running release', fmt: (v) => String(v) },
];

/** The agent's Resolution, shown first once it exists. */
export function OutcomeCard({ resolution }) {
  if (!resolution) return null;
  const v = VERDICT[resolution.verdict] ?? { tone: 'neutral', title: 'Outcome' };
  const before = resolution.before ?? {};
  const after = resolution.after ?? {};
  const showTiles = resolution.verdict !== 'rejected';
  // Unchanged values stay: for "mitigated" and "not resolved", the metric that did
  // NOT move is the evidence. Resolved keeps only what changed, to stay readable.
  const tiles = TILES.filter(
    (t) => before[t.key] != null && after[t.key] != null && (resolution.verdict !== 'resolved' || before[t.key] !== after[t.key]),
  );

  return (
    <section className={`outcome outcome-${v.tone}`} aria-label="Outcome">
      <div className="outcome-head">
        <span className="eyebrow">{v.title}</span>
        {showTiles && resolution.windowSec > 0 && (
          <span className="muted small">before = during the incident · after = end of the {resolution.windowSec}s window</span>
        )}
      </div>
      {resolution.reasoning && <p className="prose">{resolution.reasoning}</p>}
      {showTiles && tiles.length > 0 && (
        <div className="tiles">
          {tiles.map((t) => (
            <div className="tile" key={t.key}>
              <span className="tile-label">{t.label}</span>
              <span className="tile-before">{t.fmt(before[t.key])}</span>
              <span className={`tile-after tone-${improved(t.key, before[t.key], after[t.key]) ? 'good' : v.tone === 'good' ? 'good' : 'bad'}`}>
                {t.fmt(after[t.key])}
              </span>
            </div>
          ))}
        </div>
      )}
      {resolution.followUp && (
        <div className="callout">
          <span className="eyebrow">Follow-up</span>
          <span>{resolution.followUp}</span>
        </div>
      )}
    </section>
  );
}

/** Lower is better for every numeric metric we show; a changed release means the rollback landed. */
function improved(key, before, after) {
  if (key === 'release') return before !== after;
  return Number.isFinite(before) && Number.isFinite(after) && after < before;
}
