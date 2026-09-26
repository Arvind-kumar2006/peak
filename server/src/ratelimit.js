// In-memory fixed-window rate limiter (per process). Enough for one PEAK server; behind
// several instances, put a shared limiter (proxy or Redis) in front instead.
export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many attempts. Try again later.' }) {
  const hits = new Map(); // key → { count, resetAt }
  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }, windowMs).unref();

  const limiter = (req, res, next) => {
    const k = key(req);
    if (k == null) return next();
    const t = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('retry-after', String(Math.ceil((entry.resetAt - t) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
  limiter.reset = (k) => hits.delete(k);
  return limiter;
}
