import { acquire, release } from './pool.js';
import { logger } from '../logger.js';

const PRODUCTS_SQL = `SELECT p.id, p.sku, p.name, p.price_cents, p.in_stock
  FROM products p
  ORDER BY p.id
  LIMIT $1`;

export async function listProducts({ limit = 20 } = {}) {
  const client = await acquire();
  try {
    const { rows } = await client.query(PRODUCTS_SQL, [limit]);
    return rows;
  } finally {
    release(client);
  }
}

/**
 * A heavier aggregate. Gives db-mcp something plausible to report in
 * get_slow_queries without needing a hand-tuned slow query.
 */
export async function revenueByStatus() {
  const client = await acquire();
  try {
    const { rows } = await client.query(
      `SELECT status, COUNT(*)::int AS orders, SUM(total_cents)::bigint AS revenue_cents
       FROM orders
       GROUP BY status
       ORDER BY status`,
    );
    logger.debug('revenue rollup', { groups: rows.length });
    return rows;
  } finally {
    release(client);
  }
}
