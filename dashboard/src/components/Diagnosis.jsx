// Diagnosis and Resolution panels.
//
// The schema is two-phase, and the UI follows it: a Diagnosis exists from the
// moment the agent proposes a fix (so it can sit next to the Approve button),
// and a Resolution arrives at the end carrying the verdict. The contract is
// explicit at contracts/backend-api.md, and the field that earns this project's
// credibility is `ruledOut` — what the agent considered and threw away. It gets
// its own block rather than being buried, because "here is what I ruled out" is
// the answer to "how do I know this isn't a guess".

import { CategoryBadge, ConfidenceBar } from './StatusBadge.jsx';

export function DiagnosisCard({ diagnosis }) {
  if (!diagnosis) return null;
  const { rootCause, proposedFix } = diagnosis;

  return (
    <section className="card">
      <header className="card-head">
        <h2>Diagnosis</h2>
        <CategoryBadge category={rootCause.category} />
      </header>

      {diagnosis.summary && <p className="summary">{diagnosis.summary}</p>}

      <div className="rootcause">
        <Row label="Cause">{rootCause.description || <em className="muted">not stated</em>}</Row>
        <Row label="Confidence">
          <ConfidenceBar value={rootCause.confidence} />
        </Row>
        {rootCause.commitSha && (
          <Row label="Commit">
            <code className="sha">{rootCause.commitSha}</code>
          </Row>
        )}
        {proposedFix.reasoning && <Row label="Why this fix">{proposedFix.reasoning}</Row>}
        {proposedFix.expectedOutcome && (
          <Row label="Expected">
            <span className={`pill ${proposedFix.expectedOutcome === 'resolves' ? 'tone-good' : 'tone-warn'}`}>
              {proposedFix.expectedOutcome === 'resolves' ? 'should resolve' : 'should only mitigate'}
            </span>
          </Row>
        )}
      </div>

      {diagnosis.ruledOut?.length > 0 && (
        <div className="ruledout">
          <h3>Ruled out</h3>
          <ul>
            {diagnosis.ruledOut.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function ResolutionCard({ resolution }) {
  if (!resolution) return null;
  const { before = {}, after = {} } = resolution;

  return (
    <section className="card card-resolution">
      <header className="card-head">
        <h2>Resolution</h2>
        <span
          className={`pill ${
            resolution.verdict === 'resolved'
              ? 'tone-good'
              : resolution.verdict === 'mitigated'
                ? 'tone-warn'
                : 'tone-bad'
          }`}
        >
          {resolution.verdict ?? 'unknown'}
        </span>
      </header>

      <div className="rootcause">
        <Row label="Action">
          <code className="sha">{resolution.actionTaken ?? 'none'}</code>
        </Row>
        <Row label="Window">{resolution.windowSec ? `${resolution.windowSec}s observed` : <em className="muted">not stated</em>}</Row>
        {Object.keys(after).length > 0 && (
          <Row label="Measured">
            <span className="measured">
              {Object.entries(before).map(([k, v]) => (
                <span key={`b-${k}`} className="chip">
                  {k} <s>{fmt(v)}</s> → <strong>{fmt(after[k])}</strong>
                </span>
              ))}
            </span>
          </Row>
        )}
        {resolution.reasoning && <Row label="Verdict">{resolution.reasoning}</Row>}
        {resolution.followUp && <Row label="Follow-up">{resolution.followUp}</Row>}
      </div>
    </section>
  );
}

export function EvidenceList({ evidence }) {
  if (!evidence?.length) return null;
  return (
    <section className="card">
      <header className="card-head">
        <h2>Evidence</h2>
        <span className="muted small">{evidence.length} cited</span>
      </header>
      <ol className="evidence">
        {evidence.map((item, i) => (
          <li key={i}>
            <div className="evidence-claim">{item.claim}</div>
            <div className="evidence-meta">
              <code className="tool">{item.tool}</code>
              <span className="observation">{item.observation}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Row({ label, children }) {
  return (
    <div className="rootcause-line">
      <span className="label">{label}</span>
      <span className="value">{children}</span>
    </div>
  );
}

/** Show small fractions as percentages; everything else verbatim. */
function fmt(v) {
  if (typeof v !== 'number') return String(v ?? '—');
  return v > 0 && v < 1 && !Number.isInteger(v) ? `${(v * 100).toFixed(1)}%` : String(Math.round(v * 100) / 100);
}
