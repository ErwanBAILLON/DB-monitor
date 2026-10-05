import { describe, expect, it } from "vitest";
import type { Conn } from "@/lib/drivers/types";
import { explorer as x } from "@/lib/explore/clickhouse";

// Live ClickHouse explorer test against the permanent dbmon-test-clickhouse deployment
// (clickhouse/clickhouse-server:24.8), database dbmon_explore_test seeded with
// events (MergeTree, 50 000 rows, PARTITION BY toYYYYMM(ts), ORDER BY (status, ts, id),
// skipping index idx_user, 5 000 NULL notes, one 5 000-char note) and view daily_totals.
// Skipped without TEST_CLICKHOUSE_URL (http://user:pw@127.0.0.1:8123).
const url = process.env.TEST_CLICKHOUSE_URL;
const DB = "dbmon_explore_test";
const T = `${DB}.events`;

describe.skipIf(!url)("clickhouse explorer (integration, TEST_CLICKHOUSE_URL)", () => {
  const u = new URL(url ?? "http://x@127.0.0.1");
  const conn: Conn = { type: "clickhouse", host: u.hostname, port: Number(u.port || 8123), username: decodeURIComponent(u.username || "default"), password: decodeURIComponent(u.password), database: "default", tls: false };

  it("lists databases with size and table count", async () => {
    const cs = await x.listContainers(conn);
    const db = cs.find((c) => c.name === DB);
    expect(db?.kind).toBe("database");
    expect(db?.sizeBytes).toBeGreaterThan(0);
    expect(db?.objectCount).toBe(2);
    expect(cs.some((c) => c.name === "system")).toBe(true);
    expect(cs.some((c) => c.name.toLowerCase() === "information_schema")).toBe(false);
  });

  it("lists tables and views with rows, size, parts", async () => {
    const os = await x.listObjects(conn, DB);
    const ev = os.find((o) => o.name === T)!;
    expect(ev.kind).toBe("table");
    expect(ev.estRows).toBe(50000);
    expect(ev.sizeBytes).toBeGreaterThan(10000);
    expect(ev.extra?.partitions).toBe(6);
    expect(ev.lastModified).toBeTruthy();
    expect(os.find((o) => o.name === `${DB}.daily_totals`)?.kind).toBe("view");
  });

  it("describes columns, keys, skipping index, partitioning, storage and a sample", async () => {
    const d = await x.describeObject(conn, DB, T);
    expect(d.columns.map((c) => c.name)).toEqual(["id", "ts", "day", "user_id", "status", "amount", "score", "tags", "note", "meta"]);
    expect(d.columns.find((c) => c.name === "status")).toMatchObject({ type: "LowCardinality(String)", pk: true, nullable: false });
    expect(d.columns.find((c) => c.name === "note")).toMatchObject({ type: "Nullable(String)", nullable: true });
    expect(d.columns.find((c) => c.name === "meta")?.extra?.codec).toMatch(/ZSTD/);
    expect(d.indexes[0]).toMatchObject({ name: "PRIMARY KEY", primary: true, columns: ["status", "ts", "id"] });
    expect(d.indexes.find((i) => i.name === "idx_user")).toMatchObject({ columns: ["user_id"], extra: { type: "minmax" } });
    expect(d.constraints).toEqual([]);
    expect(d.partitioning).toMatchObject({ cle_partition: "toYYYYMM(ts)", cle_tri: "status, ts, id", partitions: 6 });
    expect(d.storage?.lignes).toBe(50000);
    expect(Number(d.storage?.ratio_compression)).toBeGreaterThan(1);
    expect(d.sample).toBeTruthy();
    const v = await x.describeObject(conn, DB, "daily_totals");
    expect(v.object.kind).toBe("view");
    expect(v.columns.map((c) => c.name)).toEqual(["day", "status", "n", "total"]);
    await expect(x.describeObject(conn, DB, `${DB}.nope`)).rejects.toThrow(/introuvable/);
    await expect(x.describeObject(conn, DB, "events; drop")).rejects.toThrow(/invalide/);
    await expect(x.describeObject(conn, DB, "system.tables")).rejects.toThrow(/hors de la base/);
  });

  it("browses with filter, sort and pagination through readonly=1", async () => {
    const p1 = await x.browseRows(conn, DB, T, { page: 1, pageSize: 10, sortColumn: "amount", sortDir: "desc", filters: [{ column: "status", op: "=", value: "paid" }] });
    expect(p1.rows).toHaveLength(10);
    expect(p1.total).toBe(12500);
    expect(p1.totalIsEstimate).toBe(false);
    expect(p1.rows.every((r) => r.status === "paid")).toBe(true);
    const amounts = p1.rows.map((r) => Number(r.amount));
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    const p2 = await x.browseRows(conn, DB, T, { page: 2, pageSize: 10, sortColumn: "amount", sortDir: "desc", filters: [{ column: "status", op: "=", value: "paid" }] });
    expect(Number(p2.rows[0].amount)).toBeLessThanOrEqual(amounts[9]);
    const last = await x.browseRows(conn, DB, T, { page: 500, pageSize: 100, filters: [] });
    expect(last.rows).toHaveLength(100);
    expect(last.total).toBe(50000);
    expect((await x.browseRows(conn, DB, T, { page: 501, pageSize: 100, filters: [] })).rows).toHaveLength(0);
    // Typed parameters: Decimal, UInt64 LIKE on text form, DateTime, Array compared as text.
    const mix = await x.browseRows(conn, DB, T, { page: 1, pageSize: 5, filters: [{ column: "id", op: "like", value: "1%" }, { column: "amount", op: ">=", value: "100" }, { column: "ts", op: ">=", value: "2026-02-01 00:00:00" }, { column: "tags", op: "=", value: "['t0']" }] });
    expect(mix.rows.length).toBeGreaterThan(0);
    expect(mix.rows.every((r) => String(r.id).startsWith("1") && Number(r.amount) >= 100 && String(r.ts) >= "2026-02-01" && String(r.tags) === '["t0"]')).toBe(true);
    const nulls = await x.browseRows(conn, DB, T, { page: 1, pageSize: 5, filters: [{ column: "note", op: "is null" }] });
    expect(nulls.total).toBe(7500);
    const long = await x.browseRows(conn, DB, T, { page: 1, pageSize: 1, filters: [{ column: "id", op: "=", value: "7" }] });
    expect(String(long.rows[0].note)).toMatch(/tronqué, 5000/);
    // Injection attempts never reach SQL; an injection-looking value is just a value.
    await expect(x.browseRows(conn, DB, T, { page: 1, pageSize: 5, sortColumn: "id; DROP TABLE events", filters: [] })).rejects.toThrow(/invalide/);
    await expect(x.browseRows(conn, DB, T, { page: 1, pageSize: 5, filters: [{ column: "1=1", op: "=", value: "1" }] })).rejects.toThrow(/invalide/);
    await expect(x.browseRows(conn, DB, T, { page: 1, pageSize: 5, filters: [{ column: "secret", op: "=", value: "1" }] })).rejects.toThrow(/inconnue/);
    const inj = await x.browseRows(conn, DB, T, { page: 1, pageSize: 5, filters: [{ column: "status", op: "=", value: "' OR 1=1 --" }] });
    expect(inj.total).toBe(0);
    const view = await x.browseRows(conn, DB, `${DB}.daily_totals`, { page: 1, pageSize: 3, sortColumn: "total", sortDir: "desc", filters: [] });
    expect(view.rows).toHaveLength(3);
    expect(view.total).toBeGreaterThan(100);
  });

  it("profiles a column on a sample", async () => {
    const p = await x.columnProfile(conn, DB, T, "status");
    if ("unsupported" in p && p.unsupported) throw new Error("expected a profile");
    expect(p.sampleSize).toBe(10000);
    expect(p.nullPct).toBe(0);
    // Sample follows the sorting key (status first): the first 10 000 rows are all 'cancelled'.
    expect(p.distinct).toBe(1);
    expect(p.top[0]).toEqual({ value: "cancelled", count: 10000 });
    const note = await x.columnProfile(conn, DB, T, "note");
    if ("unsupported" in note && note.unsupported) throw new Error("expected a profile");
    // In the 'cancelled' sample (id % 4 = 3) only id % 20 = 3 notes are NULL: one in five, 2 000 / 10 000.
    expect(note.nullPct).toBe(20);
    const tags = await x.columnProfile(conn, DB, T, "tags");
    if ("unsupported" in tags && tags.unsupported) throw new Error("expected a profile");
    expect(tags.distinct).toBe(3);
    expect(tags.notes?.[0]).toMatch(/texte/);
    await expect(x.columnProfile(conn, DB, T, "nope")).rejects.toThrow(/inconnue/);
  });

  it("reads deep stats", async () => {
    const s = await x.stats(conn, DB);
    expect(s.sections.map((k) => k.key)).toEqual(["parts", "columns", "merges", "queries", "skip-indexes", "partitions"]);
    const parts = s.sections.find((k) => k.key === "parts")!;
    expect(parts.rows[0].table).toBe(T);
    expect(Number(parts.rows[0].partitions)).toBe(6);
    expect(Number(parts.rows[0].ratio)).toBeGreaterThan(1);
    expect(s.sections.find((k) => k.key === "columns")!.rows.length).toBeGreaterThan(5);
    const ql = s.sections.find((k) => k.key === "queries")!;
    if (!ql.unsupported) expect(ql.rows.length).toBeGreaterThan(0);
    expect(s.sections.find((k) => k.key === "skip-indexes")!.rows.some((r) => r.index === "idx_user")).toBe(true);
    expect(s.sections.find((k) => k.key === "partitions")!.rows).toHaveLength(6);
  });
});
