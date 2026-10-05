import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import type { Conn } from "@/lib/drivers/types";
import { explorer as x } from "@/lib/explore/mysql";

// Live MySQL / MariaDB explorer test via port-forward. Skipped without TEST_MARIADB_URL /
// TEST_MYSQL_URL (mysql://root:pw@127.0.0.1:13306). Creates and drops its own schema.
function connOf(url: string): Conn {
  const u = new URL(url);
  return { type: "mysql", host: u.hostname, port: Number(u.port || 3306), username: decodeURIComponent(u.username || "root"), password: decodeURIComponent(u.password), database: undefined, tls: false };
}

for (const [label, env] of [
  ["mariadb", "TEST_MARIADB_URL"],
  ["mysql", "TEST_MYSQL_URL"],
] as const) {
  const url = process.env[env];
  describe.skipIf(!url)(`${label} explorer (integration, ${env})`, () => {
    const conn = connOf(url ?? "mysql://x@127.0.0.1");
    const DB = `dbmon_xp_${Date.now().toString(36)}`;
    let admin: mysql.Connection;

    beforeAll(async () => {
      admin = await mysql.createConnection({ host: conn.host, port: conn.port, user: conn.username ?? "root", password: conn.password, multipleStatements: true });
      await admin.query(`CREATE DATABASE \`${DB}\``);
      await admin.query(`USE \`${DB}\``);
      await admin.query(`
        CREATE TABLE customers (id int AUTO_INCREMENT PRIMARY KEY, email varchar(190) NOT NULL UNIQUE, name varchar(100) NULL, profile json, created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB;
        CREATE TABLE orders (id bigint AUTO_INCREMENT PRIMARY KEY, customer_id int NOT NULL, amount decimal(10,2) NOT NULL, status varchar(20) NOT NULL DEFAULT 'new', placed_at datetime NOT NULL, note text NULL,
          CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id), INDEX orders_status_idx (status), INDEX orders_unused_idx (placed_at)) ENGINE=InnoDB;
        CREATE TABLE order_items (order_id bigint NOT NULL, line smallint NOT NULL, sku varchar(20) NOT NULL, qty int NOT NULL, PRIMARY KEY (order_id, line), CONSTRAINT chk_qty CHECK (qty > 0)) ENGINE=InnoDB;
        CREATE VIEW customer_totals AS SELECT c.id, c.email, count(o.id) AS orders, coalesce(sum(o.amount), 0) AS total FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.email;
      `);
      await admin.query("SET SESSION cte_max_recursion_depth = 30000").catch(() => undefined);
      await admin.query("SET SESSION max_recursive_iterations = 30000").catch(() => undefined);
      await admin.query(`INSERT INTO customers (email, name, profile) WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 500)
        SELECT concat('user', n, '@example.org'), IF(n % 7 = 0, NULL, concat('User ', n)), JSON_OBJECT('tier', ELT(1 + n % 3, 'free', 'pro', 'enterprise'), 'score', n % 100) FROM g`);
      await admin.query(`INSERT INTO orders (customer_id, amount, status, placed_at, note) WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 20000)
        SELECT 1 + n % 500, round(rand() * 500, 2), ELT(1 + n % 4, 'new', 'paid', 'shipped', 'cancelled'), now() - INTERVAL n MINUTE, IF(n % 10 = 0, repeat('x', 5000), NULL) FROM g`);
      await admin.query(`INSERT INTO order_items SELECT o.id, l.n, concat('SKU-', o.id % 50), 1 + o.id % 3 FROM orders o JOIN (SELECT 1 AS n UNION ALL SELECT 2) l WHERE o.id <= 5000`);
      await admin.query(`ANALYZE TABLE customers, orders, order_items`);
    }, 120_000);
    afterAll(async () => {
      await admin?.query(`DROP DATABASE IF EXISTS \`${DB}\``).catch(() => undefined);
      await admin?.end().catch(() => undefined);
    });

    it("lists schemas with sizes and table counts, hiding system ones", async () => {
      const cs = await x.listContainers(conn);
      const db = cs.find((c) => c.name === DB);
      expect(db?.kind).toBe("schema");
      expect(db?.objectCount).toBe(4);
      expect(db?.sizeBytes).toBeGreaterThan(0);
      expect(cs.map((c) => c.name)).not.toContain("performance_schema");
    });

    it("lists tables and views", async () => {
      const os = await x.listObjects(conn, DB);
      expect(os.map((o) => o.name).sort()).toEqual(["customer_totals", "customers", "order_items", "orders"]);
      const orders = os.find((o) => o.name === "orders")!;
      expect(orders.kind).toBe("table");
      expect(orders.sizeBytes).toBeGreaterThan(100000);
      expect(orders.extra?.engine).toBe("InnoDB");
      expect(os.find((o) => o.name === "customer_totals")?.kind).toBe("view");
      await expect(x.listObjects(conn, "bad schema")).rejects.toThrow(/invalide/);
    });

    it("describes columns, indexes, constraints and storage", async () => {
      const d = await x.describeObject(conn, DB, "orders");
      expect(d.columns.map((c) => c.name)).toEqual(["id", "customer_id", "amount", "status", "placed_at", "note"]);
      expect(d.columns[0]).toMatchObject({ name: "id", type: expect.stringMatching(/^bigint/), nullable: false, pk: true });
      expect(d.columns.find((c) => c.name === "status")?.default).toMatch(/new/);
      expect(d.indexes.find((i) => i.primary)?.columns).toEqual(["id"]);
      expect(d.indexes.find((i) => i.name === "orders_status_idx")).toMatchObject({ columns: ["status"], unique: false });
      const fk = d.constraints.find((c) => c.kind === "fk")!;
      expect(fk).toMatchObject({ name: "fk_orders_customer", columns: ["customer_id"], refObject: "customers", refColumns: ["id"] });
      expect(d.storage?.moteur).toBe("InnoDB");
      expect(d.storage?.taille_donnees).toBeGreaterThan(0);
      expect(d.sample).toBeTruthy();
      const items = await x.describeObject(conn, DB, "order_items");
      expect(items.constraints.find((c) => c.kind === "pk")?.columns).toEqual(["order_id", "line"]);
      expect(items.constraints.find((c) => c.kind === "check")?.definition).toMatch(/qty/);
      const cust = await x.describeObject(conn, DB, "customers");
      expect(cust.columns.find((c) => c.name === "profile")?.type).toMatch(/json|longtext/);
      await expect(x.describeObject(conn, DB, "nope")).rejects.toThrow(/introuvable/);
      await expect(x.describeObject(conn, DB, "orders; drop")).rejects.toThrow(/invalide/);
    });

    it("browses with filter, sort and pagination through the read-only path", async () => {
      const f = [{ column: "status", op: "=" as const, value: "paid" }];
      const p1 = await x.browseRows(conn, DB, "orders", { page: 1, pageSize: 10, sortColumn: "amount", sortDir: "desc", filters: f });
      expect(p1.rows).toHaveLength(10);
      expect(p1.total).toBe(5000);
      expect(p1.totalIsEstimate).toBe(false);
      expect(p1.rows.every((r) => r.status === "paid")).toBe(true);
      const amounts = p1.rows.map((r) => Number(r.amount));
      expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
      const p2 = await x.browseRows(conn, DB, "orders", { page: 2, pageSize: 10, sortColumn: "amount", sortDir: "desc", filters: f });
      expect(Number(p2.rows[0].amount)).toBeLessThanOrEqual(amounts[9]);
      const last = await x.browseRows(conn, DB, "orders", { page: 200, pageSize: 100, filters: [] });
      expect(last.rows).toHaveLength(100);
      expect(last.total).toBe(20000);
      expect((await x.browseRows(conn, DB, "orders", { page: 201, pageSize: 100, filters: [] })).rows).toHaveLength(0);
      const like = await x.browseRows(conn, DB, "orders", { page: 1, pageSize: 5, filters: [{ column: "id", op: "like", value: "1%" }, { column: "amount", op: ">=", value: "100" }] });
      expect(like.rows.every((r) => String(r.id).startsWith("1") && Number(r.amount) >= 100)).toBe(true);
      const nulls = await x.browseRows(conn, DB, "customers", { page: 1, pageSize: 5, filters: [{ column: "name", op: "is null" }] });
      expect(nulls.total).toBe(71);
      const long = await x.browseRows(conn, DB, "orders", { page: 1, pageSize: 1, filters: [{ column: "note", op: "is not null" }] });
      expect(String(long.rows[0].note)).toMatch(/tronqué, 5000/);
      await expect(x.browseRows(conn, DB, "orders", { page: 1, pageSize: 5, sortColumn: "id; DROP TABLE orders", filters: [] })).rejects.toThrow(/invalide/);
      await expect(x.browseRows(conn, DB, "orders", { page: 1, pageSize: 5, filters: [{ column: "1=1", op: "=", value: "1" }] })).rejects.toThrow(/invalide/);
      await expect(x.browseRows(conn, DB, "orders", { page: 1, pageSize: 5, filters: [{ column: "secret", op: "=", value: "1" }] })).rejects.toThrow(/inconnue/);
      const inj = await x.browseRows(conn, DB, "orders", { page: 1, pageSize: 5, filters: [{ column: "status", op: "=", value: "' OR 1=1 -- " }] });
      expect(inj.total).toBe(0);
      const v = await x.browseRows(conn, DB, "customer_totals", { page: 1, pageSize: 3, sortColumn: "total", sortDir: "desc", filters: [] });
      expect(v.rows).toHaveLength(3);
      expect(v.total).toBe(500);
    });

    it("profiles a column on a sample", async () => {
      const p = await x.columnProfile(conn, DB, "orders", "status");
      if ("unsupported" in p && p.unsupported) throw new Error("expected a profile");
      expect(p.sampleSize).toBe(10000);
      expect(p.nullPct).toBe(0);
      expect(p.distinct).toBe(4);
      expect(p.top.map((t) => t.value).sort()).toEqual(["cancelled", "new", "paid", "shipped"]);
      const name = await x.columnProfile(conn, DB, "customers", "name");
      if ("unsupported" in name && name.unsupported) throw new Error("expected a profile");
      expect(name.sampleSize).toBe(500);
      expect(name.nullPct).toBeCloseTo(14.2, 0);
      await expect(x.columnProfile(conn, DB, "orders", "nope")).rejects.toThrow(/inconnue/);
    });

    it("reads deep stats", async () => {
      const s = await x.stats(conn, DB);
      expect(s.sections.map((k) => k.key)).toEqual(["digests", "buffer-pool", "unused-indexes", "no-pk", "fragmented", "biggest"]);
      const bp = s.sections.find((k) => k.key === "buffer-pool")!;
      expect(bp.unsupported).toBeFalsy();
      expect(bp.rows.map((r) => r.metrique)).toContain("hit ratio %");
      expect(s.sections.find((k) => k.key === "biggest")!.rows[0].table).toBe("orders");
      expect(s.sections.find((k) => k.key === "no-pk")!.rows).toEqual([]);
      const dg = s.sections.find((k) => k.key === "digests")!;
      // MariaDB ships performance_schema OFF: the section is then empty or unsupported, both acceptable.
      if (!dg.unsupported && dg.rows.length) expect(dg.rows[0]).toHaveProperty("total_ms");
    });
  });
}
