import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useLive, useNow } from '../hooks.js';
import { Badge, Card, ErrorNote } from '../components/ui.jsx';
import { STATUS, duration, short, time } from '../format.js';

const STEPS = [
  { key: 'detected', label: 'Detected' },
  { key: 'investigating', label: 'Investigated' },
  { key: 'approval', label: 'Approved' },
  { key: 'fix', label: 'Fix applied' },
  { key: 'verify', label: 'Verified' },
];

function stepState(inc) {
  const s = inc.status;
  const done = {
    detected: true,
    investigating: !!inc.diagnosis,
    approval: inc.approval?.decision === 'approved',
    fix: !!inc.fix,
    verify: s === 'resolved',
    ...(inc.closure ? { investigating: true, approval: true, fix: true } : {}),
  };
  const current = { investigating: 'investigating', awaiting_approval: 'approval', fixing: 'fix', verifying: 'verify' }[s];
  const failed = { rejected: 'approval', unresolved: 'verify', failed: inc.fix ? 'verify' : inc.approval ? 'fix' : 'investigating', needs_attention: 'approval' }[s];
  return STEPS.map((st) => ({ ...st, state: done[st.key] ? 'done' : st.key === current ? 'current' : st.key === failed ? 'failed' : 'todo' }));
}

function Steps({ incident }) {
  return (
    <ol className="steps">
      {stepState(incident).map((s) => (
        <li key={s.key} className={s.state}>
          <span className="step-dot" />
          {s.label}
        </li>
      ))}
    </ol>
  );
}

