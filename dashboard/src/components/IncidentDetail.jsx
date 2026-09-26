// Right column: everything about the selected incident.
//
// Layout follows the moment, because the question on screen changes:
//   awaiting approval → "should I let it do this?"  decision panel first
//   finished          → "did it work?"              outcome first
//   in progress       → "what is it doing?"         stepper + live chart
// The stepper is always there, so the whole loop — investigate, diagnose,
// approve, execute, verify — is legible at a glance from across a room.

import { StatusBadge, statusStyle } from './StatusBadge.jsx';
import { DiagnosisCard, EvidenceList, OutcomeCard } from './Diagnosis.jsx';
import { PendingActionCard, friendly } from './PendingActionCard.jsx';
import { MetricsChart } from './MetricsChart.jsx';

export function IncidentDetail({ incident, error, onDecided }) {
  if (error && !incident) {
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
          <h2>No incident selected</h2>
          <p>
            Simulate Scenario A or B on the left. The agent investigates with read-only tools, proposes one fix, and
            waits for your approval before anything changes.
          </p>
        </div>
      </main>
    );
  }

  const decision = incident.decisions?.[0] ?? null;
  const awaiting = incident.status === 'awaiting_approval';
  const finished = Boolean(incident.resolution);

  return (
    <main className="detail">
      <header className="detail-head">
        <div className="detail-head-top">
          <StatusBadge status={incident.status} stalled={incident.stalled} />
          <span className="detail-meta">{metaLine(incident, decision)}</span>
          <span className="spacer" />
          {incident.trueforgeUrl && (
            <a className="btn btn-sm btn-ghost" href={incident.trueforgeUrl} target="_blank" rel="noreferrer">
              Open reasoning trail ↗
            </a>
          )}
        </div>
        <h1 className="detail-title">{headline(incident, decision)}</h1>
        <Stepper incident={incident} decision={decision} />
        {incident.error && <div className="alert alert-error">{incident.error}</div>}
        {incident.stalled && (
          <div className="alert alert-warn">
            No new activity for 90 seconds. The agent may be stuck or the runtime may be unreachable.
          </div>
        )}
      </header>

      {awaiting && <PendingActionCard incident={incident} onDecided={onDecided} />}
      {finished && <OutcomeCard resolution={incident.resolution} />}
      {!awaiting && !finished && decision && <DecisionNotice decision={decision} turnDone={incident.turnDone} />}

      {/* The line is red while the incident is live. */}
      <MetricsChart
        samples={incident.metrics ?? []}
        decisionAt={decision?.decision === 'allow' ? decision.at : null}
        resolution={incident.resolution}
        scenario={incident.scenario}
        active={!finished && incident.status !== 'error'}
      />

      <div className="grid-2">
        <DiagnosisCard diagnosis={incident.diagnosis} />
        <EvidenceList evidence={incident.diagnosis?.evidence} />
      </div>

      <Timeline events={incident.timeline ?? []} />
    </main>
  );
}

function DecisionNotice({ decision, turnDone }) {
  const allowed = decision.decision === 'allow';
  return (
    <div className="notice" role="status">
      <span className={allowed ? 'tone-good' : 'tone-neutral'}>{allowed ? '✓' : '○'}</span>
      <span>
        <strong>{allowed ? 'Approved' : 'Rejected'}</strong>{' '}
        {decision.tool && <code>{decision.tool}</code>}
        {allowed
          ? ' — running it now, then watching the metrics for 60 seconds before giving a verdict.'
          : ` — nothing was run.${turnDone ? '' : ' The agent is writing up its report.'}`}
      </span>
    </div>
  );
}

function metaLine(incident, decision) {
  const d = incident.diagnosis;
  const parts = [];
  if (d?.rootCause?.category === 'code') parts.push('Code-level');
  if (d?.rootCause?.category === 'infra') parts.push('Infra-level');
  if (Number.isFinite(d?.rootCause?.confidence)) parts.push(`confidence ${Math.round(d.rootCause.confidence * 100)}%`);
  if (decision) {
    const who = decision.decision === 'allow' ? 'Approved' : 'Rejected';
    parts.push(`${who} at ${new Date(decision.at).toLocaleTimeString()}`);
  }
  if (incident.resolution?.windowSec) parts.push(`verified over ${incident.resolution.windowSec}s`);
  return parts.join(' · ');
}

function headline(incident, decision) {
  const d = incident.diagnosis;
  const r = incident.resolution;
  if (r && d) {
    const action = friendly(r.actionTaken);
    switch (r.verdict) {
      case 'resolved':
        return `${d.summary} Fixed by ${action} — verified.`;
      case 'mitigated':
        return `The ${action} cleared the symptoms, but the cause is still there.`;
      case 'not_resolved':
        return `The ${action} did not bring the service back.`;
      case 'rejected':
        return `${d.summary} The proposed ${action} was rejected.`;
      default:
        return d.summary;
    }
  }
  if (d?.summary) return d.summary;
  switch (incident.status) {
    case 'investigating':
      return 'Investigating — the agent is gathering evidence…';
    case 'executing':
      return decision ? `Running the approved ${friendly(decision.tool)}…` : 'Running the approved fix…';
    case 'error':
      return 'The investigation failed.';
    default:
      return statusStyle(incident.status).label;
  }
}

