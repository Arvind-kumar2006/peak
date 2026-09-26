import { listOrders, getOrder } from '../db/orders.js';
import { listProducts, revenueByStatus } from '../db/products.js';
import { getCached, putCached } from '../cache.js';
import { logger } from '../logger.js';

const intParam = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export async function orders(req, res) {
  const limit = intParam(req.query.limit, 20);
  const offset = intParam(req.query.offset, 0);
  const rows = await listOrders({ limit, offset });
  res.json({ count: rows.length, limit, offset, orders: rows });
}

export async function orderById(req, res) {
  const row = await getOrder(intParam(req.params.id, 0));
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(row);
}

export async function products(req, res) {
  const limit = intParam(req.query.limit, 20);
  const rows = await listProducts({ limit });
  res.json({ count: rows.length, products: rows });
}

/**
 * Cached rollup. Exercises the real application cache, which is what
 * Scenario B's cache.entries counts. Under injected growth this endpoint is the
 * one driving the leak.
 */
export async function summary(req, res) {
  const key = `summary:${req.query.window || 'day'}`;
  const hit = getCached(key);
  if (hit) {
    res.json({ ...hit, cached: true });
    return;
  }
  const rows = await revenueByStatus();
  const value = { groups: rows, generatedAt: new Date().toISOString() };
  putCached(key, value);
  res.json({ ...value, cached: false });
}

export function notFound(_req, res) {
  res.status(404).json({ error: 'not_found' });
  logger.debug('unmatched route');
}
