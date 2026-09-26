// Generic polling hook.
//
// The rules that matter for a live demo, all of them learned the hard way:
//
//   - Pause when the tab is hidden. A rehearsal means alt-tabbing to Slack; the
//     dashboard should not keep hammering the backend the whole time.
//   - Abort in-flight requests on unmount and on dependency change, so a slow
//     response can't overwrite fresher state (or warn about setting state on an
//     unmounted component).
//   - Keep the last good data when a poll fails. A transient network blip must
//     not blank the screen the judge is looking at; the error surfaces as a
//     banner instead.
//   - Never let the interval stack up. One timer, one request at a time.

import { useCallback, useEffect, useRef, useState } from 'react';

export function usePolledResource(fetcher, { intervalMs = 2000, enabled = true, deps = [] } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const inFlight = useRef(false);

  const run = useCallback(async (signal) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      // The signal goes to the fetcher, which forwards it to fetch(). Without
      // this an aborted poll would still resolve and overwrite fresher state.
      const value = await fetcherRef.current(signal);
      setData(value);
      setError(null);
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    let timer = null;
    const controller = new AbortController();

    const tick = () => {
      if (document.hidden) return; // paused; the next tick will pick it up
      run(controller.signal);
    };

    run(controller.signal);
    timer = setInterval(tick, intervalMs);

    // Poll immediately when the tab comes back — otherwise the first thing a
    // returning user sees is up to `intervalMs` of stale data.
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, run, ...deps]);

  return { data, error, loading, refresh: run };
}