/** investigate → diagnose → approve → execute → verify */
function Stepper({ incident, decision }) {
  const s = incident.status;
  const d = incident.diagnosis;
  const r = incident.resolution;
  const denied = decision?.decision === 'deny' || r?.verdict === 'rejected';
  const allowed = decision?.decision === 'allow' || (r && r.verdict !== 'rejected' && r.actionTaken !== 'none');
  const failed = s === 'error';

  // Tool calls before the approval gate = the investigation itself.
  const timeline = incident.timeline ?? [];
  const gate = timeline.findIndex((e) => e.type === 'tool.approval_required');
  const investigateTools = (gate === -1 ? timeline : timeline.slice(0, gate)).filter((e) => e.type === 'tool.response').length;
  const steps = [
    {
      label: d ? 'Investigate' : 'Investigating…',
      state: d ? 'done' : failed ? 'bad' : 'busy',
      extra: d && investigateTools ? ` · ${investigateTools} tool calls` : '',
    },
    { label: 'Diagnose', state: d ? 'done' : failed ? 'bad' : 'todo' },
    {
      label: denied ? 'Rejected' : allowed ? 'Approved' : s === 'awaiting_approval' ? 'Approve — you' : 'Approve',
      state: denied ? 'skipped' : allowed ? 'done' : s === 'awaiting_approval' ? 'current' : 'todo',
    },
    {
      label: allowed && r ? `Executed ${friendly(r.actionTaken)}` : 'Execute',
      state: denied ? 'skipped' : r && allowed ? 'done' : s === 'executing' ? 'busy' : 'todo',
    },
    {
      label: r && !denied ? verifyLabel(r) : 'Verify · 60s window',
      state: denied ? 'skipped' : r ? verifyState(r.verdict) : s === 'executing' ? 'busy' : 'todo',
    },
  ];

  return (
    <ol className="stepper" aria-label="Incident progress">
      {steps.map((step) => (
        <li key={step.label} className={`step step-${step.state}`}>
          <span className="step-bar" />
          <span>
            {{ done: '✓ ', current: '● ', warn: '≈ ', bad: '✕ ' }[step.state] ?? ''}
            {step.label}
            {step.extra ?? ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

function verifyState(verdict) {
  return verdict === 'resolved' ? 'done' : verdict === 'mitigated' ? 'warn' : 'bad';
}

function verifyLabel(r) {
  if (r.verdict === 'resolved') return 'Verified healthy';
  if (r.verdict === 'mitigated') return 'Verify · symptoms returned';
  return 'Verify · still unhealthy';
}

/**
 * The raw event trail, collapsed by default — the answer to "show me that it
 * actually did the work": the real tool calls, not a claim that it did.
 */
function Timeline({ events }) {
  if (!events.length) return null;
  // tool.response events carry only the call id; name them from the model.message that made the call.
  const names = new Map();
  for (const e of events) {
    for (const c of e.payload?.tool_calls ?? []) names.set(c.id, c.function?.name ?? c.name);
  }
  const calls = events.filter((e) => e.type === 'tool.response').length;
  return (
    <details className="card">
      <summary>
        <h2 className="eyebrow">Reasoning trail</h2>
        <span className="muted small">
          {events.length} events · {calls} tool calls
        </span>
      </summary>
      <ol className="timeline-list">
        {events.map((e) => (
          <li key={e.id}>
            <span className="timeline-time">{new Date(e.at).toLocaleTimeString()}</span>
            <span className={`timeline-type type-${e.type.split('.')[0]}`}>{e.type}</span>
            <span className="timeline-detail">{describe(e, names)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function describe(event, names) {
  const p = event.payload ?? {};
  switch (event.type) {
    case 'model.message':
      if (p.tool_calls?.length) return `calls ${p.tool_calls.map((c) => c.function?.name ?? c.name).filter(Boolean).join(', ')}`;
      if (p.content) return String(p.content).slice(0, 160);
      return '';
    case 'tool.response':
      return `${names.get(p.tool_call_id) ?? p.name ?? 'tool'} → ${String(p.content ?? '').slice(0, 110)}`;
    case 'tool.approval_required':
      return `holding ${p.tool_calls?.length ?? 0} call(s) for human approval`;
    case 'turn.done':
      return p.state?.required_actions?.length ? 'turn paused for approval' : `turn ${p.state?.status ?? 'done'}`;
    case 'demo.inject_failed':
      return p.message ?? '';
    default:
      return '';
  }
}
