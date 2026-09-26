import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// GET a resource and refetch whenever the server pushes a change (SSE), plus a slow poll as backup.
export function useLive(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    try {
      const d = await api(pathRef.current);
      setData(d);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    reload();
    let timer;
    const es = new EventSource('/api/stream');
    es.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(reload, 150);
    };
    const poll = setInterval(reload, 15000);
    return () => {
      es.close();
      clearInterval(poll);
      clearTimeout(timer);
    };
  }, [path, reload]);

  return { data, error, reload };
}

// Re-render every second (for live durations).
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
