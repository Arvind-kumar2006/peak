// Diagnosis panel: headline, root cause, and the evidence behind it.
//
// The evidence list is the credibility centre of the UI. Each row separates the
// agent's *claim* from the *tool* that produced it and the *value* it saw, so a
// judge can tell the difference between an assertion and a citation. Tool names
// are monospaced for exactly that reason.

import { CategoryBadge, ConfidenceBar } from './StatusBadge.jsx';

export function RootCauseCard({ report }) {
  if (!report) return null;
  const { rootCause, summary, proposedFix } = report;

  return (
    <section className="card">
      <header className="card-head">
        <h2>Diagnosis</h2>
        <CategoryBadge category={rootCause.category} />
      </header>

      {summary && <p className="summary">{summary}</p>}

      <div className="rootcause">
        <div className="rootcause-line">
          <span className="label">Cause</span>
          <span className="value">{rootCause.description || <em className="muted">not stated</em>}</span>
        </div>
        <div className="rootcause-line">
          <span className="label">Confidence</span>
          <ConfidenceBar value={rootCause.confidence} />
        </div>
        {rootCause.commitSha && (
          <div className="rootcause-line">
            <span className="label">Commit</span>
            <span className="value">
              <code className="sha">{rootCause.commitSha}</code>
            </span>
          </div>
        )}
        {proposedFix?.reasoning && (
          <div className="rootcause-line">
            <span className="label">Why this fix</span>
            <span className="value">{proposedFix.reasoning}</span>
          </div>
        )}
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
