// HTTP health check. Healthy = 2xx within the timeout. If the body is JSON and names the
// running release (release / version / commit / sha), PEAK uses it to confirm a fix deployed.
const RELEASE_KEYS = ['release', 'commit', 'sha', 'gitSha', 'git_sha', 'version'];

export async function checkHealth(url, { timeoutMs = 5000 } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'peak-monitor' } });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    let release = null;
    try {
      const body = JSON.parse(text);
      const key = RELEASE_KEYS.find((k) => typeof body?.[k] === 'string' && body[k]);
      release = key ? body[key].slice(0, 64) : null;
    } catch {}
    return { healthy: res.ok, statusCode: res.status, latencyMs, release, error: res.ok ? null : `HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    return { healthy: false, statusCode: null, latencyMs: Date.now() - started, release: null, error: err.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err.message };
  }
}

// Does a reported release correspond to a commit? Services report full or short SHAs.
export const sameCommit = (release, sha) => !!release && !!sha && release.length >= 7 && (sha.startsWith(release) || release.startsWith(sha));
