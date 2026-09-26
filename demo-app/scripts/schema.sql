-- PEAK demo app schema.
-- Keep the query shapes boring and realistic: they are what db-mcp's
-- get_slow_queries / get_lock_waits read during a real incident.

CREATE TABLE IF NOT EXISTS customers (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  email       TEXT        NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  sku         TEXT        NOT NULL UNIQUE,
  name        TEXT        NOT NULL,
  price_cents INTEGER     NOT NULL,
  in_stock    INTEGER     NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER     NOT NULL REFERENCES customers (id),
  status       TEXT        NOT NULL,
  total_cents  INTEGER     NOT NULL,
  placed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders (id),
  product_id INTEGER NOT NULL REFERENCES products (id),
  qty        INTEGER NOT NULL
);

-- db-mcp leans on these for pool/activity lookups.
CREATE INDEX IF NOT EXISTS orders_placed_at_idx  ON orders (placed_at DESC);
CREATE INDEX IF NOT EXISTS orders_customer_id_idx ON orders (customer_id);
CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items (order_id);

-- pg_stat_statements is how db-mcp reports slow queries. Available on Neon and
-- Supabase; this guard keeps the script working on a plain Postgres too.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_stat_statements unavailable — db-mcp get_slow_queries will need a fallback';
END
$$;
