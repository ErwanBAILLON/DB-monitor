import { describe, expect, it } from "vitest";
import * as redis from "@/lib/drivers/redis";
import type { Conn } from "@/lib/drivers/types";

// Live Valkey (Redis-compatible) via port-forward. Skipped without TEST_VALKEY_URL
// (redis://:password@127.0.0.1:16379).
const url = process.env.TEST_VALKEY_URL;
describe.skipIf(!url)("redis driver against Valkey (integration)", () => {
  const u = new URL(url ?? "redis://127.0.0.1");
  const conn: Conn = { type: "redis", host: u.hostname, port: Number(u.port || 6379), username: u.username || undefined, password: decodeURIComponent(u.password), database: "0", tls: false };

  it("probes and reports the Valkey flavour", async () => {
    const p = await redis.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toMatch(/^valkey 8\./);
    expect(p.role).toBe("master");
    expect(p.connUsed).toBeGreaterThanOrEqual(1);
    expect(p.connMax).toBe(10000);
    expect(p.sizeBytes! > 0n).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const p = await redis.probe({ ...conn, password: "nope" });
    expect(p.up).toBe(false);
    expect(p.error).toMatch(/AUTH|WRONGPASS/i);
  });

  it("reads INFO, keyspace, clients, slowlog", async () => {
    const d = await redis.detail(conn);
    expect(d.info.server.valkey_version).toMatch(/^8\./);
    expect(d.clients.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(d.slowlog)).toBe(true);
  });

  it("scans and deletes keys", async () => {
    const key = `dbmon:it:${Date.now()}`;
    await redis.withRedis(conn, async (r) => {
      await r.set(key, "1", "PX", 60_000);
    });
    const rows = await redis.scanKeys(conn, "dbmon:it:*");
    const row = rows.find((x) => x.key === key);
    expect(row?.type).toBe("string");
    expect(Number(row?.ttl_ms)).toBeGreaterThan(0);
    expect(await redis.deleteKey(conn, key)).toBe(1);
    expect(await redis.deleteKey(conn, key)).toBe(0);
  });
});
