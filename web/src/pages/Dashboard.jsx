import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useLive, useNow } from '../hooks.js';
import { Badge, Card, Sparkline } from '../components/ui.jsx';
import { STATUS, SERVICE_STATUS, ago, duration, short } from '../format.js';

const dedupe = (list) => [...new Map(list.map((i) => [i.id, i])).values()];

const OPEN = ['investigating', 'awaiting_approval', 'fixing', 'verifying'];

function overall(services, incidents) {
  if (incidents.some((i) => i.status === 'awaiting_approval')) return { tone: 'accent', label: 'Fix waiting for approval' };
  if (incidents.some((i) => OPEN.includes(i.status))) return { tone: 'warn', label: 'Incident in progress' };
  if (services.some((s) => s.status === 'down')) return { tone: 'bad', label: 'Service down' };
  if (services.some((s) => s.status === 'degraded')) return { tone: 'warn', label: 'Degraded' };
  if (services.length && services.every((s) => s.status === 'healthy')) return { tone: 'good', label: 'All systems healthy' };
  return { tone: 'muted', label: 'Waiting for data' };
}

function SetupChecklist({ integrations, services }) {
  const steps = [
    ...integrations.map((i) => ({ done: i.connected, label: `Connect ${i.kind === 'github' ? 'GitHub' : i.kind[0].toUpperCase() + i.kind.slice(1)}` })),
    { done: services.length > 0, label: 'Add a service to watch' },
  ];
  return (
    <Card className="checklist">
      <div className="row between">
        <div>
          <h2>Finish setting up</h2>
          <ul>
            {steps.map((s) => (
              <li key={s.label} className={s.done ? 'done' : ''}>
                {s.done ? '✓' : '○'} {s.label}
              </li>
            ))}
          </ul>
        </div>
        <Link className="button" to="/setup">
          Continue setup
        </Link>
      </div>
    </Card>
  );
}

