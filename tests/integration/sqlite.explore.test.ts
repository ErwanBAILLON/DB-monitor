import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Conn } from "@/lib/drivers/types";
import { explorer as x } from "@/lib/explore/sqlite";

// Live SQLite explorer test. TEST_SQLITE_URL=file:/path/to/file.db points at an existing file
// (read-only checks only); without it a temporary fixture (3 tables, 10 000 orders) is created
// with node-sqlite3-wasm, like the pod's sample, and the full suite runs against it.
const ext = process.env.TEST_SQLITE_URL;

describe("sqlite explorer (integration, temporary fixture)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dbmon-sqlite-xp-"));
  const file = path.join(dir, "shop.db");
  const conn: Conn = { type: "sqlite", host: "localhost", port: 0, database: file, tls: false };

  beforeAll(async () => {
    process.env.DBMON_SQLITE_ROOTS = dir;
    const { Database } = await import("node-sqlite3-wasm");
    const db = new Database(file);
    try {
      db.exec(`
        CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, tier TEXT DEFAULT 'free', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'new', placed_at TEXT NOT NULL, note TEXT, CHECK (amount >= 0));
        CREATE INDEX orders_status_idx ON orders(status);
        CREATE INDEX orders_placed_idx ON orders(placed_at);
        CREATE TABLE order_items (order_id INTEGER NOT NULL, line INTEGER NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL CHECK (qty > 0), PRIMARY KEY (order_id, line)) WITHOUT ROWID;
        CREATE TABLE log (msg TEXT);
        CREATE VIEW customer_totals AS SELECT c.id, c.email, count(o.id) AS orders, coalesce(sum(o.amount), 0) AS total FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.email;
      `);
      db.exec("BEGIN");
      db.exec(`INSERT INTO customers (id, email, name, tier) WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 500)
        SELECT n, 'user' || n || '@example.org', CASE WHEN n % 7 = 0 THEN NULL ELSE 'User ' || n END, CASE n % 3 WHEN 0 THEN 'free' WHEN 1 THEN 'pro' ELSE 'enterprise' END FROM g`);
      db.exec(`INSERT INTO orders (id, customer_id, amount, status, placed_at, note) WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 10000)
        SELECT n, 1 + n % 500, round(abs(random() % 50000) / 100.0, 2), CASE n % 4 WHEN 0 THEN 'new' WHEN 1 THEN 'paid' WHEN 2 THEN 'shipped' ELSE 'cancelled' END,
               datetime('now', '-' || n || ' minutes'), CASE WHEN n % 10 = 0 THEN replace(hex(zeroblob(2500)), '00', 'xx') ELSE NULL END FROM g`);
      db.exec(`INSERT INTO order_items SELECT o.id, l.n, 'SKU-' || (o.id % 50), 1 + o.id % 3 FROM orders o JOIN (SELECT 1 AS n UNION ALL SELECT 2) l WHERE o.id <= 2000`);
      db.exec("INSERT INTO log VALUES ('a'), ('b')");
      db.exec("COMMIT");
      db.exec("ANALYZE");
    } finally {
      db.close();
    }
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("lists the single container with file metadata", async () => {
    const cs = await x.listContainers(conn);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ name: "main", kind: "file", objectCount: 5 });
    expect(cs[0].sizeBytes).toBeGreaterThan(100_000);
    expect(cs[0].extra?.journal_mode).toBe("delete");
  });

  it("lists tables and views with exact counts", async () => {
    const os = await x.listObjects(conn, "main");
    expect(os.map((o) => o.name).sort()).toEqual(["customer_totals", "customers", "log", "order_items", "orders"]);
    expect(os.find((o) => o.name === "orders")).toMatchObject({ kind: "table", estRows: 10000 });
    expect(os.find((o) => o.name === "order_items")?.extra?.without_rowid).toBe(true);
    expect(os.find((o) => o.name === "customer_totals")).toMatchObject({ kind: "view", estRows: 500 });
    await expect(x.listObjects(conn, "temp")).rejects.toThrow(/Conteneur inconnu/);
  });

  it("describes columns, indexes, constraints and storage", async () => {
    const d = await x.describeObject(conn, "main", "orders");
    expect(d.columns.map((c) => c.name)).toEqual(["id", "customer_id", "amount", "status", "placed_at", "note"]);
    expect(d.columns[0]).toMatchObject({ name: "id", type: "INTEGER", nullable: false, pk: true });
    expect(d.columns.find((c) => c.name === "status")?.default).toBe("'new'");
    expect(d.columns.find((c) => c.name === "note")?.nullable).toBe(true);
    expect(d.indexes.find((i) => i.name === "orders_status_idx")).toMatchObject({ columns: ["status"], unique: false, extra: expect.objectContaining({ origine: "CREATE INDEX" }) });
    expect(d.indexes.find((i) => i.name === "orders_status_idx")?.extra?.stat1).toMatch(/^\d+ \d+$/); // ANALYZE ran
    expect(d.constraints.find((c) => c.kind === "pk")?.columns).toEqual(["id"]);
    expect(d.constraints.find((c) => c.kind === "fk")).toMatchObject({ columns: ["customer_id"], refObject: "customers", refColumns: ["id"], definition: expect.stringMatching(/CASCADE/) });
    expect(d.constraints.find((c) => c.kind === "check")?.definition).toBe("amount >= 0");
    expect(d.storage).toMatchObject({ lignes: 10000, without_rowid: false, analyze_execute: true });
    expect(d.sample).toBeTruthy();
    expect(d.notes?.[1]).toMatch(/Définition : CREATE TABLE orders/);
    const cust = await x.describeObject(conn, "main", "customers");
    expect(cust.indexes.find((i) => i.unique)?.columns).toEqual(["email"]);
    expect(cust.constraints.find((c) => c.kind === "unique")?.columns).toEqual(["email"]);
    const items = await x.describeObject(conn, "main", "order_items");
    expect(items.constraints.find((c) => c.kind === "pk")?.columns).toEqual(["order_id", "line"]);
    expect(items.storage?.without_rowid).toBe(true);
    const view = await x.describeObject(conn, "main", "customer_totals");
    expect(view.object.kind).toBe("view");
    expect(view.columns.map((c) => c.name)).toEqual(["id", "email", "orders", "total"]);
    expect(view.indexes).toEqual([]);
    await expect(x.describeObject(conn, "main", "nope")).rejects.toThrow(/introuvable/);
    await expect(x.describeObject(conn, "main", "orders; drop")).rejects.toThrow(/invalide/);
    await expect(x.describeObject(conn, "main", "sqlite_master")).rejects.toThrow(/introuvable/); // not listed in the tree either
  });

  it("browses with filter, sort and pagination on the read-only handle", async () => {
    const f = [{ column: "status", op: "=" as const, value: "paid" }];
    const p1 = await x.browseRows(conn, "main", "orders", { page: 1, pageSize: 10, sortColumn: "amount", sortDir: "desc", filters: f });
    expect(p1.rows).toHaveLength(10);
    expect(p1.total).toBe(2500);
    expect(p1.totalIsEstimate).toBe(false);
    expect(p1.rows.every((r) => r.status === "paid")).toBe(true);
    const amounts = p1.rows.map((r) => Number(r.amount));
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    const p2 = await x.browseRows(conn, "main", "orders", { page: 2, pageSize: 10, sortColumn: "amount", sortDir: "desc", filters: f });
    expect(Number(p2.rows[0].amount)).toBeLessThanOrEqual(amounts[9]);
    const last = await x.browseRows(conn, "main", "orders", { page: 100, pageSize: 100, filters: [] });
    expect(last.rows).toHaveLength(100);
    expect(last.total).toBe(10000);
    expect((await x.browseRows(conn, "main", "orders", { page: 101, pageSize: 100, filters: [] })).rows).toHaveLength(0);
    // Numeric affinity: the bound string "100" is compared as a number on a REAL column.
    const ge = await x.browseRows(conn, "main", "orders", { page: 1, pageSize: 5, filters: [{ column: "amount", op: ">=", value: "100" }, { column: "id", op: "like", value: "1%" }] });
    expect(ge.rows.every((r) => Number(r.amount) >= 100 && String(r.id).startsWith("1"))).toBe(true);
    const nulls = await x.browseRows(conn, "main", "customers", { page: 1, pageSize: 5, filters: [{ column: "name", op: "is null" }] });
    expect(nulls.total).toBe(71);
    const long = await x.browseRows(conn, "main", "orders", { page: 1, pageSize: 1, filters: [{ column: "note", op: "is not null" }] });
    expect(String(long.rows[0].note)).toMatch(/tronqué, 5000/);
    await expect(x.browseRows(conn, "main", "orders", { page: 1, pageSize: 5, sortColumn: "id; DROP TABLE orders", filters: [] })).rejects.toThrow(/invalide/);
    await expect(x.browseRows(conn, "main", "orders", { page: 1, pageSize: 5, filters: [{ column: "1=1", op: "=", value: "1" }] })).rejects.toThrow(/invalide/);
    await expect(x.browseRows(conn, "main", "orders", { page: 1, pageSize: 5, filters: [{ column: "secret", op: "=", value: "1" }] })).rejects.toThrow(/inconnue/);
    const inj = await x.browseRows(conn, "main", "orders", { page: 1, pageSize: 5, filters: [{ column: "status", op: "=", value: "' OR 1=1 -- " }] });
    expect(inj.total).toBe(0);
    const v = await x.browseRows(conn, "main", "customer_totals", { page: 1, pageSize: 3, sortColumn: "total", sortDir: "desc", filters: [] });
    expect(v.rows).toHaveLength(3);
    expect(v.total).toBe(500);
    const rowless = await x.browseRows(conn, "main", "log", { page: 1, pageSize: 5, filters: [] });
    expect(rowless.total).toBe(2);
  });

  it("profiles a column on a 10 000-row sample", async () => {
    const p = await x.columnProfile(conn, "main", "orders", "status");
    if ("unsupported" in p && p.unsupported) throw new Error("expected a profile");
    expect(p.sampleSize).toBe(10000);
    expect(p.nullPct).toBe(0);
    expect(p.distinct).toBe(4);
    expect(p.top.map((t) => t.value).sort()).toEqual(["cancelled", "new", "paid", "shipped"]);
    const name = await x.columnProfile(conn, "main", "customers", "name");
    if ("unsupported" in name && name.unsupported) throw new Error("expected a profile");
    expect(name.sampleSize).toBe(500);
    expect(name.nullPct).toBeCloseTo(14.2, 0);
    expect(name.min).toBe("User 1");
    await expect(x.columnProfile(conn, "main", "orders", "nope")).rejects.toThrow(/inconnue/);
  });

  it("reads deep stats", async () => {
    const s = await x.stats(conn);
    expect(s.container).toBe("main");
    expect(s.sections.map((k) => k.key)).toEqual(["file", "tables", "indexes", "no-pk", "fk-check", "compile"]);
    for (const sec of s.sections) expect(sec.unsupported, sec.note).toBeFalsy();
    const file = s.sections.find((k) => k.key === "file")!;
    expect(file.rows.find((r) => r.metrique === "quick_check")?.valeur).toBe("ok");
    expect(file.rows.find((r) => r.metrique === "journal_mode")?.valeur).toBe("delete");
    const tables = s.sections.find((k) => k.key === "tables")!;
    expect(tables.rows.find((r) => r.table === "orders")).toMatchObject({ lignes: 10000, colonnes: 6, index: 2 });
    expect(tables.rows.find((r) => r.table === "order_items")?.without_rowid).toBe(true);
    const idx = s.sections.find((k) => k.key === "indexes")!;
    expect(idx.rows.find((r) => r.index === "orders_status_idx")).toMatchObject({ table: "orders", colonnes: "status", auto: false });
    expect(idx.rows.find((r) => r.index === "orders_status_idx")?.stat1).toMatch(/^\d+ \d+$/);
    expect(s.sections.find((k) => k.key === "no-pk")!.rows.map((r) => r.table)).toEqual(["log"]);
    expect(s.sections.find((k) => k.key === "fk-check")!.rows).toEqual([]);
    expect(s.sections.find((k) => k.key === "compile")!.rows[0]).toMatchObject({ metrique: "sqlite_version", valeur: expect.stringMatching(/^3\./) });
  });

  it("never writes: the read-only handle refuses DML even outside the explorer", async () => {
    const { withDb } = await import("@/lib/drivers/sqlite");
    await expect(withDb(conn, (db) => db.exec("DELETE FROM orders"))).rejects.toThrow(/readonly/i);
  });
});

