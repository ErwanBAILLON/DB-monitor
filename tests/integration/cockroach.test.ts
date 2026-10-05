import { describe, expect, it } from "vitest";
import * as crdb from "@/lib/drivers/cockroach";
import * as pg from "@/lib/drivers/postgres";
import type { Conn } from "@/lib/drivers/types";

// Live CockroachDB (insecure single node) via port-forward. Skipped without TEST_COCKROACH_URL
// (postgresql://root@127.0.0.1:26257/defaultdb).
const url = process.env.TEST_COCKROACH_URL;
describe.skipIf(!url)("cockroach driver (integration)", () => {
  const u = new URL(url ?? "postgresql://root@127.0.0.1");
  const conn: Conn = { type: "cockroach", host: u.hostname, port: Number(u.port || 26257), username: u.username || "root", password: u.password, database: u.pathname.slice(1) || "defaultdb", tls: false };
  const DB = `dbmon_it_${Date.now().toString(36)}`;

  it("probes the node", async () => {
    const p = await crdb.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toMatch(/^24\.2/);
    expect(p.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(p.connUsed).toBeGreaterThanOrEqual(1);
    expect(p.role).toBe("1/1 nœuds");
    expect(p.sizeBytes! > 0n).toBe(true);
  });

  it("is auto-detected when registered as postgres", async () => {
    const p = await pg.probe({ ...conn, type: "postgres" });
    expect(p.up, p.error).toBe(true);
    expect(p.role).toBe("1/1 nœuds");
  });

  it("lists databases, sessions, roles, nodes, settings", async () => {
    const d = await crdb.detail(conn);
    expect(d.databases.map((x) => x.name)).toContain("defaultdb");
    expect(d.roles.map((x) => x.name)).toContain("root");
    expect(d.nodes).toHaveLength(1);
    expect(d.settings.map((x) => x.name)).toContain("version");
  });

  it("creates a database and a role, lists tables, queries read-only", async () => {
    await crdb.createRole(conn, DB, undefined);
    await crdb.createDatabase(conn, DB, DB);
    const d = await crdb.detail(conn);
    expect(d.databases.find((x) => x.name === DB)?.owner).toBe(DB);
    await pg.withPg(conn, (c) => c.query(`CREATE TABLE "${DB}".t (id INT PRIMARY KEY, v STRING); INSERT INTO "${DB}".t SELECT g, 'x' FROM generate_series(1, 100) g`));
    const t = await crdb.tables(conn, DB);
    expect(t.map((x) => x.table)).toContain("t");
    const r = await crdb.readOnlyQuery(conn, "SELECT count(*) AS c FROM t", DB);
    expect(String(r.rows[0].c)).toBe("100");
    await expect(crdb.readOnlyQuery(conn, "DELETE FROM t", DB)).rejects.toThrow(/SELECT/);
    await pg.withPg(conn, async (c) => {
      await c.query("BEGIN READ ONLY");
      await expect(c.query(`INSERT INTO "${DB}".t VALUES (1000, 'y')`)).rejects.toThrow(/read.only/i);
      await c.query("ROLLBACK");
    });
    await expect(crdb.createDatabase(conn, "bad name", undefined)).rejects.toThrow(/invalide/);
  });

  it("cancels another session", async () => {
    const { Client } = await import("pg");
    const victim = new Client({ host: conn.host, port: conn.port, user: conn.username ?? "root", database: "defaultdb" });
    await victim.connect();
    victim.on("error", () => undefined);
    const sid = String((await victim.query("SHOW session_id")).rows[0].session_id);
    await crdb.cancelSession(conn, sid);
    await expect(victim.query("SELECT 1")).rejects.toThrow();
    await victim.end().catch(() => undefined);
    await expect(crdb.cancelSession(conn, "zz")).rejects.toThrow(/invalide/);
  });
});
