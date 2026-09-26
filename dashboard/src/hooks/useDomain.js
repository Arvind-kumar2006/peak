// Domain hooks over usePolledResource. Thin on purpose — all the polling
// behaviour lives in one place so there is a single thing to reason about when
// the dashboard goes stale on stage.

import { useCallback, useState } from 'react';
import { api } from '../api/client.js';
import { usePolledResource } from './usePolledResource.js';

// contracts/backend-api.md: the dashboard polls every 2s.
const POLL_MS = 2000;

export function useHealth() {
  return usePolledResource((signal) => api.health(), { intervalMs: 10000 });
}

export function useIncidents() {
  const { data, error, loading, refresh } = usePolledResource(
    useCallback((signal) => api.listIncidents(signal), []),
    { intervalMs: POLL_MS },
  );
  return { incidents: data?.incidents ?? [], error, loading, refresh };
}

export function useIncident(id) {
  return usePolledResource(
    useCallback((signal) => (id ? api.getIncident(id, signal) : Promise.resolve(null)), [id]),
    { intervalMs: POLL_MS, enabled: Boolean(id), deps: [id] },
  );
}

export function useLiveMetrics() {
  return usePolledResource(
    useCallback((signal) => api.metrics(signal), []),
    { intervalMs: POLL_MS },
  );
}

/**
 * Approve / Reject.
 *
 * Deliberately *not* polled: these are one-shot commands. The hook tracks its
 * own pending/error state so the button can disable itself instantly and show a
 * failure inline, instead of the user pressing it and watching nothing happen.
 * That "dead button on stage" failure is the worst one this project has.
 */
export function useDecision(incidentId, onDone) {
  const [pending, setPending] = useState(null); // 'allow' | 'deny'
  const [error, setError] = useState(null);

  const decide = useCallback(
    async (decision, reason) => {
      if (!incidentId || pending) return;
      setPending(decision);
      setError(null);
      try {
        const updated =
          decision === 'allow' ? await api.approve(incidentId) : await api.reject(incidentId, reason);
        onDone?.(updated);
        return updated;
      } catch (err) {
        setError(err);
        throw err;
      } finally {
        setPending(null);
      }
    },
    [incidentId, pending, onDone],
  );

  return {
    approve: () => decide('allow'),
    reject: (reason) => decide('deny', reason),
    pending,
    error,
    clearError: () => setError(null),
  };
}
