import { describe, expect, it } from "vitest";
import type { Conn } from "@/lib/drivers/types";
import { explorer as x, BROWSE_COLUMNS } from "@/lib/explore/s3";

// Live MinIO / S3 explorer test via port-forward, read-only key. Skipped without TEST_S3_URL
// (http://ACCESS:SECRET@127.0.0.1:19000). Browses whatever buckets exist: never writes.
const url = process.env.TEST_S3_URL;
describe.skipIf(!url)("s3 explorer against MinIO (integration, read-only)", () => {
  const u = new URL(url ?? "http://x:y@127.0.0.1");
  const conn: Conn = { type: "s3", host: u.hostname, port: Number(u.port || 9000), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: undefined, tls: u.protocol === "https:" };
  let bucket = "";
  let prefix = "/";

  it("lists buckets with counts, sizes, region and versioning", async () => {
    const cs = await x.listContainers(conn);
    expect(cs.length).toBeGreaterThanOrEqual(1);
    for (const c of cs) {
      expect(c.kind).toBe("bucket");
      expect(c.objectCount).toBeGreaterThanOrEqual(0);
      expect(c.extra?.region).toBeTruthy();
      expect(c.extra?.versioning).toBeTruthy();
    }
    // Pick the bucket with the most objects so the browse has something to show.
    bucket = [...cs].sort((a, b) => (b.objectCount ?? 0) - (a.objectCount ?? 0))[0].name;
    expect(bucket).toBeTruthy();
  }, 60_000);

  it("lists the root marker, first-level prefixes and root objects", async () => {
    const os = await x.listObjects(conn, bucket);
    expect(os[0]).toMatchObject({ name: "/", kind: "bucket" });
    const p = os.find((o) => o.kind === "prefix");
    if (p) {
      expect(p.name.endsWith("/")).toBe(true);
      expect(p.estRows).toBeGreaterThanOrEqual(1);
      prefix = p.name;
    }
    for (const o of os.filter((o) => o.kind === "object")) expect(o.sizeBytes).toBeGreaterThanOrEqual(0);
    await expect(x.listObjects(conn, "Bad Bucket; drop")).rejects.toThrow(/invalide/);
  }, 60_000);

  it("describes a prefix (listing metadata, storage stats, sample) and a single object (HeadObject)", async () => {
    const d = await x.describeObject(conn, bucket, prefix);
    expect(d.columns.map((c) => c.name)).toEqual([...BROWSE_COLUMNS]);
    expect(d.indexes).toEqual([]);
    expect(d.constraints).toEqual([]);
    expect(d.storage?.objects).toMatch(/^(>= )?\d+$/);
    expect(d.notes?.length).toBeGreaterThan(0);
    if (d.sample) {
      const key = String(d.sample.key);
      const single = await x.describeObject(conn, bucket, key);
      expect(single.object.kind).toBe("object");
      expect(single.columns.map((c) => c.name)).toContain("content_type");
      expect(single.sample?.key).toBe(key);
      expect("preview" in (single.sample ?? {})).toBe(true);
    }
    await expect(x.describeObject(conn, bucket, "../etc")).rejects.toThrow(/invalide/);
  }, 60_000);

  it("browses with a filter and a sort, exact total, plain rows", async () => {
    const all = await x.browseRows(conn, bucket, prefix, { page: 1, pageSize: 100, filters: [] });
    expect(all.columns).toEqual([...BROWSE_COLUMNS]);
    expect(all.total).toBeGreaterThanOrEqual(all.rows.length);
    expect(all.durationMs).toBeGreaterThanOrEqual(0);
    const sorted = await x.browseRows(conn, bucket, prefix, { page: 1, pageSize: 5, sortColumn: "size", sortDir: "desc", filters: [{ column: "size", op: ">=", value: "0" }, { column: "key", op: "is not null" }] });
    expect(sorted.rows.length).toBeLessThanOrEqual(5);
    const sizes = sorted.rows.map((r) => Number(r.size));
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    for (const r of sorted.rows) expect(typeof r.key).toBe("string");
    if (all.rows[0]) {
      const key = String(all.rows[0].key);
      const exact = await x.browseRows(conn, bucket, prefix, { page: 1, pageSize: 10, filters: [{ column: "key", op: "=", value: key }] });
      expect(exact.total).toBe(1);
      expect(exact.rows[0].key).toBe(key);
      const like = await x.browseRows(conn, bucket, prefix, { page: 1, pageSize: 10, filters: [{ column: "key", op: "like", value: `${key.slice(0, Math.max(1, key.length - 1))}%` }] });
      expect(like.rows.map((r) => r.key)).toContain(key);
      const single = await x.browseRows(conn, bucket, key, { page: 1, pageSize: 10, filters: [] });
      expect(single.columns).toContain("preview");
      expect(single.rows).toHaveLength(1);
    }
    await expect(x.browseRows(conn, bucket, prefix, { page: 1, pageSize: 10, filters: [{ column: "key; DROP", op: "=", value: "1" }] })).rejects.toThrow(/invalide/);
    await expect(x.browseRows(conn, bucket, prefix, { page: 1, pageSize: 10, sortColumn: "1=1", filters: [] })).rejects.toThrow(/invalide/);
  }, 60_000);

  it("profiles a column on the listing sample, unsupported on a single object", async () => {
    const p = await x.columnProfile(conn, bucket, prefix, "size");
    expect(p.unsupported).toBeFalsy();
    if (!p.unsupported) {
      expect(p.sampleSize).toBeGreaterThanOrEqual(0);
      expect(p.nullPct).toBe(0);
      expect(p.top.length).toBeLessThanOrEqual(10);
      if (p.sampleSize > 0) expect(Number(p.min)).toBeLessThanOrEqual(Number(p.max));
    }
    const all = await x.browseRows(conn, bucket, prefix, { page: 1, pageSize: 1, filters: [] });
    if (all.rows[0]) expect((await x.columnProfile(conn, bucket, String(all.rows[0].key), "size")).unsupported).toBe(true);
    await expect(x.columnProfile(conn, bucket, prefix, "preview")).rejects.toThrow(/invalide/);
  }, 60_000);

  it("reads engine-wide and per-bucket stats", async () => {
    const all = await x.stats(conn);
    expect(all.container).toBeNull();
    expect(all.sections.map((s) => s.key)).toEqual(["server", "buckets"]);
    expect(String(all.sections[0].rows[0].server)).toMatch(/MinIO/);
    const one = await x.stats(conn, bucket);
    expect(one.container).toBe(bucket);
    expect(one.sections.map((s) => s.key)).toEqual(["bucket", "prefixes", "extensions", "classes", "largest", "recent", "hygiene"]);
    expect(one.sections.find((s) => s.key === "largest")!.rows.length).toBeLessThanOrEqual(20);
  }, 120_000);
});
