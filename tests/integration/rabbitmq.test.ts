import { describe, expect, it } from "vitest";
import * as rmq from "@/lib/drivers/rabbitmq";
import { httpRequest } from "@/lib/drivers/http";
import type { Conn } from "@/lib/drivers/types";

// Live RabbitMQ management API via port-forward. Skipped without TEST_RABBITMQ_URL (http://user:pw@127.0.0.1:15672).
const url = process.env.TEST_RABBITMQ_URL;
describe.skipIf(!url)("rabbitmq driver (integration, read-only)", () => {
  const u = new URL(url ?? "http://x@127.0.0.1");
  const conn: Conn = { type: "rabbitmq", host: u.hostname, port: Number(u.port || 15672), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: undefined, tls: false };
  const Q = `dbmon_it_${Date.now().toString(36)}`;
  const auth = { Authorization: `Basic ${Buffer.from(`${conn.username}:${conn.password}`).toString("base64")}`, "Content-Type": "application/json" };
  const req = (method: string, path: string, body?: unknown) => httpRequest({ url: new URL(`http://${conn.host}:${conn.port}${path}`), method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 5000 });

  it("probes the broker", async () => {
    const p = await rmq.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toMatch(/^3\.13\.\d+ · erlang 26\./);
    expect(p.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(p.connUsed).toBeGreaterThanOrEqual(0);
    expect(p.sizeBytes! > 0n).toBe(true);
    expect(p.memMax! > p.sizeBytes!).toBe(true);
    expect(p.role).toMatch(/^1 nœud · \d+ files? · \d+ consommateurs?$/);
  });

  it("reports down on a bad password", async () => {
    const p = await rmq.probe({ ...conn, password: "nope" });
    expect(p.up).toBe(false);
    expect(p.error).toMatch(/401|Unauthorized|not_authorised/i);
  });

  it("lists nodes, queues with ready/unacked counts, connections, vhosts", async () => {
    // Seed through the management API (the driver only GETs).
    expect((await req("PUT", `/api/queues/%2F/${Q}`, { durable: false, auto_delete: false })).status).toBeLessThan(300);
    for (let i = 0; i < 5; i++) expect((await req("POST", "/api/exchanges/%2F/amq.default/publish", { properties: {}, routing_key: Q, payload: `m${i}`, payload_encoding: "string" })).status).toBe(200);
    let d = await rmq.detail(conn);
    for (let i = 0; i < 10 && Number(d.queues.find((q) => q.name === Q)?.messages ?? 0) < 5; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      d = await rmq.detail(conn);
    }
    const q = d.queues.find((x) => x.name === Q);
    expect(q).toMatchObject({ vhost: "/", messages: 5, messages_ready: 5, messages_unacknowledged: 0, consumers: 0 });
    expect(d.nodes).toHaveLength(1);
    expect(d.nodes[0]).toMatchObject({ running: true, mem_alarm: false, disk_free_alarm: false });
    expect(d.vhosts.map((v) => v.name)).toContain("/");
    expect(d.exchanges.some((e) => e.name === "amq.topic")).toBe(true);
    expect(Number(d.totals.queues)).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(d.connections)).toBe(true);
    expect(Array.isArray(d.channels)).toBe(true);
    expect((await req("DELETE", `/api/queues/%2F/${Q}`)).status).toBeLessThan(300);
  }, 30_000);
});
