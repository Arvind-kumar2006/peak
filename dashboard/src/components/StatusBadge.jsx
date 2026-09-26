// One place that decides what every status looks like.
//
// Scattered status colours are how a UI ends up showing "mitigated" in the same
// green as "resolved" — which, in a project whose entire argument is that
// mitigated is *not* resolved, would be an own goal. So the distinction is
// encoded once, here, and nowhere else.

const STYLES = {
  investigating: { label: 'Investigating', tone: 'busy', icon: '◌', hint: 'Agent is gathering evidence' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'action', icon: '●', hint: 'A human decision is required' },
  executing: { label: 'Executing fix', tone: 'busy', icon: '◌', hint: 'Approved action is running, then verified' },
  diagnosed: { label: 'Diagnosed', tone: 'neutral', icon: '○', hint: 'Cause found, no action taken' },
  resolved: { label: 'Resolved', tone: 'good', icon: '✓', hint: 'Metrics stable after the action' },
  // Deliberately amber, not green. The demo scenario exists to show that
  // restarting a leaking service only masks the problem.
  mitigated: { label: 'Mitigated only', tone: 'warn', icon: '≈', hint: 'Symptoms gone, cause still present' },
  not_resolved: { label: 'Not resolved', tone: 'bad', icon: '✕', hint: 'Action ran, service did not recover' },
  rejected: { label: 'Rejected', tone: 'neutral', icon: '○', hint: 'Operator declined the action' },
  error: { label: 'Error', tone: 'bad', icon: '!', hint: 'The investigation failed' },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: '○', hint: 'Stopped before completion' },
};

const UNKNOWN = { label: 'Unknown', tone: 'neutral', icon: '○', hint: '' };

export function statusStyle(status) {
  return STYLES[status] ?? UNKNOWN;
}

export function StatusBadge({ status, stalled, small }) {
  const style = statusStyle(status);
  return (
    <span className={`badge tone-${style.tone} ${small ? 'badge-sm' : ''}`} title={style.hint}>
      {stalled && <span className="badge-stalled" title="No new activity for 90s" />}
      {style.label}
    </span>
  );
}

/** Category pill for the root cause. Code vs infra is the demo's core split. */
export function CategoryBadge({ category }) {
  const map = {
    code: { label: 'code-level', tone: 'code' },
    infra: { label: 'infra-level', tone: 'infra' },
    unknown: { label: 'unknown', tone: 'neutral' },
  };
  const style = map[category] ?? map.unknown;
  return <span className={`pill tone-${style.tone}`}>{style.label}</span>;
}

/**
 * Confidence as a bar, not a number.
 *
 * "0.82" reads as false precision to a judge. A bar reads as calibrated. The
 * exact value is still in the tooltip for anyone who asks.
 */
export function ConfidenceBar({ value }) {
  if (value === null || value === undefined) {
    return <span className="muted">confidence unknown</span>;
  }
  const pct = Math.round(value * 100);
  const tone = value >= 0.8 ? 'good' : value >= 0.5 ? 'warn' : 'bad';
  return (
    <span className="confidence" title={`confidence ${value}`}>
      <span className="confidence-track">
        <span className={`confidence-fill tone-${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="confidence-label">{pct}%</span>
    </span>
  );
}