// Optional smoke run against an existing file (e.g. the pod's /data/sqlite/sample.db copied locally).
describe.skipIf(!ext)("sqlite explorer (integration, TEST_SQLITE_URL)", () => {
  const file = (ext ?? "").replace(/^file:/, "");
  const conn: Conn = { type: "sqlite", host: "localhost", port: 0, database: file, tls: false };
  beforeAll(() => {
    process.env.DBMON_SQLITE_ROOTS = path.dirname(file);
  });
  it("lists, describes, browses and reads stats", async () => {
    const [c] = await x.listContainers(conn);
    expect(c.name).toBe("main");
    const os = await x.listObjects(conn, "main");
    expect(os.length).toBeGreaterThan(0);
    const t = os.find((o) => o.kind === "table") ?? os[0];
    const d = await x.describeObject(conn, "main", t.name);
    expect(d.columns.length).toBeGreaterThan(0);
    const b = await x.browseRows(conn, "main", t.name, { page: 1, pageSize: 5, sortColumn: d.columns[0].name, sortDir: "desc", filters: [{ column: d.columns[0].name, op: "is not null" }] });
    expect(b.total).not.toBeNull();
    const p = await x.columnProfile(conn, "main", t.name, d.columns[0].name);
    expect("unsupported" in p && p.unsupported).toBeFalsy();
    expect((await x.stats(conn)).sections.length).toBe(6);
  });
});
