import { describe, expect, it } from "vitest";
import * as ix from "@/lib/drivers/influxdb";
import type { Conn } from "@/lib/drivers/types";

// Live InfluxDB 2.x via port-forward. Skipped without TEST_INFLUX_URL (http://:TOKEN@127.0.0.1:18086/ORG).
const url = process.env.TEST_INFLUX_URL;
describe.skipIf(!url)("influxdb driver (integration)", () => {
  const u = new URL(url ?? "http://x@127.0.0.1");
  const ORG = decodeURIComponent(u.pathname.replace(/^\//, "")) || "homelab";
  const conn: Conn = { type: "influxdb", host: u.hostname, port: Number(u.port || 8086), username: undefined, password: decodeURIComponent(u.password), database: ORG, tls: u.protocol === "https:" };
  const B = `dbmon_it_${Date.now().toString(36)}`;

  it("probes the server", async () => {
    const p = await ix.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toMatch(/^2\.7\./);
    expect(p.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(p.role).toMatch(/^pass · 1 org · \d+ buckets?$/);
  });

  it("reports down on a closed port; a bad token still answers /health but fails on orgs", async () => {
    expect((await ix.probe({ ...conn, port: 1 })).up).toBe(false);
    const bad = await ix.probe({ ...conn, password: "nope" });
    expect(bad.up).toBe(false);
    expect(bad.error).toMatch(/401|unauthorized/i);
  });

  it("lists orgs, buckets with retention and cardinality, tasks with last run", async () => {
    const orgId = String((await ix.api<{ orgs: { id: string; name: string }[] }>(conn, "/api/v2/orgs")).orgs.find((o) => o.name === ORG)!.id);
    await ix.api(conn, "/api/v2/buckets", { method: "POST", body: { orgID: orgId, name: B, retentionRules: [{ type: "expire", everySeconds: 86400 }] } });
    await ix.api(conn, `/api/v2/write?org=${ORG}&bucket=${B}&precision=s`, { method: "POST", body: undefined, raw: true, accept: "*/*" }).catch(() => undefined);
    // Line protocol write through the raw HTTP helper (body is a plain string, not JSON).
    const { httpRequest } = await import("@/lib/drivers/http");
    const now = Math.floor(Date.now() / 1000);
    const lines = Array.from({ length: 30 }, (_, i) => `cpu,host=h${i % 3} usage=${i} ${now - i * 10}`).join("\n");
    const w = await httpRequest({ url: new URL(`http://${conn.host}:${conn.port}/api/v2/write?org=${ORG}&bucket=${B}&precision=s`), method: "POST", headers: { Authorization: `Token ${conn.password}` }, body: lines, timeoutMs: 5000 });
    expect(w.status).toBe(204);
    const task = await ix.api<{ id: string }>(conn, "/api/v2/tasks", { method: "POST", body: { orgID: orgId, status: "active", flux: `option task = {name: "${B}_task", every: 1h}\nfrom(bucket: "${B}") |> range(start: -1h) |> count()` } });
    const d = await ix.detail(conn);
    expect(d.orgs.map((o) => o.name)).toContain(ORG);
    const b = d.buckets.find((x) => x.name === B);
    expect(b).toMatchObject({ org: ORG, type: "user", retention: "1 j" });
    expect(Number(b?.cardinality_30d)).toBe(3);
    const t = d.tasks.find((x) => x.name === `${B}_task`);
    expect(t?.status).toBe("active");
    expect(d.cardinalityNote).toBeUndefined();
    await ix.api(conn, `/api/v2/tasks/${task.id}`, { method: "DELETE" }).catch(() => undefined);
  }, 30_000);

  it("runs read-only Flux with the guard and the appended limit", async () => {
    const r = await ix.readOnlyQuery(conn, `from(bucket: "${B}") |> range(start: -1d) |> filter(fn: (r) => r._measurement == "cpu")`);
    expect(r.rowCount).toBe(30);
    expect(r.columns).toContain("_value");
    expect(r.rows[0]._measurement).toBe("cpu");
    const c = await ix.readOnlyQuery(conn, `from(bucket: "${B}") |> range(start: -1d) |> group() |> count()`);
    expect(c.rows[0]._value).toBe(30);
    await expect(ix.readOnlyQuery(conn, `from(bucket: "${B}") |> range(start: -1d) |> to(bucket: "${B}")`)).rejects.toThrow(/to\(\)/);
    await expect(ix.readOnlyQuery(conn, `from(bucket: "${B}")`)).rejects.toThrow(/range/);
    await expect(ix.readOnlyQuery(conn, 'from(bucket: "nope") |> range(start: -1d)')).rejects.toThrow(/HTTP 4|not found/i);
    await expect(ix.readOnlyQuery(conn, `from(bucket: "${B}") |> range(start: -1d)`, "nope-org")).rejects.toThrow(/HTTP 4|organization/i);
    const bucketId = String((await ix.api<{ buckets: { id: string; name: string }[] }>(conn, `/api/v2/buckets?name=${B}`)).buckets[0].id);
    await ix.api(conn, `/api/v2/buckets/${bucketId}`, { method: "DELETE" });
  }, 30_000);
});