// Errors/min across the incident, with markers for detection and the fix.
function IncidentChart({ samples, incident, threshold }) {
  const pts = samples.filter((s) => s.errorsPerMin != null);
  if (pts.length < 2) return null;
  const W = 640;
  const H = 140;
  const t0 = new Date(pts[0].at).getTime();
  const t1 = new Date(pts.at(-1).at).getTime();
  const max = Math.max(threshold * 1.5, ...pts.map((p) => p.errorsPerMin));
  const x = (iso) => ((new Date(iso).getTime() - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v) => H - (v / max) * (H - 12);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.errorsPerMin).toFixed(1)}`).join(' ');
  const markers = [
    { at: incident.startedAt, label: 'detected', cls: 'm-bad' },
    incident.fix && { at: incident.fix.appliedAt, label: 'fix applied', cls: 'm-good' },
  ].filter((m) => m && new Date(m.at).getTime() >= t0 && new Date(m.at).getTime() <= t1 + 60_000);
  return (
    <Card title="Errors per minute">
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="chart" preserveAspectRatio="none" role="img" aria-label="Errors per minute during the incident">
        <line x1="0" x2={W} y1={y(threshold)} y2={y(threshold)} className="threshold" />
        <path d={`${line} L${W},${H} L0,${H} Z`} className="area" />
        <path d={line} className="line" />
        {markers.map((m) => (
          <g key={m.label} className={m.cls}>
            <line x1={Math.min(x(m.at), W)} x2={Math.min(x(m.at), W)} y1="0" y2={H} />
            <text x={Math.min(x(m.at), W - 70) + 4} y={H + 14}>
              {m.label}
            </text>
          </g>
        ))}
      </svg>
      <div className="row between muted small">
        <span>{time(pts[0].at)}</span>
        <span>dashed line: alert threshold ({threshold}/min)</span>
        <span>{time(pts.at(-1).at)}</span>
      </div>
    </Card>
  );
}

function Diagnosis({ d }) {
  if (!d) return null;
  return (
    <Card title="Root cause" actions={<span className="muted small">confidence {Math.round(d.confidence * 100)}%</span>}>
      <p className="lead">{d.summary}</p>
      <p>{d.root_cause}</p>
      {d.suspect_commit && (
        <div className="commit">
          <span className="muted small">Likely caused by</span>
          <div>
            <code>{short(d.suspect_commit.sha)}</code> {d.suspect_commit.message?.split('\n')[0]}
            {d.suspect_commit.author && <span className="muted small"> · {d.suspect_commit.author}</span>}
          </div>
        </div>
      )}
      <h3>Evidence</h3>
      <ul className="evidence">
        {d.evidence.map((e, i) => (
          <li key={i}>
            <span className="source">{e.source}</span>
            {e.detail}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ProposedFix({ incident, onDone }) {
  const fix = incident.diagnosis?.proposed_fix;
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  if (!fix) return null;

  const act = async (what) => {
    setBusy(what);
    setError(null);
    try {
      await api(`/incidents/${incident.id}/${what}`, { method: 'POST', body: what === 'reject' ? { reason } : {} });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  if (fix.type === 'none') {
    return (
      <Card title="No automatic fix" className="fix">
        <p>{fix.reason}</p>
      </Card>
    );
  }

  const waiting = incident.status === 'awaiting_approval';
  const c = fix.commit;
  return (
    <Card title="Proposed fix" className={`fix ${waiting ? 'waiting' : ''}`}>
      <p className="lead">
        Revert commit <code>{short(fix.sha)}</code>
        {c?.message && <> — {c.message}</>}
      </p>
      <p>{fix.reason}</p>
      {fix.expected_outcome && <p className="muted">Expected: {fix.expected_outcome}</p>}
      {c && (
        <p className="muted small">
          Files: {c.files.map((f) => <code key={f}>{f}</code>).reduce((a, b) => [a, ' ', b])}
          {c.url && (
            <>
              {' · '}
              <a href={c.url} target="_blank" rel="noreferrer">
                view on GitHub
              </a>
            </>
          )}
        </p>
      )}
      <p className="muted small">PEAK adds a revert commit on top of the branch. History is not rewritten.</p>
      {waiting && !rejecting && (
        <div className="row">
          <button onClick={() => act('approve')} disabled={!!busy}>
            {busy === 'approve' ? 'Approving…' : 'Approve fix'}
          </button>
          <button className="secondary" onClick={() => setRejecting(true)} disabled={!!busy}>
            Reject
          </button>
        </div>
      )}
      {waiting && rejecting && (
        <div className="reject">
          <input placeholder="Why? (optional)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          <button className="danger" onClick={() => act('reject')} disabled={!!busy}>
            {busy === 'reject' ? 'Rejecting…' : 'Reject fix'}
          </button>
          <button className="ghost" onClick={() => setRejecting(false)}>
            Cancel
          </button>
        </div>
      )}
      {incident.approval && (
        <p className={`approval ${incident.approval.decision}`}>
          {incident.approval.decision === 'approved' ? '✓ Approved' : '✕ Rejected'} by {incident.approval.by} at {time(incident.approval.at)}
          {incident.approval.reason && <> — “{incident.approval.reason}”</>}
        </p>
      )}
      {incident.fix && (
        <p className="small">
          Applied as <code>{short(incident.fix.revertSha)}</code> on <code>{incident.fix.branch}</code>
          {incident.fix.url && (
            <>
              {' · '}
              <a href={incident.fix.url} target="_blank" rel="noreferrer">
                view commit
              </a>
            </>
          )}
        </p>
      )}
      <ErrorNote error={error} />
    </Card>
  );
}

function Verification({ incident }) {
  const v = incident.verification;
  if (incident.status === 'verifying' && !v) {
    return (
      <Card title="Verifying recovery">
        <p className="muted">Waiting for the fix to deploy, then watching health and errors…</p>
      </Card>
    );
  }
  if (!v) return null;
  const good = v.verdict === 'resolved';
  return (
    <Card title={good ? 'Recovery verified' : 'Not recovered'} className={`verify ${good ? 'good' : 'bad'}`}>
      <div className="stats">
        {v.before && v.after?.errorsPerMin != null && (
          <div>
            <span className="muted small">Errors</span>
            <strong>
              {v.before.errorsPerMin}/min → {v.after.errorsPerMin}/min
            </strong>
          </div>
        )}
        {v.after?.healthy != null && (
          <div>
            <span className="muted small">Health</span>
            <strong>{v.after.healthy ? 'Healthy' : 'Failing'}</strong>
          </div>
        )}
        {v.deploy?.release && (
          <div>
            <span className="muted small">Deployment</span>
            <strong>
              {v.deploy.confirmed ? 'Running' : 'Not seen'} <code>{short(v.deploy.release)}</code>
            </strong>
          </div>
        )}
        <div>
          <span className="muted small">Incident duration</span>
          <strong>{duration(new Date(incident.resolvedAt) - new Date(incident.startedAt))}</strong>
        </div>
      </div>
      {v.reason && <p>{v.reason}</p>}
      {v.error && <p>{v.error}</p>}
      <p className="muted small">Watched for {v.windowSec}s after the fix.</p>
    </Card>
  );
}

const RERUNNABLE = ['failed', 'needs_attention', 'unresolved', 'rejected'];

// Human overrides: close the incident by hand, or run the investigation again.
function IncidentActions({ incident, onDone }) {
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  if (incident.status === 'resolved') return null;

  const act = async (what, body) => {
    setBusy(what);
    setError(null);
    try {
      await api(`/incidents/${incident.id}/${what}`, { method: 'POST', body });
      setClosing(false);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="incident-actions">
      {closing ? (
        <div className="reject">
          <input placeholder="What fixed it? (optional)" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          <button onClick={() => act('resolve', { note })} disabled={!!busy}>
            {busy === 'resolve' ? 'Closing…' : 'Mark resolved'}
          </button>
          <button className="ghost" onClick={() => setClosing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="row">
          {RERUNNABLE.includes(incident.status) && (
            <button className="secondary small" onClick={() => act('rerun')} disabled={!!busy}>
              {busy === 'rerun' ? 'Starting…' : 'Re-run investigation'}
            </button>
          )}
          <button className="secondary small" onClick={() => setClosing(true)}>
            Mark resolved
          </button>
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

const EVENT_ICON = {
  detected: '🚨',
  agent: '🤖',
  'agent.tool': '›',
  'agent.tool_error': '!',
  'agent.error': '⚠',
  approval: '👤',
  verify: '⏱',
  resolved: '✅',
  unresolved: '⚠',
  needs_attention: '👀',
  'slack.error': '!',
  'verify.error': '!',
};

function Timeline({ events }) {
  return (
    <Card title="Timeline" className="timeline-card">
      <ol className="timeline">
        {events.map((e) => (
          <li key={e.id} className={e.kind.replace('.', '-')}>
            <span className="t-icon">{EVENT_ICON[e.kind] ?? '•'}</span>
            <div>
              <div>{e.title}</div>
              {e.detail?.error && <div className="t-error small">{e.detail.error}</div>}
              <div className="muted small">{time(e.at)}</div>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default function Incident() {
  const { id } = useParams();
  const { data, error, reload } = useLive(`/incidents/${id}`);
  const now = useNow();
  if (error) return <div className="center error-note">{error.message}</div>;
  if (!data) return <div className="center muted">Loading…</div>;
  const { incident, service, events, samples } = data;
  const st = STATUS[incident.status];
  const open = ['investigating', 'awaiting_approval', 'fixing', 'verifying'].includes(incident.status);
  const threshold = incident.signal?.threshold ?? 5;

  return (
    <div className="page">
      <Link to="/" className="muted small">
        ← Dashboard
      </Link>
      <div className="page-head">
        <div>
          <div className="row">
            <Badge tone={st?.tone} pulse={open}>
              {st?.label ?? incident.status}
            </Badge>
            <span className="muted small">
              {service.name} · started {time(incident.startedAt)} · {duration((incident.resolvedAt ? new Date(incident.resolvedAt) : now) - new Date(incident.startedAt))}
            </span>
          </div>
          <h1>{incident.title}</h1>
        </div>
        <div className="row">
          {incident.agent?.sessionUrl && (
            <a className="button secondary small" href={incident.agent.sessionUrl} target="_blank" rel="noreferrer">
              Agent session ↗
            </a>
          )}
        </div>
      </div>

      <IncidentActions incident={incident} onDone={reload} />
      {incident.closure && (
        <div className="banner good">
          ✓ Marked resolved by {incident.closure.by} at {time(incident.closure.at)}
          {incident.closure.note && <> — “{incident.closure.note}”</>}
        </div>
      )}

      <Steps incident={incident} />

      <div className="incident-grid">
        <div className="col">
          {incident.status === 'investigating' && !incident.diagnosis && (
            <Card title="Investigating">
              <p className="muted">The AI investigator is reading errors, recent commits and diffs. Progress shows in the timeline.</p>
            </Card>
          )}
          {incident.status === 'failed' && (
            <Card title="Investigation stopped" className="verify bad">
              <p>{incident.agent?.error}</p>
            </Card>
          )}
          <ProposedFix incident={incident} onDone={reload} />
          <Verification incident={incident} />
          <Diagnosis d={incident.diagnosis} />
          <IncidentChart samples={samples} incident={incident} threshold={threshold} />
          {incident.agent?.summary && (
            <Card title="Agent summary">
              <p>{incident.agent.summary}</p>
            </Card>
          )}
        </div>
        <div className="col side">
          <Timeline events={events} />
        </div>
      </div>
    </div>
  );
}
