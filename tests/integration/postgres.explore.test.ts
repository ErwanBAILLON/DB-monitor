import { describe, expect, it } from "vitest";
import type { Conn } from "@/lib/drivers/types";
import { explorer as x } from "@/lib/explore/postgres";

// Live PostgreSQL explorer test. TEST_POSTGRES_URL must point at a server holding the
// fixture database `dbmon_explore` (customers / orders / order_items / customer_totals,
// 20 000 orders, jsonb profile, composite PK, FK; pg_stat_statements when preloaded).
// Seed: scripts/explore-seed-postgres.cjs. Skipped without the variable.
const url = process.env.TEST_POSTGRES_URL;
const DB = "dbmon_explore";

describe.skipIf(!url)("postgres explorer (integration, TEST_POSTGRES_URL)", () => {
  const u = new URL(url ?? "postgresql://x@127.0.0.1");
  const conn: Conn = { type: "postgres", host: u.hostname, port: Number(u.port || 5432), username: decodeURIComponent(u.username || "postgres"), password: decodeURIComponent(u.password), database: u.pathname.slice(1) || "postgres", tls: false };

  it("lists databases with sizes", async () => {
    const cs = await x.listContainers(conn);
    const db = cs.find((c) => c.name === DB);
    expect(db?.kind).toBe("database");
    expect(db?.sizeBytes).toBeGreaterThan(0);
    expect(cs.some((c) => c.name.startsWith("template"))).toBe(false);
  });

  it("lists tables, views and sizes", async () => {
    const os = await x.listObjects(conn, DB);
    const names = os.map((o) => o.name);
    expect(names).toEqual(expect.arrayContaining(["public.customers", "public.orders", "public.order_items", "public.customer_totals"]));
    const orders = os.find((o) => o.name === "public.orders")!;
    expect(orders.kind).toBe("table");
    expect(orders.estRows).toBeGreaterThan(19000);
    expect(orders.sizeBytes).toBeGreaterThan(100000);
    expect(os.find((o) => o.name === "public.customer_totals")?.kind).toBe("view");
    expect(names.some((n) => n.startsWith("pg_catalog."))).toBe(false);
  });

  it("describes columns, indexes, constraints, storage and a sample", async () => {
    const d = await x.describeObject(conn, DB, "public.orders");
    expect(d.columns.map((c) => c.name)).toEqual(["id", "customer_id", "amount", "status", "placed_at", "note"]);
    expect(d.columns[0]).toMatchObject({ name: "id", type: "bigint", nullable: false, pk: true });
    expect(d.columns.find((c) => c.name === "status")?.default).toBe("'new'::text");
    expect(d.indexes.find((i) => i.primary)?.columns).toEqual(["id"]);
    expect(d.indexes.find((i) => i.name === "orders_status_idx")).toMatchObject({ columns: ["status"], unique: false });
    const fk = d.constraints.find((c) => c.kind === "fk")!;
    expect(fk).toMatchObject({ columns: ["customer_id"], refObject: "customers", refColumns: ["id"] });
    expect(d.storage?.taille_totale).toBeGreaterThan(0);
    expect(d.storage).toHaveProperty("dernier_analyze");
    expect(d.sample).toBeTruthy();
    expect(String(d.sample?.note ?? "").length).toBeLessThan(4200);
    const items = await x.describeObject(conn, DB, "public.order_items");
    expect(items.constraints.find((c) => c.kind === "pk")?.columns).toEqual(["order_id", "line"]);
    expect(items.constraints.some((c) => c.kind === "check")).toBe(true);
    const cust = await x.describeObject(conn, DB, "customers");
    expect(cust.columns.find((c) => c.name === "profile")?.type).toBe("jsonb");
    await expect(x.describeObject(conn, DB, "public.nope")).rejects.toThrow(/introuvable/);
    await expect(x.describeObject(conn, DB, 'public."orders"; drop')).rejects.toThrow(/invalide/);
  });

  it("browses with filter, sort and pagination through the read-only path", async () => {
    const p1 = await x.browseRows(conn, DB, "public.orders", { page: 1, pageSize: 10, sortColumn: "amount", sortDir: "desc", filters: [{ column: "status", op: "=", value: "paid" }] });
    expect(p1.rows).toHaveLength(10);
    expect(p1.total).toBe(5000);
    expect(p1.totalIsEstimate).toBe(false);
    expect(p1.rows.every((r) => r.status === "paid")).toBe(true);
    const amounts = p1.rows.map((r) => Number(r.amount));
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    const p2 = await x.browseRows(conn, DB, "public.orders", { page: 2, pageSize: 10, sortColumn: "amount", sortDir: "desc", filters: [{ column: "status", op: "=", value: "paid" }] });
    expect(Number(p2.rows[0].amount)).toBeLessThanOrEqual(amounts[9]);
    const last = await x.browseRows(conn, DB, "public.orders", { page: 200, pageSize: 100, filters: [] });
    expect(last.rows).toHaveLength(100);
    expect(last.total).toBe(20000);
    const beyond = await x.browseRows(conn, DB, "public.orders", { page: 201, pageSize: 100, filters: [] });
    expect(beyond.rows).toHaveLength(0);
    // LIKE on a non-text column casts to text; numeric comparison lets the server type the parameter.
    const like = await x.browseRows(conn, DB, "public.orders", { page: 1, pageSize: 5, filters: [{ column: "id", op: "like", value: "1%" }, { column: "amount", op: ">=", value: "100" }] });
    expect(like.rows.every((r) => String(r.id).startsWith("1") && Number(r.amount) >= 100)).toBe(true);
    const nulls = await x.browseRows(conn, DB, "public.customers", { page: 1, pageSize: 5, filters: [{ column: "name", op: "is null" }] });
    expect(nulls.total).toBe(71);
    // jsonb cells arrive as strings, long text is truncated.
    const cust = await x.browseRows(conn, DB, "public.customers", { page: 1, pageSize: 1, filters: [] });
    expect(JSON.parse(String(cust.rows[0].profile))).toHaveProperty("tier");
    const long = await x.browseRows(conn, DB, "public.orders", { page: 1, pageSize: 1, filters: [{ column: "note", op: "is not null" }] });
    expect(String(long.rows[0].note)).toMatch(/tronqué, 5000/);
    // Injection attempts never reach SQL.
    await expect(x.browseRows(conn, DB, "public.orders", { page: 1, pageSize: 5, sortColumn: "id; DROP TABLE orders", filters: [] })).rejects.toThrow(/invalide/);
    await expect(x.browseRows(conn, DB, "public.orders", { page: 1, pageSize: 5, filters: [{ column: "1=1", op: "=", value: "1" }] })).rejects.toThrow(/invalide/);
    await expect(x.browseRows(conn, DB, "public.orders", { page: 1, pageSize: 5, filters: [{ column: "secret", op: "=", value: "1" }] })).rejects.toThrow(/inconnue/);
    // A value that would be an injection if interpolated is just a value.
    const inj = await x.browseRows(conn, DB, "public.orders", { page: 1, pageSize: 5, filters: [{ column: "status", op: "=", value: "' OR 1=1 --" }] });
    expect(inj.total).toBe(0);
    // Views browse too.
    const v = await x.browseRows(conn, DB, "public.customer_totals", { page: 1, pageSize: 3, sortColumn: "total", sortDir: "desc", filters: [] });
    expect(v.rows).toHaveLength(3);
    expect(v.total).toBe(500);
  });

  it("profiles a column on a sample", async () => {
    const p = await x.columnProfile(conn, DB, "public.orders", "status");
    if ("unsupported" in p && p.unsupported) throw new Error("expected a profile");
    expect(p.sampleSize).toBe(10000);
    expect(p.nullPct).toBe(0);
    expect(p.distinct).toBe(4);
    expect(p.top.map((t) => t.value).sort()).toEqual(["cancelled", "new", "paid", "shipped"]);
    expect(p.top.reduce((a, t) => a + t.count, 0)).toBe(10000);
    const name = await x.columnProfile(conn, DB, "public.customers", "name");
    if ("unsupported" in name && name.unsupported) throw new Error("expected a profile");
    expect(name.sampleSize).toBe(500);
    expect(name.nullPct).toBeCloseTo(14.2, 0);
    const js = await x.columnProfile(conn, DB, "public.customers", "profile");
    if ("unsupported" in js && js.unsupported) throw new Error("expected a profile");
    expect(js.distinct).toBeGreaterThan(100);
    expect(js.notes?.[0]).toMatch(/texte/);
    await expect(x.columnProfile(conn, DB, "public.orders", "nope")).rejects.toThrow(/inconnue/);
  });

  it("reads deep stats", async () => {
    const s = await x.stats(conn, DB);
    const keys = s.sections.map((k) => k.key);
    expect(keys).toEqual(["statements", "cache", "vacuum", "unused-indexes", "seq-scans", "biggest"]);
    const st = s.sections.find((k) => k.key === "statements")!;
    if (!st.unsupported) {
      expect(st.rows.length).toBeGreaterThan(0);
      expect(st.rows[0]).toHaveProperty("total_ms");
    } else expect(st.note).toMatch(/pg_stat_statements/);
    expect(s.sections.find((k) => k.key === "cache")!.rows.map((r) => r.quoi)).toEqual(["tables", "index"]);
    expect(s.sections.find((k) => k.key === "unused-indexes")!.rows.some((r) => r.index === "orders_unused_idx")).toBe(true);
    expect(s.sections.find((k) => k.key === "biggest")!.rows[0].table).toBe("public.orders");
  });
});
