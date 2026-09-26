// The approval card — the most important 200px on the page.
//
// This is where the project's whole safety claim becomes visible: a proposed
// production action, held, with the evidence that justified it, waiting for a
// person. Design rules that follow from that:
//
//   - Show the exact tool and args. "Rollback?" is not reviewable; a deploy id
//     and a reason are.
//   - Never disable Approve without saying why.
//   - On failure, show the error inline and re-enable. A button that silently
//     does nothing is the worst outcome on stage.

import { useState } from 'react';
import { useDecision } from '../hooks/useDomain.js';

export function PendingActionCard({ incident, onDecided }) {
  const action = incident.pendingAction;
  const canDecide = incident.status === 'awaiting_approval';
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');
  const { approve, reject, pending, error, clearError } = useDecision(incident.id, onDecided);

  if (!action) return null;

  const deciding = pending !== null;

  async function onReject() {
    try {
      await reject(reason.trim() || undefined);
      setShowReject(false);
    } catch {
      // Already surfaced via `error`; the card stays open so the operator can retry.
    }
  }

  return (
    <section className="card card-approval" aria-live="polite">
      <header className="card-head">
        <h2>Proposed action</h2>
        {canDecide ? (
          <span className="pill tone-action">human approval required</span>
        ) : (
          <span className="pill tone-neutral">
            {incident.decision === 'allow' ? 'approved' : incident.decision === 'deny' ? 'rejected' : 'decided'}
          </span>
        )}
      </header>

      {action.unavailable || !action.tool ? (
        <p className="warn-text">
          The agent runtime is waiting for approval, but we could not identify which tool call it wants
          approved. Open the TrueForge session to see the details.
        </p>
      ) : (
        <>
          <div className="action-tool">
            <code>{action.tool}</code>
          </div>
          <pre className="action-args">{JSON.stringify(action.args ?? {}, null, 2)}</pre>
        </>
      )}

      {action.extras?.length > 0 && (
        <p className="muted small">
          The agent also requested {action.extras.length} additional tool call(s):{' '}
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

      {canDecide ? (
        showReject ? (
          <div className="reject-box">
            <label htmlFor="reject-reason">Why are you rejecting this?</label>
            <textarea
              id="reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="optional — shown to nobody but the incident record"
              rows={2}
              autoFocus
            />
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
          <div className="row gap">
            <button className="btn btn-approve" onClick={approve} disabled={deciding}>
              {pending === 'allow' ? 'Approving…' : 'Approve & run'}
            </button>
            <button className="btn btn-ghost" onClick={() => setShowReject(true)} disabled={deciding}>
              Reject
            </button>
          </div>
        )
      ) : (
        !incident.turnDone && <p className="muted small">Agent is wrapping up…</p>
      )}
    </section>
  );
}
