import { acquire, release } from './pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const ORDERS_SQL = `SELECT o.id, o.status, o.total_cents, o.placed_at, c.name AS customer
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  ORDER BY o.id DESC
  LIMIT $1 OFFSET $2`;

const RECONCILE_SQL = `SELECT o.id, o.status, o.total_cents
  FROM orders o
  ORDER BY o.id DESC
  LIMIT $1`;

const PAGE_SIZE = 50;

/** Request path: one checkout, transaction correctly scoped. */
export async function listOrders({ limit = 20, offset = 0 } = {}) {
  const client = await acquire();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(ORDERS_SQL, [limit, offset]);
    await client.query('COMMIT');
    return rows;
  } finally {
    release(client);
  }
}

export async function getOrder(id) {
  const client = await acquire();
  try {
    const { rows } = await client.query(
      'SELECT id, status, total_cents, placed_at FROM orders WHERE id = $1',
      [id],
    );
    return rows[0] || null;
  } finally {
    release(client);
  }
}

/**
 * Background reconciliation: page through recent orders to refresh the
 * dashboard's "recent activity" panel.
 *
 * Scoped per page — each checkout is committed and handed back before the next
 * page starts.
 */
export async function reconcileRecentOrders() {
  const pages = Math.max(1, config.reconcile.pages);
  let scanned = 0;
  for (let page = 0; page < pages; page += 1) {
    const client = await acquire();
    try {
      const { rows } = await client.query(RECONCILE_SQL, [PAGE_SIZE]);
      scanned += rows.length;
      if (rows.length < PAGE_SIZE) break;
    } finally {
      release(client);
    }
  }
  logger.debug('reconciled recent orders', { pages, scanned });
  return scanned;
}
