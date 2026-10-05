import { describe, expect, it } from "vitest";
import oracledb from "oracledb";
import * as ora from "@/lib/drivers/oracle";
import type { Conn } from "@/lib/drivers/types";

// Live Oracle Free via port-forward. Skipped without TEST_ORACLE_URL (oracle://SYSTEM:pw@127.0.0.1:11521/FREEPDB1).
const url = process.env.TEST_ORACLE_URL;
describe.skipIf(!url)("oracle driver (integration)", () => {
  const u = new URL(url ?? "oracle://x@127.0.0.1");
  const conn: Conn = { type: "oracle", host: u.hostname, port: Number(u.port || 1521), username: decodeURIComponent(u.username || "SYSTEM"), password: decodeURIComponent(u.password), database: u.pathname.replace(/^\//, "") || "FREEPDB1", tls: false };
  const T = `DBMON_IT_${Date.now().toString(36).toUpperCase()}`;

  it("probes the instance", async () => {
    const p = await ora.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toMatch(/^23\./);
    expect(p.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(p.connUsed).toBeGreaterThanOrEqual(1);
    expect(p.connMax).toBeGreaterThan(0);
    expect(p.sizeBytes! > 0n).toBe(true);
    expect(p.role).toBe("primary · read write");
  }, 20_000);

  it("reports down on a bad password", async () => {
    const p = await ora.probe({ ...conn, password: "Nope_123" });
    expect(p.up).toBe(false);
    expect(p.error).toMatch(/ORA-01017|invalid credential/i);
  }, 20_000);

  it("lists tablespaces, sessions, limits, parameters, pdbs", async () => {
    await ora.withConnection(conn, async (c) => {
      await c.execute(`CREATE TABLE ${T} (id NUMBER PRIMARY KEY, v VARCHAR2(50))`);
      await c.execute(`INSERT INTO ${T} SELECT level, 'v' || level FROM dual CONNECT BY level <= 100`);
      await c.commit();
    });
    // ORA-01466 guard: a READ ONLY transaction's snapshot has 1 s granularity, a table created
    // in the same second looks "newer" than the snapshot.
    await new Promise((r) => setTimeout(r, 3000));
    const d = await ora.detail(conn);
    expect(d.instance.instance_name).toBe("FREE");
    expect(d.database.open_mode).toBe("READ WRITE");
    expect(d.tablespaces.map((t) => t.tablespace_name)).toContain("SYSTEM");
    const sys = d.tablespaces.find((t) => t.tablespace_name === "SYSTEM")!;
    expect(Number(sys.used_bytes)).toBeGreaterThan(0);
    expect(Number(sys.used_pct)).toBeGreaterThan(0);
    expect(d.limits.map((l) => l.resource_name)).toContain("sessions");
    expect(d.parameters.map((p) => p.name)).toContain("sga_target");
    expect(Array.isArray(d.sessions)).toBe(true);
    expect(Array.isArray(d.longops)).toBe(true);
  }, 30_000);

  it("runs read-only SQL; SET TRANSACTION READ ONLY is enforced by the server on a bypass", async () => {
    const r = await ora.readOnlyQuery(conn, `SELECT id, v FROM ${T} ORDER BY id`);
    expect(r.rowCount).toBe(100);
    expect(r.columns).toEqual(["id", "v"]);
    expect(r.rows[0]).toEqual({ id: 1, v: "v1" });
    const big = await ora.readOnlyQuery(conn, "SELECT level AS n FROM dual CONNECT BY level <= 1000");
    expect(big.rowCount).toBe(500);
    expect(big.truncated).toBe(true);
    await expect(ora.readOnlyQuery(conn, `DELETE FROM ${T}`)).rejects.toThrow(/SELECT/);
    await expect(ora.readOnlyQuery(conn, "BEGIN NULL; END;")).rejects.toThrow(/PL\/SQL/);
    await expect(ora.readOnlyQuery(conn, "SELECT dbms_lock.sleep(1) FROM dual")).rejects.toThrow(/DBMS_LOCK|sleep/);
    // Bypass the guard: a DML inside SET TRANSACTION READ ONLY must be refused by Oracle (ORA-01456).
    await ora.withConnection(conn, async (c) => {
      await c.execute("SET TRANSACTION READ ONLY");
      await expect(c.execute(`INSERT INTO ${T} VALUES (1000, 'x')`)).rejects.toThrow(/ORA-01456/);
      await c.rollback();
    });
    expect((await ora.readOnlyQuery(conn, `SELECT count(*) AS n FROM ${T}`)).rows[0].n).toBe(100);
  }, 30_000);

  it("enforces the 5 s call timeout", async () => {
    await expect(ora.readOnlyQuery(conn, "SELECT count(*) FROM (SELECT level FROM dual CONNECT BY level <= 3000000) a, (SELECT level FROM dual CONNECT BY level <= 3000) b")).rejects.toThrow(/DPI-1067|NJS-123|call timeout|ORA-03156|NJS-5/i);
  }, 20_000);

  it("kills a session (ALTER SYSTEM KILL SESSION)", async () => {
    const victim = await oracledb.getConnection({ user: conn.username!, password: conn.password!, connectString: `${conn.host}:${conn.port}/${conn.database}` });
    const me = await victim.execute<{ SID: number; SERIAL: number }>("SELECT sid, serial# AS serial FROM v$session WHERE sid = SYS_CONTEXT('USERENV', 'SID')", {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const { SID, SERIAL } = me.rows![0];
    const d = await ora.detail(conn);
    expect(d.sessions.some((s) => Number(s.sid) === SID)).toBe(true);
    await ora.killSession(conn, SID, SERIAL);
    await expect(victim.execute("SELECT 1 FROM dual")).rejects.toThrow(/ORA-00028|ORA-03113|ORA-02396|NJS-500|DPI-1080|ORA-03135/);
    await victim.close().catch(() => undefined);
    await ora.withConnection(conn, (c) => c.execute(`DROP TABLE ${T} PURGE`));
  }, 30_000);
});
