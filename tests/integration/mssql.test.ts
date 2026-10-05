import { describe, expect, it } from "vitest";
import * as ms from "@/lib/drivers/mssql";
import type { Conn } from "@/lib/drivers/types";

// Live SQL Server via port-forward. Skipped without TEST_MSSQL_URL (mssql://sa:pw@127.0.0.1:11433).
const url = process.env.TEST_MSSQL_URL;
describe.skipIf(!url)("mssql driver (integration)", () => {
  const u = new URL(url ?? "mssql://x@127.0.0.1");
  const conn: Conn = { type: "mssql", host: u.hostname, port: Number(u.port || 1433), username: decodeURIComponent(u.username || "sa"), password: decodeURIComponent(u.password), database: "master", tls: false };
  const DB = `dbmon_it_${Date.now().toString(36)}`;

  it("probes the server", async () => {
    const p = await ms.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toMatch(/^2022 16\./);
    expect(p.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(p.connUsed).toBeGreaterThanOrEqual(1);
    expect(p.connMax).toBeGreaterThan(0);
    expect(p.sizeBytes! > 0n).toBe(true);
    expect(p.role).toBe("standalone");
  });

  it("reports down on a bad password", async () => {
    const p = await ms.probe({ ...conn, password: "Nope-123456" });
    expect(p.up).toBe(false);
    expect(p.error).toMatch(/Login failed/i);
  });

  it("lists databases, sessions, requests, config, logins", async () => {
    const d = await ms.detail(conn);
    expect(d.databases.map((x) => x.name)).toContain("master");
    expect(d.config.map((x) => x.name)).toContain("max server memory (MB)");
    expect(d.logins.map((x) => x.name)).toContain("sa");
    expect(Array.isArray(d.blocking)).toBe(true);
    expect(d.waits.length).toBeGreaterThan(0);
  });

  it("creates a database with a db_owner login, queries read-only, blocks writes", async () => {
    await ms.createDatabase(conn, DB, DB, "Pw-" + DB + "aA1!");
    const d = await ms.detail(conn);
    expect(d.databases.some((x) => x.name === DB)).toBe(true);
    expect(d.logins.some((x) => x.name === DB)).toBe(true);
    const r = await ms.readOnlyQuery(conn, "SELECT 1 AS one, 'x' AS s");
    expect(r.columns).toEqual(["one", "s"]);
    expect(r.rows[0]).toEqual({ one: 1, s: "x" });
    const who = await ms.readOnlyQuery(conn, "EXEC sp_who", DB);
    expect(who.rowCount).toBeGreaterThan(0);
    await expect(ms.readOnlyQuery(conn, `CREATE TABLE t (a int)`, DB)).rejects.toThrow(/SELECT/);
    await expect(ms.readOnlyQuery(conn, "EXEC xp_cmdshell 'ls'")).rejects.toThrow(/EXEC|interdit/);
    // T-SQL batches need no ';': a second statement after the SELECT is refused before the server.
    const smuggled = `dbmon_smuggled_${Date.now().toString(36)}`;
    await expect(ms.readOnlyQuery(conn, `SELECT 1 EXEC sp_executesql N'CREATE DATABASE ${smuggled}'`)).rejects.toThrow(/EXEC/);
    await expect(ms.readOnlyQuery(conn, `SELECT 1 EXEC('CREATE DATABASE ${smuggled}')`)).rejects.toThrow(/EXEC/);
    await expect(ms.readOnlyQuery(conn, "SELECT 1\nEXEC sp_configure 'show advanced options', 1\nRECONFIGURE WITH OVERRIDE")).rejects.toThrow(/EXEC|RECONFIGURE/);
    await expect(ms.readOnlyQuery(conn, "EXEC sp_configure 'max server memory (MB)', 256")).rejects.toThrow(/lecture/);
    await expect(ms.readOnlyQuery(conn, "SELECT 1 WAITFOR DELAY '00:00:05'")).rejects.toThrow(/WAITFOR/);
    expect((await ms.detail(conn)).databases.some((x) => x.name === smuggled)).toBe(false);
    // Read-only EXEC forms still work.
    expect((await ms.readOnlyQuery(conn, "EXEC sp_configure")).rowCount).toBeGreaterThan(5);
    expect((await ms.readOnlyQuery(conn, "EXEC sp_configure 'clr enabled'")).rowCount).toBe(1);
    expect((await ms.readOnlyQuery(conn, "EXEC sp_help 'sys.tables'")).columns.length).toBeGreaterThan(0);
    await expect(ms.readOnlyQuery(conn, "SELECT * FROM OPENROWSET(BULK 'x', SINGLE_BLOB) AS t")).rejects.toThrow(/interdit/i);
    // The dedicated login is confined to its database (model has no guest access, unlike master/msdb).
    const asLogin = { ...conn, username: DB, password: "Pw-" + DB + "aA1!" };
    expect((await ms.readOnlyQuery(asLogin, "SELECT DB_NAME() AS db", DB)).rows[0]).toEqual({ db: DB });
    await expect(ms.readOnlyQuery(asLogin, "SELECT TOP 1 name FROM model.sys.tables", DB)).rejects.toThrow(/permission|denied|not able to access/i);
  }, 60_000);

  it("enforces the request timeout", async () => {
    // WAITFOR is not in the guard's allowlist; use a heavy cross join instead.
    await expect(ms.readOnlyQuery(conn, "SELECT count_big(*) FROM sys.all_columns a CROSS JOIN sys.all_columns b CROSS JOIN sys.all_columns c WHERE a.name + b.name + c.name LIKE '%zzqq%'")).rejects.toThrow(/timeout|Timeout/i);
  }, 20_000);

  it("kills another session", async () => {
    const victimPool = await ms.withMs(conn, async (pool) => {
      const r = await pool.request().query("SELECT @@SPID AS spid");
      const spid = Number(r.recordset[0].spid);
      await ms.killSession(conn, spid);
      await expect(pool.request().query("SELECT 1")).rejects.toThrow();
      return spid;
    }).catch((e: Error) => e);
    expect(victimPool).toBeDefined();
    await expect(ms.killSession(conn, 1)).rejects.toThrow(/invalide/);
  }, 30_000);
});
