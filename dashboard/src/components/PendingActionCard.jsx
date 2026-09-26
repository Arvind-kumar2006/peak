// The decision panel — the most important block on the page.
//
// This is where the project's whole safety claim becomes visible: a proposed
// production action, held, next to the evidence that justified it, waiting for
// a person. Rules that follow from that:
//
//   - Show the exact tool and args. "Rollback?" is not reviewable; a deploy id
//     and a reason are.
//   - Put the "why" beside the button, not three cards further down.
//   - Never disable Approve without saying why; on failure, show the error
//     inline and re-enable. A button that silently does nothing is the worst
//     outcome on stage.
//
// Only rendered while the runtime is holding a call (status awaiting_approval).
// Once decided, the stepper, the decision record and the outcome take over.

import { useState } from 'react';
import { useDecision } from '../hooks/useDomain.js';
import { ConfidenceBar } from './StatusBadge.jsx';

const ARG_LABELS = {
  toDeployId: 'Roll back to',
  reason: 'Reason',
  instances: 'Instances',
};

export function PendingActionCard({ incident, onDecided }) {
  const action = incident.pendingAction;
  const diagnosis = incident.diagnosis;
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');
  const { approve, reject, pending, error, clearError } = useDecision(incident.id, onDecided);

  if (!action || incident.status !== 'awaiting_approval') return null;

  const deciding = pending !== null;
  const fix = diagnosis?.proposedFix;
  const tools = [...new Set((diagnosis?.evidence ?? []).map((e) => e.tool?.split('.').pop()).filter(Boolean))];

  async function onReject() {
    try {
      await reject(reason.trim() || undefined);
      setShowReject(false);
    } catch {
      // Already surfaced via `error`; the box stays open so the operator can retry.
    }
  }

  return (
    <section className="decision" aria-live="polite" aria-label="Decision required">
      <div className="decision-act">
        <span className="eyebrow">The agent wants to run</span>

        {action.unavailable || !action.tool ? (
          <p className="prose tone-warn">
            The runtime is waiting for approval, but we could not identify which tool call it wants approved. Open the
            reasoning trail to see the details.
          </p>
        ) : (
          <>
            <div className="decision-tool">
              <code>{action.tool}</code>
              {action.server && <span className="muted small">{action.server}</span>}
            </div>
            <dl className="kv">
              {Object.entries(action.args ?? {}).map(([k, v]) => (
                <Arg key={k} name={k} value={v} />
              ))}
              {fix?.expectedOutcome && (
                <>
                  <dt>Expected</dt>
                  <dd className={fix.expectedOutcome === 'resolves' ? 'tone-good' : 'tone-warn'}>
                    <strong>{fix.expectedOutcome === 'resolves' ? 'Resolves the root cause' : 'Only mitigates symptoms'}</strong>
                  </dd>
                </>
              )}
            </dl>
          </>
        )}

        {fix?.reasoning && <p className="prose">{fix.reasoning}</p>}

        {action.extras?.length > 0 && (
          <p className="decision-note">
            The agent also requested {action.extras.length} more tool call(s):{' '}
            {action.extras.map((e) => e.tool || 'unknown').join(', ')}
          </p>
        )}

        {error && (
          <div className="alert alert-error" role="alert">
            <strong>Could not send your decision.</strong> {error.message}
            <button className="link" onClick={clearError}>
              dismiss
            </button>
          </div>
        )}

        {showReject ? (
          <div className="reject-box">
            <label htmlFor="reject-reason">Why are you rejecting this? (optional, kept on the incident record)</label>
            <textarea id="reject-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} autoFocus />
            <div className="row gap">
              <button className="btn btn-danger" onClick={onReject} disabled={deciding}>
                {pending === 'deny' ? 'Rejecting…' : 'Confirm reject'}
              </button>
              <button className="btn btn-ghost" onClick={() => setShowReject(false)} disabled={deciding}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="decision-buttons">
            <button className="btn btn-approve" onClick={approve} disabled={deciding || !action.tool}>
              {pending === 'allow' ? 'Approving…' : `Approve & run ${friendly(action.tool)}`}
            </button>
            <button className="btn btn-reject" onClick={() => setShowReject(true)} disabled={deciding}>
              Reject…
            </button>
          </div>
        )}
        <span className="decision-note">Nothing runs until you decide. The runtime is holding this call.</span>
      </div>

      <div className="decision-why">
        <span className="eyebrow">Why — root cause</span>
        {diagnosis ? (
          <>
            <p className="prose">{diagnosis.rootCause?.description}</p>
            <div className="row gap">
              <span className="muted small" style={{ width: 80 }}>
                Confidence
              </span>
              <ConfidenceBar value={diagnosis.rootCause?.confidence} />
            </div>
            {tools.length > 0 && (
              <div className="divider-dashed" style={{ borderTop: 'none', paddingTop: 0 }}>
                <span className="muted small">
                  Backed by {diagnosis.evidence.length} cited source{diagnosis.evidence.length === 1 ? '' : 's'}
                </span>
                <div className="chips">
                  {tools.map((t) => (
                    <span key={t} className="tool-chip">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {diagnosis.ruledOut?.length > 0 && (
              <div className="divider-dashed">
                <span className="muted small">Ruled out</span>
                <ul className="ruledout">
                  {diagnosis.ruledOut.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p className="prose tone-warn">
            The agent asked to act without submitting a diagnosis. Its runbook forbids that — consider rejecting.
          </p>
        )}
      </div>
    </section>
  );
}

function Arg({ name, value }) {
  return (
    <>
      <dt>{ARG_LABELS[name] ?? name}</dt>
      <dd className={name === 'reason' ? '' : 'mono'}>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
    </>
  );
}

/** trigger_rollback → rollback, clear_cache → cache clear */
export function friendly(tool) {
  const map = {
    trigger_rollback: 'rollback',
    restart_service: 'restart',
    scale_service: 'scale-up',
    clear_cache: 'cache clear',
  };
  return map[tool] ?? tool ?? 'action';
}
