import { describe, expect, it } from "vitest";
import * as ch from "@/lib/drivers/clickhouse";
import type { Conn } from "@/lib/drivers/types";

// Live ClickHouse via port-forward. Skipped without TEST_CLICKHOUSE_URL (http://default:pw@127.0.0.1:8123).
const url = process.env.TEST_CLICKHOUSE_URL;
describe.skipIf(!url)("clickhouse driver (integration)", () => {
  const u = new URL(url ?? "http://x@127.0.0.1");
  const conn: Conn = { type: "clickhouse", host: u.hostname, port: Number(u.port || 8123), username: decodeURIComponent(u.username || "default"), password: decodeURIComponent(u.password), database: "default", tls: false };
  const T = `dbmon_it_${Date.now().toString(36)}`;

  it("probes the server", async () => {
    const p = await ch.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toMatch(/^24\./);
    expect(p.connUsed).toBeGreaterThanOrEqual(1);
    expect(p.connMax).toBeGreaterThan(0);
    expect(p.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(p.role).toBe("server");
  });

  it("reports down on a closed port and on a bad password", async () => {
    expect((await ch.probe({ ...conn, port: 1 })).up).toBe(false);
    const bad = await ch.probe({ ...conn, password: "nope" });
    expect(bad.up).toBe(false);
    expect(bad.error).toMatch(/516|Authentication/i);
  });

  it("lists databases, tables, processes, metrics and settings", async () => {
    await ch.query(conn, `CREATE TABLE default.${T} (id UInt32, v String) ENGINE = MergeTree ORDER BY id`);
    await ch.query(conn, `INSERT INTO default.${T} SELECT number, toString(number) FROM numbers(1000)`);
    const d = await ch.detail(conn);
    expect(d.databases.map((x) => x.name)).toContain("system");
    const t = d.tables.find((x) => x.table === T);
    expect(Number(t?.rows)).toBe(1000);
    expect(d.metrics.map((m) => m.metric)).toContain("MemoryTracking");
    expect(d.settings.map((m) => m.name)).toContain("max_connections");
    expect(Array.isArray(d.merges)).toBe(true);
    expect(d.replication).toEqual([]);
  });

  it("runs read-only queries; readonly=1 is enforced by the server too", async () => {
    const r = await ch.readOnlyQuery(conn, `SELECT count() AS c, max(id) AS m FROM default.${T}`);
    expect(r.rows[0]).toEqual({ c: "1000", m: 999 });
    const desc = await ch.readOnlyQuery(conn, `DESCRIBE TABLE default.${T}`);
    expect(desc.rows.map((x) => x.name)).toEqual(["id", "v"]);
    await expect(ch.readOnlyQuery(conn, `DROP TABLE default.${T}`)).rejects.toThrow(/SELECT/);
    // Bypass the guard on purpose: the server must still refuse writes in readonly mode.
    await expect(ch.query(conn, `INSERT INTO default.${T} VALUES (1, 'x')`, { readonly: 1 })).rejects.toThrow(/readonly|164/i);
  });

  it("enforces max_execution_time", async () => {
    await expect(ch.readOnlyQuery(conn, "SELECT count() FROM numbers(100000000000) WHERE sipHash64(number) % 1000000007 = 1")).rejects.toThrow(/159|Timeout exceeded/i);
  }, 20_000);

  it("kills a query", async () => {
    const qid = `dbmon-it-${Date.now()}`;
    const victim = ch.query(conn, "SELECT sleepEachRow(1) FROM numbers(30) SETTINGS max_block_size = 1", { query_id: qid }, 60_000).catch((e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 700));
    const d = await ch.detail(conn);
    expect(d.processes.some((p) => p.query_id === qid)).toBe(true);
    const out = await ch.killQuery(conn, qid);
    expect(out).toMatch(/waiting|pending|sent|cancelled/i);
    const msg = await victim;
    expect(String(msg)).toMatch(/394|cancelled/i);
    await ch.query(conn, `DROP TABLE IF EXISTS default.${T}`);
  }, 30_000);
});
