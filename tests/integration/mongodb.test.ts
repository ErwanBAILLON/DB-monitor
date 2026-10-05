import { describe, expect, it } from "vitest";
import * as mg from "@/lib/drivers/mongodb";
import type { Conn } from "@/lib/drivers/types";

// Live MongoDB via port-forward. Skipped without TEST_MONGO_URL (mongodb://root:pw@127.0.0.1:27017).
const url = process.env.TEST_MONGO_URL;
describe.skipIf(!url)("mongodb driver (integration)", () => {
  const u = new URL(url ?? "mongodb://x@127.0.0.1");
  const conn: Conn = { type: "mongodb", host: u.hostname, port: Number(u.port || 27017), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: "admin", tls: false };
  const DB = `dbmon_it_${Date.now().toString(36)}`;

  it("probes the server", async () => {
    const p = await mg.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toMatch(/^7\./);
    expect(p.connUsed).toBeGreaterThanOrEqual(1);
    expect(p.connMax).toBeGreaterThan(p.connUsed!);
    expect(p.role).toBe("standalone");
    expect(p.sizeBytes! > 0n).toBe(true);
  });

  it("reports down on a closed port", async () => {
    const p = await mg.probe({ ...conn, port: 1 });
    expect(p.up).toBe(false);
  });

  it("lists databases, server status, currentOp", async () => {
    const d = await mg.detail(conn);
    expect(d.databases.map((x) => x.name)).toContain("admin");
    expect(d.server.storage_engine).toBe("wiredTiger");
    expect(d.replicaSet).toBeNull();
    expect(Array.isArray(d.currentOp)).toBe(true);
  });

  it("creates a database + readWrite user, lists collections, queries read-only", async () => {
    await mg.createDatabase(conn, DB, DB, "pw-" + DB);
    const asUser: Conn = { ...conn, username: DB, password: "pw-" + DB, database: DB };
    // The new user writes into its own db with the official driver...
    await mg.withMongo(asUser, async (c) => {
      await c.db(DB).collection("items").insertMany([{ n: 1, tag: "a" }, { n: 2, tag: "b" }, { n: 3, tag: "a" }]);
    });
    const cols = await mg.collections(conn, DB);
    const items = cols.find((c) => c.name === "items");
    expect(items?.documents).toBe(3);
    expect(String(items?.index_names)).toContain("_id_");
    // ...and the console reads it back.
    const r = await mg.readOnlyQuery(conn, JSON.stringify({ collection: "items", filter: { tag: "a" }, sort: { n: -1 }, limit: 10 }), DB);
    expect(r.rowCount).toBe(2);
    expect(r.rows[0].n).toBe(3);
    const agg = await mg.readOnlyQuery(conn, JSON.stringify({ collection: "items", pipeline: [{ $group: { _id: "$tag", total: { $sum: "$n" } } }, { $sort: { _id: 1 } }] }), DB);
    expect(agg.rows).toEqual([{ _id: "a", total: 4 }, { _id: "b", total: 2 }]);
    // Guard: code execution and writes are refused before reaching the server.
    await expect(mg.readOnlyQuery(conn, JSON.stringify({ collection: "items", filter: { $where: "1" } }), DB)).rejects.toThrow(/\$where/);
    await expect(mg.readOnlyQuery(conn, JSON.stringify({ collection: "items", pipeline: [{ $out: "x" }] }), DB)).rejects.toThrow(/\$out/);
    await expect(mg.readOnlyQuery(conn, JSON.stringify({ collection: "items", limit: 1000 }), DB)).rejects.toThrow(/limit/);
    // Joins to system.* are refused before reaching the server, even as root on admin.
    await expect(mg.readOnlyQuery(conn, JSON.stringify({ collection: "x", pipeline: [{ $unionWith: "system.users" }, { $project: { user: 1, credentials: 1 } }] }), "admin")).rejects.toThrow(/\$unionWith vers system\.users/);
    await expect(mg.readOnlyQuery(conn, JSON.stringify({ collection: "x", pipeline: [{ $lookup: { from: "system.users", pipeline: [], as: "u" } }] }), "admin")).rejects.toThrow(/\$lookup vers system\.users/);
    // ...while a join between ordinary collections works.
    await mg.withMongo(conn, async (c) => c.db(DB).collection("tags").insertMany([{ tag: "a", label: "Alpha" }, { tag: "b", label: "Beta" }]));
    const joined = await mg.readOnlyQuery(conn, JSON.stringify({ collection: "items", pipeline: [{ $match: { n: 1 } }, { $lookup: { from: "tags", localField: "tag", foreignField: "tag", as: "t" } }, { $unionWith: { coll: "tags", pipeline: [{ $match: { tag: "b" } }] } }] }), DB);
    expect(joined.rowCount).toBe(2);
    // The user cannot read another database.
    await expect(mg.readOnlyQuery(asUser, JSON.stringify({ collection: "system.version" }), "admin")).rejects.toThrow();
  });

  it("kills an operation", async () => {
    // A long-running query from a second client, killed through the driver.
    const victim = mg.withMongo(conn, async (c) => {
      const t0 = Date.now();
      await c
        .db(DB)
        .collection("items")
        .find({ $expr: { $function: { body: "function(){ sleep(8000); return true }", args: [], lang: "js" } } })
        .maxTimeMS(20_000)
        .toArray()
        .catch(() => undefined);
      return Date.now() - t0;
    });
    let killed = false;
    for (let i = 0; i < 40 && !killed; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const d = await mg.detail(conn);
      const op = d.currentOp.find((o) => String(o.ns) === `${DB}.items` && o.active);
      if (op) {
        await mg.killOp(conn, String(op.opid));
        killed = true;
      }
    }
    expect(killed).toBe(true);
    expect(await victim).toBeLessThan(8000);
  }, 30_000);
});
