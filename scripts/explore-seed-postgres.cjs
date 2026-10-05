// Seeds the `dbmon_explore` fixture database used by tests/integration/postgres.explore.test.ts.
//   PG_HOST=127.0.0.1 PG_PORT=5490 PG_USER=postgres node scripts/explore-seed-postgres.cjs
// Needs pg_stat_statements in shared_preload_libraries for the "statements" stats section.
const { Client } = require("pg");
(async () => {
  const a = new Client({ host: process.env.PG_HOST || "127.0.0.1", port: Number(process.env.PG_PORT || 5490), user: process.env.PG_USER || "postgres", password: process.env.PG_PASS || "", database: "postgres" });
  await a.connect();
  await a.query("DROP DATABASE IF EXISTS dbmon_explore");
  await a.query("CREATE DATABASE dbmon_explore");
  await a.end();
  const c = new Client({ host: process.env.PG_HOST || "127.0.0.1", port: Number(process.env.PG_PORT || 5490), user: process.env.PG_USER || "postgres", password: process.env.PG_PASS || "", database: "dbmon_explore" });
  await c.connect();
  await c.query(`
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
    CREATE TABLE customers (id serial PRIMARY KEY, email text NOT NULL UNIQUE, name text, profile jsonb, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE orders (id bigserial PRIMARY KEY, customer_id int NOT NULL REFERENCES customers(id), amount numeric(10,2) NOT NULL, status text NOT NULL DEFAULT 'new', placed_at timestamptz NOT NULL DEFAULT now(), note text);
    CREATE INDEX orders_customer_idx ON orders(customer_id);
    CREATE INDEX orders_status_idx ON orders(status);
    CREATE INDEX orders_unused_idx ON orders(placed_at);
    CREATE TABLE order_items (order_id bigint NOT NULL REFERENCES orders(id), line smallint NOT NULL, sku text NOT NULL, qty int NOT NULL CHECK (qty > 0), PRIMARY KEY (order_id, line));
    CREATE VIEW customer_totals AS SELECT c.id, c.email, count(o.id) AS orders, coalesce(sum(o.amount),0) AS total FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.email;
    INSERT INTO customers (email, name, profile) SELECT 'user' || g || '@example.org', CASE WHEN g % 7 = 0 THEN NULL ELSE 'User ' || g END, jsonb_build_object('tier', (ARRAY['free','pro','enterprise'])[1 + g % 3], 'tags', jsonb_build_array('t' || (g % 5)), 'score', g % 100) FROM generate_series(1, 500) g;
    INSERT INTO orders (customer_id, amount, status, placed_at, note) SELECT 1 + (g % 500), round((random() * 500)::numeric, 2), (ARRAY['new','paid','shipped','cancelled'])[1 + g % 4], now() - (g || ' minutes')::interval, CASE WHEN g % 10 = 0 THEN repeat('x', 5000) ELSE NULL END FROM generate_series(1, 20000) g;
    INSERT INTO order_items SELECT o.id, l, 'SKU-' || (o.id % 50), 1 + (o.id % 3) FROM orders o, generate_series(1, 2) l WHERE o.id <= 5000;
    ANALYZE;
  `);
  await c.query("SELECT count(*) FROM orders WHERE status = 'paid'");
  await c.query("SELECT * FROM customer_totals ORDER BY total DESC LIMIT 5");
  console.log("seeded", (await c.query("select count(*) from orders")).rows[0]);
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
