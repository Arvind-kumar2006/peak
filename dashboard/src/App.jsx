import { useCallback, useEffect, useState } from 'react';
import { api } from './api/client.js';
import { useHealth, useIncident, useIncidents, useLiveMetrics } from './hooks/useDomain.js';
import { SimulateBar, IncidentFeed } from './components/IncidentFeed.jsx';
import { IncidentDetail } from './components/IncidentDetail.jsx';
import { LiveStrip } from './components/LiveStrip.jsx';

export default function App() {
  const { incidents, error: listError } = useIncidents();
  const { data: health } = useHealth();
  const { data: liveMetrics, error: metricsError } = useLiveMetrics();

  // Auto-select the newest incident so triggering a scenario immediately shows
  // something. During a demo nobody should have to click twice to see the thing
  // they just caused.
  const [selectedId, setSelectedId] = useState(null);
  useEffect(() => {
    if (!incidents.length) return;
    if (!selectedId || !incidents.some((i) => i.id === selectedId)) {
      setSelectedId(incidents[0].id);
    }
  }, [incidents, selectedId]);

  const { data: incident, error: incidentError, refresh } = useIncident(selectedId);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const onSimulate = useCallback(async (scenario) => {
    setBusy(true);
    setActionError(null);
    try {
      const created = await api.createIncident(scenario);
      setSelectedId(created.id);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }, []);

  const onReset = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await api.reset();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }, []);

  const onDecided = useCallback(() => refresh(), [refresh]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">PEAK</span>
          <span className="brand-sub">AI production incident response</span>
        </div>
        <LiveStrip metrics={liveMetrics} error={metricsError} />
        <div className="badges">
          {health && (
            <>
              <span
                className={`pill ${health.agent?.mode === 'real' ? 'tone-good' : 'tone-warn'}`}
                title={
                  health.agent?.mode === 'real'
                    ? `Connected to TrueForge at ${health.agent.url}`
                    : 'Running the scripted fake agent — no model calls, no API key'
                }
              >
                agent: {health.agent?.mode ?? '?'}
              </span>
              <span className="pill tone-neutral" title={`Incidents persist in the ${health.store?.kind} store`}>
                store: {health.store?.kind ?? '?'}
              </span>
            </>
          )}
        </div>
      </header>

      <SimulateBar onSimulate={onSimulate} onReset={onReset} busy={busy} />

      {actionError && (
        <div className="alert alert-error banner" role="alert">
          <strong>Action failed.</strong> {actionError.message}
          <button className="link" onClick={() => setActionError(null)}>
            dismiss
          </button>
        </div>
      )}
      {listError && (
        <div className="alert alert-error banner" role="alert">
          <strong>Backend unreachable.</strong> {listError.message}
        </div>
      )}

      <div className="layout">
        <IncidentFeed
          incidents={incidents}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={!incidents.length && !listError}
        />
        <IncidentDetail incident={incident} error={incidentError} onDecided={onDecided} />
      </div>
    </div>
  );
}
