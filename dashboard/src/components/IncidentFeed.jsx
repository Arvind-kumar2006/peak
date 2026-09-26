// Left rail: the operator controls that start things, then the incident feed.

import { statusStyle } from './StatusBadge.jsx';

const SCENARIOS = [
  { key: 'conn-leak', label: 'A · Connection leak', hint: 'Bad deploy leaks Postgres clients' },
  { key: 'mem-leak', label: 'B · Memory blowup', hint: 'Cache grows without eviction, no deploy' },
];

export function SimulateBar({ onSimulate, onReset, busy }) {
  return (
    <div className="rail-section">
      <span className="eyebrow">Simulate an incident</span>
      {SCENARIOS.map((s) => (
        <button key={s.key} className="scenario-btn" disabled={busy} onClick={() => onSimulate(s.key)}>
          <strong>{s.label}</strong>
          <span>{s.hint}</span>
        </button>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={onReset} disabled={busy}>
        Reset service to healthy
      </button>
    </div>
  );
}

export function IncidentFeed({ incidents, selectedId, onSelect, loading }) {
  return (
    <div className="rail-section">
      <span className="eyebrow">Incidents{incidents.length > 0 && ` · ${incidents.length}`}</span>

      {loading && incidents.length === 0 && <p className="empty">Loading…</p>}
      {!loading && incidents.length === 0 && (
        <div className="empty">
          <p>No incidents yet.</p>
          <p>Trigger a scenario above to watch the agent investigate.</p>
        </div>
      )}

      <ul className="feed-list">
        {incidents.map((incident) => {
          const style = statusStyle(incident.status);
          const active = incident.id === selectedId;
          return (
            <li key={incident.id}>
              <button
                className={`feed-item ${active ? `feed-item-active is-${style.tone}` : ''}`}
                onClick={() => onSelect(incident.id)}
                aria-current={active ? 'true' : undefined}
              >
                <span className="feed-item-top">
                  <span className={`feed-status tone-${style.tone}`}>
                    {style.icon} {style.label}
                  </span>
                  <span className="feed-time">{formatAge(incident.createdAt)}</span>
                </span>
                <span className="feed-item-title">{shortTitle(incident)}</span>
                <FeedMeta incident={incident} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FeedMeta({ incident }) {
  if (incident.status === 'awaiting_approval' && incident.pendingTool) {
    return <span className="feed-item-meta is-action">→ {incident.pendingTool}</span>;
  }
  // A rejected incident is terminal, but the agent's turn still owes us a Resolution.
  if (!incident.turnDone && incident.status === 'rejected') {
    return <span className="feed-item-meta">wrapping up…</span>;
  }
  if (incident.pendingTool && incident.status !== 'investigating') {
    const verb = incident.status === 'rejected' ? 'declined' : incident.status === 'executing' ? 'running' : 'ran';
    return <span className="feed-item-meta">{incident.pendingTool} {verb}</span>;
  }
  return <span className="feed-item-meta">{incident.error ? 'agent error' : 'agent investigating'}</span>;
}

/** "Connection leak · 5a824ff" — the feed needs a name, not the full diagnosis sentence. */
function shortTitle(incident) {
  const kind =
    incident.scenario === 'conn-leak'
      ? 'Connection leak'
      : incident.scenario === 'mem-leak'
        ? 'Memory blowup'
        : incident.rootCauseCategory === 'code'
          ? 'Code regression'
          : incident.rootCauseCategory === 'infra'
            ? 'Infrastructure issue'
            : 'Incident';
  if (incident.commitSha) return `${kind} · ${incident.commitSha.slice(0, 7)}`;
  if (incident.rootCauseCategory === 'infra') return `${kind} · no deploy`;
  return kind;
}

function formatAge(iso) {
  if (!iso) return '';
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}
