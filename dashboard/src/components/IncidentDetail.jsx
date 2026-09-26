// Right column: everything about the selected incident, in narrative order.
//
// The order is the argument: what happened → what the agent concluded → what it
// wants to do → whether it worked → the raw trail. A judge should be able to
// read it top to bottom and never need to ask a question that the order itself
// raises.

import { StatusBadge } from './StatusBadge.jsx';
import { DiagnosisCard, EvidenceList, ResolutionCard } from './Diagnosis.jsx';
import { PendingActionCard } from './PendingActionCard.jsx';
import { MetricsChart } from './MetricsChart.jsx';

export function IncidentDetail({ incident, error, onDecided }) {
  if (error) {
    return (
      <main className="detail">
        <div className="alert alert-error" role="alert">
          <strong>Could not load this incident.</strong> {error.message}
        </div>
      </main>
    );
  }
  if (!incident) {
    return (
      <main className="detail">
        <div className="empty empty-lg">
          <h2>Select an incident</h2>
          <p className="muted">
            Trigger Scenario A or B on the left. The agent will investigate with read-only tools, propose one
            fix, and pause for your approval.
          </p>
        </div>
      </main>
    );
  }

  const decision = incident.decisions?.[0];

  return (
    <main className="detail">
      <header className="detail-head">
        <div className="detail-head-top">
          <StatusBadge status={incident.status} stalled={incident.stalled} />
          {incident.scenario && <code className="scenario-tag">{incident.scenario}</code>}
          <span className="spacer" />
          {incident.trueforgeUrl && (
            <a className="btn btn-ghost btn-sm" href={incident.trueforgeUrl} target="_blank" rel="noreferrer">
              Open in TrueForge ↗
            </a>
          )}
        </div>
        <h1 className="detail-title">{incident.diagnosis?.summary || headlineFor(incident)}</h1>
        {incident.error && <div className="alert alert-error">{incident.error}</div>}
        {incident.stalled && (
          <div className="alert alert-warn">
            No new activity for 90 seconds. The agent may be stuck or the runtime may be unreachable.
          </div>
        )}
        <DecisionBadge decision={decision} />
      </header>

      {/* Order matters: the approval card sits directly under the diagnosis it
          justifies, and the resolution below the chart that corroborates it. */}
      <PendingActionCard incident={incident} onDecided={onDecided} />

      <DiagnosisCard diagnosis={incident.diagnosis} />
      <EvidenceList evidence={incident.diagnosis?.evidence} />
      <MetricsChart
        samples={incident.metrics ?? []}
        decisionAt={decision?.at}
        resolution={incident.resolution}
      />
      <ResolutionCard resolution={incident.resolution} />
      <Timeline events={incident.timeline ?? []} />
    </main>
  );
}

function DecisionBadge({ decision }) {
  if (!decision) return null;
  const allowed = decision.decision === 'allow';
  return (
    <div className={`decision-badge ${allowed ? 'decision-allow' : 'decision-deny'}`}>
      <span className="decision-icon">{allowed ? '✓' : '✕'}</span>
      <div>
        <strong>{allowed ? 'Approved by operator' : 'Rejected by operator'}</strong>
        {decision.tool && (
          <div className="muted small">
            <code>{decision.tool}</code>
            {decision.reason && <> — {decision.reason}</>}
          </div>
        )}
      </div>
    </div>
  );
}

function headlineFor(incident) {
  switch (incident.status) {
    case 'investigating':
      // The agent submits its Diagnosis before asking to act, so reaching here
      // with a diagnosis present means it is still working, not stalled.
      return incident.diagnosis
        ? 'Diagnosis received — the agent is still working'
        : 'Investigating…';
    case 'awaiting_approval':
      return 'Diagnosis complete — waiting for your approval';
    case 'executing':
      return 'Running the approved fix…';
    default:
      return 'Incident';
  }
}

/**
 * The raw event trail, collapsed by default.
 *
 * This exists for the question every judge eventually asks: "show me that it
 * actually did the work." The answer is a scrollable list of the real tool
 * calls, not a claim that it did.
 */
function Timeline({ events }) {
  if (!events.length) return null;
  return (
    <details className="card timeline">
      <summary>
        <h2>Event trail</h2>
        <span className="muted small">{events.length} events from the agent runtime</span>
      </summary>
      <ol className="timeline-list">
        {events.map((e) => (
          <li key={e.id}>
            <span className="timeline-time">{new Date(e.at).toLocaleTimeString()}</span>
            <span className={`timeline-type type-${e.type.split('.')[0]}`}>{e.type}</span>
            <span className="timeline-detail">{describe(e)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function describe(event) {
  const p = event.payload ?? {};
  switch (event.type) {
    case 'model.message':
      if (p.tool_calls?.length) return p.tool_calls.map((c) => c.function?.name ?? c.name).filter(Boolean).join(', ');
      if (p.content) return String(p.content).slice(0, 120);
      return '';
    case 'tool.response':
      return `${p.name ?? 'tool'} ${String(p.content ?? '').slice(0, 90)}`.trim();
    case 'tool.approval_required':
      return `waiting on ${p.tool_calls?.length ?? 0} tool call(s)`;
    case 'turn.done':
      return `turn ${p.state?.status ?? 'done'}`;
    case 'demo.inject_failed':
      return p.message ?? '';
    default:
      return '';
  }
}
