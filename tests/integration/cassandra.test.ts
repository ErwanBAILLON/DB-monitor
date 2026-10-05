import { describe, expect, it } from "vitest";
import * as cs from "@/lib/drivers/cassandra";
import type { Conn } from "@/lib/drivers/types";

// Live Cassandra/ScyllaDB via port-forward. Skipped without TEST_CASSANDRA_URL (cql://127.0.0.1:19042, or cql://user:pw@host:port).
const url = process.env.TEST_CASSANDRA_URL;
describe.skipIf(!url)("cassandra driver against ScyllaDB (integration)", () => {
  const u = new URL(url ?? "cql://127.0.0.1");
  const conn: Conn = { type: "cassandra", host: u.hostname, port: Number(u.port || 9042), username: u.username ? decodeURIComponent(u.username) : undefined, password: decodeURIComponent(u.password), database: undefined, tls: false };
  const KS = `dbmon_it_${Date.now().toString(36)}`;

  it("probes the node", async () => {
    const p = await cs.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toMatch(/^scylla 6\.1\.5/);
    expect(p.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(p.uptimeSec).toBeLessThan(86400);
    expect(p.connUsed).toBeGreaterThanOrEqual(1);
    expect(p.role).toMatch(/^datacenter1\/rack1 · 1 nœud$/);
    expect(typeof p.sizeBytes).toBe("bigint");
  });

  it("reports down on a closed port", async () => {
    const p = await cs.probe({ ...conn, port: 1 });
    expect(p.up).toBe(false);
    expect(p.error).toBeTruthy();
  }, 15_000);

  it("lists keyspaces, tables, clients and compaction info", async () => {
    await cs.withClient(conn, async (c) => {
      await c.execute(`CREATE KEYSPACE ${KS} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`);
      await c.execute(`CREATE TABLE ${KS}.events (id int PRIMARY KEY, v text) WITH default_time_to_live = 3600`);
      for (let i = 0; i < 50; i++) await c.execute(`INSERT INTO ${KS}.events (id, v) VALUES (${i}, 'v${i}')`);
    });
    const d = await cs.detail(conn);
    expect(d.local.scylla_version).toMatch(/^6\.1/);
    expect(d.runtime.some((r) => r.group === "generic" && r.item === "uptime")).toBe(true);
    expect(d.peers).toEqual([]);
    const ks = d.keyspaces.find((k) => k.keyspace_name === KS);
    expect(ks?.tables).toBe(1);
    expect(String(ks?.replication)).toContain("SimpleStrategy");
    const t = d.tables.find((x) => x.keyspace === KS && x.table === "events");
    expect(t).toMatchObject({ ttl: 3600, compaction: expect.stringMatching(/CompactionStrategy$/) });
    expect(d.clientsSource).toBe("system.clients");
    expect(d.clients.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(d.compactions)).toBe(true);
  }, 30_000);

  it("runs read-only CQL with LOCAL_ONE, forced LIMIT and the guard", async () => {
    const r = await cs.readOnlyQuery(conn, `SELECT id, v FROM ${KS}.events`);
    expect(r.rowCount).toBe(50);
    expect(r.columns).toEqual(["id", "v"]);
    expect(r.truncated).toBe(false);
    const r2 = await cs.readOnlyQuery(conn, "SELECT id FROM events LIMIT 1000", KS);
    expect(r2.rowCount).toBe(50);
    const r3 = await cs.readOnlyQuery(conn, `SELECT count(*) AS n FROM ${KS}.events`);
    expect(r3.rows[0].n).toBe("50");
    await expect(cs.readOnlyQuery(conn, `TRUNCATE ${KS}.events`)).rejects.toThrow(/SELECT/);
    await expect(cs.readOnlyQuery(conn, `SELECT * FROM ${KS}.events; DROP KEYSPACE ${KS}`)).rejects.toThrow(/Une seule/);
    await expect(cs.readOnlyQuery(conn, "SELECT * FROM system_auth.roles")).rejects.toThrow(/system_auth/);
    await expect(cs.readOnlyQuery(conn, 'SELECT role, salted_hash FROM "system_auth".roles')).rejects.toThrow(/system_auth/);
    await expect(cs.readOnlyQuery(conn, "SELECT * FROM nope.nope")).rejects.toThrow(/nope|exist/i);
    // Still 50 rows: nothing above wrote.
    expect((await cs.readOnlyQuery(conn, `SELECT count(*) AS n FROM ${KS}.events`)).rows[0].n).toBe("50");
    await cs.withClient(conn, (c) => c.execute(`DROP KEYSPACE ${KS}`));
  }, 30_000);
});