// Snooze alerts during a deploy or maintenance window. Checks keep running.
// "until 14:30" today, "until Tue 14:30" on another day.
function untilLabel(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

// Snooze alerts during a deploy or maintenance window. Checks keep running.
// The menu only closes once the server confirmed; a failure is shown, never swallowed.
function MuteControl({ service }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mute = async (minutes) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/services/${service.id}/mute`, { method: 'POST', body: { minutes } });
      setOpen(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const failed = error && <span className="t-error small">{muteError(error)}</span>;
  if (service.mutedUntil) {
    return (
      <span className="mute-menu">
        <span className="muted-tag" title={service.muteReason ?? ''}>
          🔕 muted until {untilLabel(service.mutedUntil)}
        </span>
        <button className="ghost small" onClick={() => mute(0)} disabled={busy}>
          Unmute
        </button>
        {failed}
      </span>
    );
  }
  if (!open) {
    return (
      <button className="ghost small" onClick={() => setOpen(true)} title="Pause alerts for a deploy or maintenance">
        Mute
      </button>
    );
  }
  return (
    <span className="mute-menu">
      {[
        [30, '30m'],
        [60, '1h'],
        [240, '4h'],
      ].map(([m, label]) => (
        <button key={m} className="secondary small" onClick={() => mute(m)} disabled={busy}>
          {label}
        </button>
      ))}
      <button className="ghost small" onClick={() => (setOpen(false), setError(null))}>
        ✕
      </button>
      {failed}
    </span>
  );
}
const muteError = (err) => `Not changed: ${err.message}`;

// First page comes with the overview. Its cursor is captured once, on the first click, so a
// new incident arriving between loads can't shift it; rows are de-duplicated by id anyway.
function useOlderIncidents(firstPageNext) {
  const [older, setOlder] = useState([]);
  const [cursor, setCursor] = useState(undefined); // undefined = not started yet
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const next = cursor === undefined ? firstPageNext : cursor;
  const loadMore = async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api(`/incidents?limit=25&after=${encodeURIComponent(next)}`);
      setOlder((o) => [...o, ...page.items]);
      setCursor(page.next);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };
  return { older, hasMore: !!next, loadMore, loading, error };
}

export default function Dashboard() {
  const { data, error } = useLive('/overview');
  const now = useNow();
  const paging = useOlderIncidents(data?.incidentsNext ?? null);
  if (error) return <div className="center error-note">{error.message}</div>;
  if (!data) return <div className="center muted">Loading…</div>;

  const { services, incidents, integrations, agent, monitor } = data;
  const status = overall(services, incidents);
  const active = incidents.filter((i) => OPEN.includes(i.status));
  const serviceName = Object.fromEntries(services.map((s) => [s.id, s.name]));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Monitor</p>
          <h1>Production</h1>
          <p className="page-copy">
            Checked every {monitor.intervalSec}s · alerts at {monitor.errorThresholdPerMin} errors/min, {monitor.failedChecksToAlert} failed health checks, or a service's latency threshold
          </p>
        </div>
        <Badge tone={status.tone} pulse={status.tone !== 'good' && status.tone !== 'muted'}>
          {status.label}
        </Badge>
      </div>

      {!agent.ready && (
        <div className="banner warn">
          <strong>AI investigator offline.</strong> {agent.error ?? 'Connecting to TrueForge…'} Incidents are still detected, but not investigated.
        </div>
      )}
      {!data.setupComplete && <SetupChecklist integrations={integrations} services={services} />}

      {active.map((inc) => (
        <Link key={inc.id} to={`/incidents/${inc.id}`} className={`active-incident ${inc.status}`}>
          <div className="body">
            <div className="row">
              <Badge tone={STATUS[inc.status].tone} pulse>
                {STATUS[inc.status].label}
              </Badge>
              <span className="muted small">
                {serviceName[inc.serviceId]} · {duration(now - new Date(inc.startedAt))}
              </span>
            </div>
            <h3>{inc.title}</h3>
            {inc.diagnosis && <p>{inc.diagnosis.summary}</p>}
          </div>
          <div className="go">
            <span className="button">{inc.status === 'awaiting_approval' ? 'Review fix →' : 'Open →'}</span>
          </div>
        </Link>
      ))}

      <Card title="Services">
        {services.length === 0 ? (
          <p className="muted">
            No services yet. <Link to="/setup">Add one</Link>.
          </p>
        ) : (
          <div className="services">
            {services.map((s) => (
              <div key={s.id} className="service">
                <div className="service-main">
                  <span className="service-name">
                    <span className={`status-dot ${s.status}`} aria-hidden="true" />
                    {s.name}
                  </span>
                  <span className="muted small">
                    {SERVICE_STATUS[s.status]?.label}
                    {s.release && (
                      <>
                        {' '}
                        · release <code>{short(s.release)}</code>
                      </>
                    )}
                    {' · '}checked {ago(s.lastCheckedAt, now)}
                  </span>
                  <MuteControl service={s} />
                </div>
                <Sparkline samples={s.samples} threshold={monitor.errorThresholdPerMin} />
                <div className="service-num">
                  {s.samples.at(-1)?.errorsPerMin != null ? (
                    <>
                      <strong className={s.samples.at(-1).errorsPerMin >= monitor.errorThresholdPerMin ? 'hot' : ''}>{s.samples.at(-1).errorsPerMin}</strong>
                      <span className="muted small"> err/min</span>
                    </>
                  ) : s.samples.at(-1)?.latencyMs != null ? (
                    <>
                      <strong>{s.samples.at(-1).latencyMs}</strong>
                      <span className="muted small"> ms</span>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Recent incidents">
        {incidents.length === 0 ? (
          <p className="muted">No incidents yet. PEAK opens one when a service crosses its alert threshold.</p>
        ) : (
          <div className="table-wrap">
          <table className="table clickable">
            <thead>
              <tr>
                <th>Incident</th>
                <th>Service</th>
                <th>Status</th>
                <th>Cause</th>
                <th>Started</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {dedupe([...incidents, ...paging.older]).map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link to={`/incidents/${i.id}`}>{i.title}</Link>
                  </td>
                  <td>{serviceName[i.serviceId] ?? '—'}</td>
                  <td>
                    <Badge tone={STATUS[i.status]?.tone}>{STATUS[i.status]?.label ?? i.status}</Badge>
                  </td>
                  <td className="small">{i.diagnosis?.suspect_commit ? <code>{short(i.diagnosis.suspect_commit.sha)}</code> : <span className="muted">—</span>}</td>
                  <td className="muted small">{ago(i.startedAt, now)}</td>
                  <td className="muted small">{duration((i.resolvedAt ? new Date(i.resolvedAt) : now) - new Date(i.startedAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {paging.error && <div className="error-note">Couldn't load older incidents: {paging.error.message}</div>}
        {paging.hasMore && (
          <div className="load-more">
            <button className="secondary small" onClick={paging.loadMore} disabled={paging.loading}>
              {paging.loading ? 'Loading…' : 'Load older incidents'}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
