// Left column: the incident feed, plus the operator controls that start things.

import { StatusBadge } from './StatusBadge.jsx';

const SCENARIOS = [
  {
    key: 'conn-leak',
    label: 'Scenario A — connection leak',
    hint: 'A bad commit leaks Postgres clients. Correct fix: roll back.',
  },
  {
    key: 'mem-leak',
    label: 'Scenario B — memory blowup',
    hint: 'Unbounded cache growth, no deploy. Correct fix: clear cache.',
  },
];

export function SimulateBar({ onSimulate, onReset, busy }) {
  return (
    <div className="simulate-bar">
      {SCENARIOS.map((s) => (
        <button
          key={s.key}
          className="btn btn-scenario"
          title={s.hint}
          disabled={busy}
          onClick={() => onSimulate(s.key)}
        >
          {s.label}
        </button>
      ))}
      <button className="btn btn-ghost" onClick={onReset} disabled={busy}>
        Reset demo
      </button>
    </div>
  );
}

export function IncidentFeed({ incidents, selectedId, onSelect, loading }) {
  return (
    <aside className="feed">
      <h2 className="feed-title">
        Incidents
        {incidents.length > 0 && <span className="count">{incidents.length}</span>}
      </h2>

      {loading && incidents.length === 0 && <p className="muted">Loading…</p>}

      {!loading && incidents.length === 0 && (
        <div className="empty">
          <p>No incidents yet.</p>
          <p className="muted small">Trigger a scenario above to watch the agent investigate.</p>
        </div>
      )}

      <ul className="feed-list">
        {incidents.map((incident) => (
          <li key={incident.id}>
            <button
              className={`feed-item ${incident.id === selectedId ? 'feed-item-active' : ''}`}
              onClick={() => onSelect(incident.id)}
            >
              <div className="feed-item-top">
                <StatusBadge status={incident.status} stalled={incident.stalled} small />
                <span className="feed-time">{formatAge(incident.createdAt)}</span>
              </div>
              <div className="feed-item-title">
                {incident.summary || scenarioLabel(incident.scenario) || 'Investigating…'}
              </div>
              <div className="feed-item-meta">
                {incident.scenario && <code>{incident.scenario}</code>}
                {incident.pendingTool && <code className="pending">{incident.pendingTool}</code>}
                {incident.rootCauseCategory && <code>{incident.rootCauseCategory}</code>}
                {/* A rejected incident is terminal, but the agent's turn is still
                    running and owes us a Resolution — say so rather than looking frozen. */}
                {!incident.turnDone && incident.status === 'rejected' && (
                  <code className="pending">wrapping up</code>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function scenarioLabel(scenario) {
  if (scenario === 'conn-leak') return 'Connection leak incident';
  if (scenario === 'mem-leak') return 'Memory blowup incident';
  return 'Untriaged incident';
}

function formatAge(iso) {
  if (!iso) return '';
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}
