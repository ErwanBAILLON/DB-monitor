import { describe, expect, it } from "vitest";
import * as os from "@/lib/drivers/opensearch";
import type { Conn } from "@/lib/drivers/types";

// Live OpenSearch via port-forward. Skipped without TEST_OPENSEARCH_URL (http://127.0.0.1:19200, security plugin disabled).
const url = process.env.TEST_OPENSEARCH_URL;
describe.skipIf(!url)("opensearch driver (integration)", () => {
  const u = new URL(url ?? "http://127.0.0.1");
  const conn: Conn = { type: "opensearch", host: u.hostname, port: Number(u.port || 9200), username: u.username || undefined, password: decodeURIComponent(u.password), database: undefined, tls: u.protocol === "https:" };
  const IDX = `dbmon-it-${Date.now().toString(36)}`;

  it("probes the cluster", async () => {
    const p = await os.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toMatch(/^opensearch 2\.17/);
    expect(p.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(p.role).toMatch(/^(green|yellow) · 1 nœud/);
  });

  it("reports down on a closed port", async () => {
    expect((await os.probe({ ...conn, port: 1 })).up).toBe(false);
  });

  it("lists health, indices, nodes after indexing documents", async () => {
    await os.api(conn, `/${IDX}`, { method: "PUT", body: { settings: { number_of_shards: 1, number_of_replicas: 0 } } });
    await os.api(conn, `/${IDX}/_doc/1?refresh=wait_for`, { method: "PUT", body: { user: "alice", n: 1 } });
    await os.api(conn, `/${IDX}/_doc/2?refresh=wait_for`, { method: "PUT", body: { user: "bob", n: 2 } });
    const d = await os.detail(conn);
    expect(["green", "yellow"]).toContain(d.health.status);
    const idx = d.indices.find((i) => i.index === IDX);
    expect(String(idx?.docs)).toBe("2");
    expect(idx?.health).toBe("green");
    expect(d.nodes).toHaveLength(1);
    expect(Number(d.nodes[0].heap_max_bytes)).toBeGreaterThan(0);
    expect(Number(d.nodes[0].disk_total_bytes)).toBeGreaterThan(0);
  });

  it("searches read-only with a JSON body and refuses scripts / big sizes / system indices", async () => {
    const r = await os.search(conn, IDX, JSON.stringify({ query: { term: { "user.keyword": "bob" } } }));
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].user).toBe("bob");
    const agg = await os.search(conn, IDX, JSON.stringify({ size: 0, aggs: { total: { sum: { field: "n" } } } }));
    expect(String(agg.rows[0].aggregations)).toContain('"value":3');
    await expect(os.search(conn, IDX, JSON.stringify({ size: 101 }))).rejects.toThrow(/size/);
    await expect(os.search(conn, IDX, JSON.stringify({ query: { script: { script: "1" } } }))).rejects.toThrow(/script/);
    await expect(os.search(conn, ".opendistro_security", "{}")).rejects.toThrow(/Index/);
    await os.api(conn, `/${IDX}`, { method: "DELETE" });
  });
});
