import { describe, expect, it } from "vitest";
import { ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import * as s3 from "@/lib/drivers/s3";
import type { Conn } from "@/lib/drivers/types";

// Live MinIO / S3 via port-forward. Skipped without TEST_S3_URL (http://ACCESS:SECRET@127.0.0.1:19000).
// The key is read-only: the test never writes, it only checks what the console shows.
const url = process.env.TEST_S3_URL;
describe.skipIf(!url)("s3 driver against MinIO (integration, read-only)", () => {
  const u = new URL(url ?? "http://x:y@127.0.0.1");
  const conn: Conn = { type: "s3", host: u.hostname, port: Number(u.port || 9000), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: undefined, tls: u.protocol === "https:" };

  it("probes with ListBuckets", async () => {
    const p = await s3.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toMatch(/MinIO/);
    expect(p.connUsed).toBeGreaterThanOrEqual(1);
    expect(p.role).toMatch(/^\d+ buckets?/);
  });

  it("reports down on a bad secret and on a closed port", async () => {
    const bad = await s3.probe({ ...conn, password: "nope" });
    expect(bad.up).toBe(false);
    expect(bad.error).toMatch(/signature|InvalidAccessKeyId|AccessDenied/i);
    expect((await s3.probe({ ...conn, port: 1 })).up).toBe(false);
  });

  it("lists buckets with object counts and sizes, and the read-only key cannot write", async () => {
    const d = await s3.detail(conn);
    expect(d.buckets.length).toBeGreaterThanOrEqual(1);
    expect(d.server).toMatch(/MinIO/);
    for (const b of d.buckets) {
      expect(b.error).toBeNull();
      expect(String(b.objects)).toMatch(/^(>= )?\d+$/);
      expect(b.region).toBeTruthy();
      expect(b.versioning).toBeTruthy();
    }
    expect(d.totalObjects).toBeGreaterThanOrEqual(0);
    const client = s3.clientOf(conn);
    try {
      const first = String(d.buckets[0].name);
      await expect(client.send(new PutObjectCommand({ Bucket: first, Key: "dbmon-it-should-fail", Body: "x" }))).rejects.toThrow(/Access ?Denied/i);
      const stats = await s3.bucketStats(client, first, 1000);
      expect(typeof stats.objects).toBe("number");
      const page = await client.send(new ListObjectsV2Command({ Bucket: first, MaxKeys: 1 }));
      expect(page.$metadata.httpStatusCode).toBe(200);
    } finally {
      client.destroy();
    }
  }, 60_000);
});
