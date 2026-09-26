// The one place that talks to the backend.
//
// Every request goes through `request()` so error handling is uniform: a failed
// call becomes a readable message the UI can display, never an unhandled
// rejection that silently freezes a panel mid-demo.

const BASE = '/api';

/** An error that carries a message fit for a human. */
export class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // "Failed to fetch" means the backend isn't running. Say that plainly —
    // it is the single most common thing that goes wrong during a rehearsal.
    throw new ApiError(`Cannot reach the backend at ${BASE}. Is it running on port 4000?`, { code: 'offline' });
  }

  const text = await res.text();
  const data = text ? safeParse(text) : null;

  if (!res.ok) {
    throw new ApiError(data?.message || `${method} ${path} failed (${res.status})`, {
      status: res.status,
      code: data?.error,
    });
  }
  return data;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  health: () => request('/health'),
  listIncidents: () => request('/incidents'),
  getIncident: (id, signal) => request(`/incidents/${id}`, { signal }),
  createIncident: (scenario) => request('/incidents', { method: 'POST', body: { scenario } }),
  approve: (id) => request(`/incidents/${id}/approve`, { method: 'POST' }),
  reject: (id, reason) => request(`/incidents/${id}/reject`, { method: 'POST', body: { reason } }),
  reset: () => request('/demo/reset', { method: 'POST' }),
  metrics: (signal) => request('/metrics', { signal }),
};
