import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import * as pg from "@/lib/drivers/postgres";
import type { Conn } from "@/lib/drivers/types";

// Runs against a real Postgres (TEST_PG_URL, default: the portable local one).
const url = new URL(process.env.TEST_PG_URL ?? "postgresql://postgres@127.0.0.1:5490/postgres");
const conn: Conn = { type: "postgres", host: url.hostname, port: Number(url.port || 5432), username: url.username || "postgres", password: url.password, database: url.pathname.slice(1) || "postgres", tls: false };
const DB = `dbmon_it_${Date.now().toString(36)}`;

async function admin<T>(fn: (c: Client) => Promise<T>) {
  const c = new Client({ host: conn.host, port: conn.port, user: conn.username ?? undefined, password: conn.password, database: conn.database ?? undefined });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe("postgres driver (integration)", () => {
  beforeAll(async () => {
    await admin((c) => c.query("SELECT 1"));
  });
  afterAll(async () => {
    await admin(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${DB}"`);
      await c.query(`DROP ROLE IF EXISTS "${DB}"`);
    });
  });

  it("probes the server", async () => {
    const p = await pg.probe(conn);
    expect(p.up).toBe(true);
    expect(p.version).toMatch(/^\d+/);
    expect(p.connMax).toBeGreaterThan(0);
    expect(p.role).toBe("primary");
    expect(p.sizeBytes! > 0n).toBe(true);
  });

  it("reports down with the error for a closed port", async () => {
    const p = await pg.probe({ ...conn, port: 1 });
    expect(p.up).toBe(false);
    expect(p.error).toBeTruthy();
  });

  it("lists databases, roles, sessions and settings", async () => {
    const d = await pg.detail(conn);
    expect(d.databases.map((x) => x.name)).toContain("postgres");
    expect(d.settings.map((x) => x.name)).toContain("max_connections");
    expect(d.roles.some((r) => r.name === conn.username)).toBe(true);
  });

  it("runs read-only queries and blocks writes at every layer", async () => {
    const r = await pg.readOnlyQuery(conn, "SELECT 1 AS one, 'x' AS s");
    expect(r.columns).toEqual(["one", "s"]);
    expect(r.rows[0]).toEqual({ one: 1, s: "x" });
    await expect(pg.readOnlyQuery(conn, "CREATE TABLE should_not_exist (a int)")).rejects.toThrow(/SELECT/);
    // A statement the guard would wrongly accept must still fail on the READ ONLY transaction:
    // simulate by calling pg directly with a write inside BEGIN READ ONLY.
    await admin(async (c) => {
      await c.query("BEGIN READ ONLY");
      await expect(c.query("CREATE TABLE should_not_exist (a int)")).rejects.toThrow(/read-only/);
      await c.query("ROLLBACK");
    });
  });

  it("enforces the statement timeout", async () => {
    // pg_sleep is blocked by the guard; use a heavy generate_series instead.
    await expect(pg.readOnlyQuery(conn, "SELECT count(*) FROM generate_series(1, 400000000)")).rejects.toThrow(/statement timeout/);
  }, 20_000);

  it("creates a database with an owner role, then dumps it", async () => {
    await pg.createDatabase(conn, DB, DB, "pw-" + DB);
    const d = await pg.detail(conn);
    const row = d.databases.find((x) => x.name === DB);
    expect(row?.owner).toBe(DB);
    const tables = await pg.topTables(conn, DB);
    expect(tables).toEqual([]);
    const spec = pg.dumpSpec(conn, DB);
    expect(spec.args).toContain(DB);
    expect(spec.env.PGPASSWORD).toBe(conn.password ?? "");
    await expect(pg.createDatabase(conn, "bad name", undefined, undefined)).rejects.toThrow(/invalide/);
  });

  it("terminates a backend", async () => {
    const victim = new Client({ host: conn.host, port: conn.port, user: conn.username ?? undefined, database: "postgres" });
    await victim.connect();
    const pid = (await victim.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    victim.on("error", () => undefined);
    expect(await pg.terminateBackend(conn, pid)).toBe(true);
    await victim.end().catch(() => undefined);
    expect(await pg.terminateBackend(conn, 999999)).toBe(false);
  });
});
