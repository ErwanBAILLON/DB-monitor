import { describe, expect, it } from "vitest";
import * as etcd from "@/lib/drivers/etcd";
import type { Conn } from "@/lib/drivers/types";

// Live etcd v3 via port-forward. Skipped without TEST_ETCD_URL (http://127.0.0.1:12379, no auth).
const url = process.env.TEST_ETCD_URL;
describe.skipIf(!url)("etcd driver (integration, read-only)", () => {
  const u = new URL(url ?? "http://127.0.0.1");
  const conn: Conn = { type: "etcd", host: u.hostname, port: Number(u.port || 2379), username: u.username || undefined, password: decodeURIComponent(u.password), database: "67108864", tls: u.protocol === "https:" };
  const P = `dbmon_it_${Date.now().toString(36)}`;
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("probes the member", async () => {
    const p = await etcd.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toBe("3.5.17");
    expect(p.role).toMatch(/^leader · 1 membre · leader dbmon$/);
    expect(p.sizeBytes! > 0n).toBe(true);
    expect(p.memMax).toBe(67108864n);
    expect(p.connUsed).toBeGreaterThanOrEqual(0);
  });

  it("reports down on a closed port", async () => {
    expect((await etcd.probe({ ...conn, port: 1 })).up).toBe(false);
  });

  it("counts keys per top-level prefix without ever reading values", async () => {
    // Seed through the gateway (the driver itself has no write path).
    for (let i = 0; i < 7; i++) await etcd.call(conn, "/v3/kv/put", { key: b64(`/${P}/a/${i}`), value: b64("secret-value") });
    for (let i = 0; i < 3; i++) await etcd.call(conn, "/v3/kv/put", { key: b64(`${P}_flat${i}`), value: b64("secret-value") });
    const d = await etcd.detail(conn);
    expect(d.members).toHaveLength(1);
    expect(d.members[0]).toMatchObject({ name: "dbmon", leader: true });
    expect(d.alarms).toEqual([]);
    expect(d.keyCount).toBeGreaterThanOrEqual(10);
    expect(d.prefixes.find((r) => r.prefix === `/${P}`)?.keys).toBe(7);
    expect(d.prefixes.filter((r) => String(r.prefix).startsWith(`${P}_flat`)).length).toBe(3);
    expect(d.capped).toBe(false);
    expect(d.quotaBytes).toBe(67108864);
    expect(Number(d.status.dbSize)).toBeGreaterThan(0);
    expect(JSON.stringify(d)).not.toContain("secret-value");
    expect(JSON.stringify(d)).not.toContain(b64("secret-value"));
    await etcd.call(conn, "/v3/kv/deleterange", { key: b64(`/${P}/`), range_end: b64(`/${P}0`) });
    await etcd.call(conn, "/v3/kv/deleterange", { key: b64(`${P}_flat`), range_end: b64(`${P}_flau`) });
  }, 30_000);
});
