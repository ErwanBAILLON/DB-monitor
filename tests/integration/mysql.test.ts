import { describe, expect, it } from "vitest";
import * as my from "@/lib/drivers/mysql";
import type { Conn } from "@/lib/drivers/types";

// Live MySQL / MariaDB via port-forward. Skipped without TEST_MYSQL_URL / TEST_MARIADB_URL.
//   TEST_MARIADB_URL=mysql://root:pw@127.0.0.1:13306  TEST_MYSQL_URL=mysql://root:pw@127.0.0.1:13307
function connOf(url: string): Conn {
  const u = new URL(url);
  return { type: "mysql", host: u.hostname, port: Number(u.port || 3306), username: decodeURIComponent(u.username || "root"), password: decodeURIComponent(u.password), database: u.pathname.slice(1) || undefined, tls: false };
}

for (const [label, env] of [
  ["mariadb", "TEST_MARIADB_URL"],
  ["mysql", "TEST_MYSQL_URL"],
] as const) {
  const url = process.env[env];
  describe.skipIf(!url)(`${label} driver (integration, ${env})`, () => {
    const conn = connOf(url ?? "mysql://x@127.0.0.1");
    const DB = `dbmon_it_${Date.now().toString(36)}`;

    it("probes the server", async () => {
      const p = await my.probe(conn);
      expect(p.up, p.error).toBe(true);
      expect(p.version).toMatch(/^\d+\.\d+/);
      if (label === "mariadb") expect(p.version).toMatch(/MariaDB/);
      expect(p.connMax).toBeGreaterThan(0);
      expect(p.connUsed).toBeGreaterThanOrEqual(1);
      expect(p.uptimeSec).toBeGreaterThanOrEqual(0);
      expect(p.role).toBe("primary");
    });

    it("reports down on a closed port", async () => {
      const p = await my.probe({ ...conn, port: 1 });
      expect(p.up).toBe(false);
      expect(p.error).toBeTruthy();
    });

    it("lists databases, processlist, variables, status, replication", async () => {
      const d = await my.detail(conn);
      expect(d.flavour).toBe(label);
      expect(d.databases.map((x) => x.name)).toContain("information_schema");
      expect(d.variables.map((x) => x.Variable_name)).toContain("max_connections");
      expect(d.status.map((x) => x.Variable_name)).toContain("Threads_connected");
      expect(d.replication).toBeNull();
      expect(d.users.some((u) => u.user === "root")).toBe(true);
    });

    it("runs read-only queries and blocks writes at both layers", async () => {
      const r = await my.readOnlyQuery(conn, "SELECT 1 AS one, 'x' AS s");
      expect(r.columns).toEqual(["one", "s"]);
      // MySQL 8 types the literal as BIGINT (returned as a string by bigNumberStrings), MariaDB as INT.
      expect(String(r.rows[0].one)).toBe("1");
      expect(r.rows[0].s).toBe("x");
      const sh = await my.readOnlyQuery(conn, "SHOW GLOBAL VARIABLES LIKE 'max_connections'");
      expect(sh.rowCount).toBe(1);
      await expect(my.readOnlyQuery(conn, "CREATE DATABASE should_not_exist")).rejects.toThrow(/SELECT/);
      await expect(my.readOnlyQuery(conn, "DELETE FROM mysql.user")).rejects.toThrow(/SELECT|interdit/);
    });

    it("enforces the execution timeout", async () => {
      // SLEEP() is blocked by the guard; use a heavy cross join instead.
      await expect(my.readOnlyQuery(conn, "SELECT count(*) FROM information_schema.columns a, information_schema.columns b, information_schema.columns c")).rejects.toThrow(/max_statement_time|execution time|exceeded|interrupted/i);
    }, 20_000);

    it("creates a database with a dedicated user, then dumps spec", async () => {
      await my.createDatabase(conn, DB, DB, "pw-" + DB);
      const d = await my.detail(conn);
      expect(d.databases.some((x) => x.name === DB)).toBe(true);
      expect(d.users.some((u) => u.user === DB)).toBe(true);
      // The new user can only see its own database.
      const asUser = await my.readOnlyQuery({ ...conn, username: DB, password: "pw-" + DB }, "SHOW DATABASES");
      expect(asUser.rows.map((r) => r.Database)).toContain(DB);
      expect(asUser.rows.map((r) => r.Database)).not.toContain("mysql");
      const spec = my.dumpSpec(conn, DB);
      expect(spec.args).toContain(DB);
      expect(spec.env.MYSQL_PWD).toBe(conn.password);
      await expect(my.createDatabase(conn, "bad name", undefined, undefined)).rejects.toThrow(/invalide/);
    });

    it("kills another connection", async () => {
      const mysql2 = await import("mysql2/promise");
      const victim = await mysql2.createConnection({ host: conn.host, port: conn.port, user: conn.username ?? "root", password: conn.password });
      const [[row]] = (await victim.query("SELECT CONNECTION_ID() AS id")) as unknown as [[{ id: number }]];
      victim.on("error", () => undefined);
      await my.killProcess(conn, Number(row.id));
      await expect(victim.query("SELECT 1")).rejects.toThrow();
      await victim.end().catch(() => undefined);
      await expect(my.killProcess(conn, 999999999)).rejects.toThrow(/Unknown thread/);
    });
  });
}
