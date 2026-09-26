-- Deterministic seed so rehearsals and evals are comparable run to run.
-- No psql meta-commands here: this file is executed over the pg driver by
-- scripts/db-setup.mjs, not by psql.

TRUNCATE order_items, orders, products, customers RESTART IDENTITY;

INSERT INTO customers (name, email)
SELECT
  'Customer ' || n,
  'customer' || n || '@example.test'
FROM generate_series(1, 60) AS n;

INSERT INTO products (sku, name, price_cents, in_stock)
SELECT
  'SKU-' || lpad(n::text, 5, '0'),
  (ARRAY[
    'Wireless Mouse', 'Mechanical Keyboard', 'USB-C Hub', '27" Monitor',
    'Standing Desk', 'Noise Cancelling Headset', 'Laptop Stand', 'Webcam 1080p',
    'Docking Station', 'Ergonomic Chair', 'Monitor Arm', 'Portable SSD'
  ])[1 + (n % 12)] || ' ' || n,
  1999 + (n * 137) % 90000,
  (n * 7) % 250
FROM generate_series(1, 240) AS n;

INSERT INTO orders (customer_id, status, total_cents, placed_at)
SELECT
  1 + (n % 60),
  (ARRAY['placed', 'paid', 'shipped', 'delivered', 'refunded'])[1 + (n % 5)],
  1500 + (n * 911) % 120000,
  now() - ((n % 720) || ' minutes')::interval
FROM generate_series(1, 600) AS n;

INSERT INTO order_items (order_id, product_id, qty)
SELECT
  1 + (n % 600),
  1 + (n % 240),
  1 + (n % 4)
FROM generate_series(1, 1500) AS n;

ANALYZE customers;
ANALYZE products;
ANALYZE orders;
ANALYZE order_items;
