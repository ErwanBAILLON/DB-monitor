import { describe, expect, it } from "vitest";
import neo4jDriver from "neo4j-driver";
import * as neo from "@/lib/drivers/neo4j";
import type { Conn } from "@/lib/drivers/types";

// Live Neo4j 5 via port-forward. Skipped without TEST_NEO4J_URL (bolt://neo4j:pw@127.0.0.1:17687).
const url = process.env.TEST_NEO4J_URL;
describe.skipIf(!url)("neo4j driver (integration)", () => {
  const u = new URL(url ?? "bolt://x@127.0.0.1");
  const conn: Conn = { type: "neo4j", host: u.hostname, port: Number(u.port || 7687), username: decodeURIComponent(u.username || "neo4j"), password: decodeURIComponent(u.password), database: "neo4j", tls: false };
  const L = `DbmonIt${Date.now().toString(36)}`;

  it("probes the server", async () => {
    const p = await neo.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toMatch(/^5\.\d+\.\d+ community$/);
    expect(p.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(p.connUsed).toBeGreaterThanOrEqual(1);
    expect(p.connMax).toBe(400);
    expect(p.role).toBe("1 base");
    expect(p.sizeBytes).toBeUndefined(); // store size metrics are Enterprise-only
  });

  it("reports down on a bad password and on a closed port", async () => {
    const bad = await neo.probe({ ...conn, password: "nope-nope" });
    expect(bad.up).toBe(false);
    expect(bad.error).toMatch(/unauthorized|authentication/i);
    expect((await neo.probe({ ...conn, port: 1 })).up).toBe(false);
  }, 15_000);

  it("lists databases, transactions, counts, indexes, constraints, connections", async () => {
    await neo.withDriver(conn, async (d) => {
      const s = d.session({ database: "neo4j" });
      try {
        await s.run(`CREATE CONSTRAINT ${L}_id IF NOT EXISTS FOR (n:${L}) REQUIRE n.id IS UNIQUE`);
        await s.run(`UNWIND range(1, 25) AS i CREATE (a:${L} {id: i})-[:${L}_REL]->(b:${L}Target {id: i})`);
      } finally {
        await s.close();
      }
    });
    const d = await neo.detail(conn);
    expect(d.databases.map((x) => x.name).sort()).toEqual(["neo4j", "system"]);
    expect(d.databases.find((x) => x.name === "neo4j")?.currentStatus).toBe("online");
    expect(d.sizesAvailable).toBe(false);
    expect(d.components[0].name).toBe("Neo4j Kernel");
    expect(d.counts.nodes).toBeGreaterThanOrEqual(50);
    expect(d.counts.relationships).toBeGreaterThanOrEqual(25);
    expect(d.counts.labels.find((x) => x.label === L)?.n).toBe(25);
    expect(d.counts.relTypes.find((x) => x.relationshipType === `${L}_REL`)?.n).toBe(25);
    expect(d.indexes.some((x) => x.name === `${L}_id`)).toBe(true);
    expect(d.constraints.find((x) => x.name === `${L}_id`)?.type).toBe("UNIQUENESS");
    expect(Array.isArray(d.transactions)).toBe(true);
    expect(d.connections.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("runs read-only Cypher; the server refuses writes in READ mode even when the guard is bypassed", async () => {
    const r = await neo.readOnlyQuery(conn, `MATCH (n:${L}) RETURN n.id AS id ORDER BY id`);
    expect(r.rowCount).toBe(25);
    expect(r.columns).toEqual(["id"]);
    expect(r.rows[0].id).toBe(1);
    const big = await neo.readOnlyQuery(conn, "UNWIND range(1, 1000) AS x RETURN x");
    expect(big.rowCount).toBe(200);
    expect(big.truncated).toBe(false);
    const nodes = await neo.readOnlyQuery(conn, `MATCH (a:${L})-[r]->(b) RETURN a, r LIMIT 1`);
    expect(String(nodes.rows[0].a)).toMatch(new RegExp(`^\\(:${L} `));
    await expect(neo.readOnlyQuery(conn, `MATCH (n:${L}) SET n.x = 1 RETURN n`)).rejects.toThrow(/SET/);
    await expect(neo.readOnlyQuery(conn, "CALL dbms.security.listUsers()")).rejects.toThrow(/Procédure/);
    // DBMS-mode procedures run under READ access mode: the guard must catch the quoted form too.
    await expect(neo.readOnlyQuery(conn, "CALL `dbms`.`killConnections`(['bolt-nope']) YIELD connectionId, message RETURN *")).rejects.toThrow(/Procédure/);
    await expect(neo.readOnlyQuery(conn, "CALL `dbms.killConnections`(['bolt-nope'])")).rejects.toThrow(/Procédure/);
    await expect(neo.readOnlyQuery(conn, "MATCH (n) RETURN n", "system")).rejects.toThrow(/system/);
    // Bypass: a write through readQuery (READ access mode) must be rejected by the server.
    await neo.withDriver(conn, async (d) => {
      await expect(neo.readQuery(d, `CREATE (n:${L}Bypass) RETURN n`)).rejects.toThrow(/read access mode|Writing in read access mode|AccessMode/i);
    });
    expect((await neo.readOnlyQuery(conn, `MATCH (n:${L}Bypass) RETURN count(n) AS c`)).rows[0].c).toBe(0);
  }, 30_000);

  it("enforces the 5 s transaction timeout", async () => {
    await expect(neo.readOnlyQuery(conn, "UNWIND range(1, 100000000) AS x WITH x WHERE x % 7919 = 0 AND toString(x) CONTAINS '999' RETURN count(x)")).rejects.toThrow(/timed out|timeout|TransactionTimedOut|terminated/i);
  }, 20_000);

  it("terminates a transaction", async () => {
    const victimDriver = neo4jDriver.driver(`bolt://${conn.host}:${conn.port}`, neo4jDriver.auth.basic(conn.username!, conn.password!));
    const vs = victimDriver.session({ database: "neo4j" });
    const victim = vs.run("UNWIND range(1, 1000000000) AS x WITH x WHERE x % 3 = 0 RETURN count(x)", {}, { metadata: { dbmon: "victim" } }).then(() => "done", (e: Error) => e.message);
    let tx: Record<string, unknown> | undefined;
    for (let i = 0; i < 20 && !tx; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const d = await neo.detail(conn);
      tx = d.transactions.find((t) => String(t.currentQuery).includes("range(1, 1000000000)"));
    }
    expect(tx, "victim transaction visible in SHOW TRANSACTIONS").toBeTruthy();
    const msg = await neo.terminateTransaction(conn, String(tx!.transactionId));
    expect(msg).toMatch(/Transaction terminated/i);
    expect(await victim).toMatch(/terminated|Terminated/i);
    await vs.close();
    await victimDriver.close();
    await neo.withDriver(conn, async (d) => {
      const s = d.session({ database: "neo4j" });
      await s.run(`MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH '${L}') DETACH DELETE n`);
      await s.run(`DROP CONSTRAINT ${L}_id IF EXISTS`);
      await s.close();
    });
  }, 40_000);
});
