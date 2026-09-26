#!/usr/bin/env node
/**
 * Create the schema and seed deterministic data.
 *
 *   npm run db:setup     # create tables + seed (idempotent, truncates + reseeds)
 *   npm run db:reset     # drop everything first, then recreate + seed
 *
 * Reads DATABASE_URL from the environment or from ../.env.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const reset = process.argv.includes('--reset');

async function loadDotEnv() {
  try {
    const raw = await readFile(join(here, '..', '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const value = m[2].replace(/^["'](.*)["']$/, '$1');
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  } catch {
    /* no .env — rely on the real environment */
  }
}

await loadDotEnv();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Add it to the repo-root .env (see .env.example).');
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
  if (reset) {
    console.log('dropping tables...');
    await client.query('DROP TABLE IF EXISTS order_items, orders, products, customers CASCADE');
  }

  const schema = await readFile(join(here, 'schema.sql'), 'utf8');
  await client.query(schema);
  console.log('schema ok');

  const seed = await readFile(join(here, 'seed.sql'), 'utf8');
  await client.query(seed);
  console.log('seed ok');

  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM customers)::int AS customers,
            (SELECT count(*) FROM products)::int  AS products,
            (SELECT count(*) FROM orders)::int     AS orders,
            (SELECT count(*) FROM order_items)::int AS order_items`,
  );
  console.log('row counts:', rows[0]);

  const { rows: ext } = await client.query(
    `SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_stat_statements'`,
  );
  console.log(
    ext[0].n > 0
      ? 'pg_stat_statements: available (db-mcp get_slow_queries can use it)'
      : 'pg_stat_statements: NOT available — tell P2 to use a fallback for get_slow_queries',
  );
} catch (err) {
  console.error('db:setup failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
