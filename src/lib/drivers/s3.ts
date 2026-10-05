import { GetBucketLocationCommand, GetBucketVersioningCommand, ListBucketsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import https from "node:https";
import { httpRequest } from "./http";
import { PROBE_TIMEOUT_MS, errorMessage, withTimeout, type Conn, type Probe, type Row } from "./types";

// MinIO / any S3-compatible store over the S3 API (9000), access key = username,
// secret key = password, read-only (ListBuckets, ListObjectsV2, GetBucketLocation/Versioning).
// Tested against the homelab MinIO quay.io/minio/minio:RELEASE.2024-12-18T13-15-44Z (tests/integration/s3.test.ts).

export const OBJECT_CAP = 5000;

export function clientOf(c: Conn, timeoutMs = PROBE_TIMEOUT_MS): S3Client {
  return new S3Client({
    endpoint: `${c.tls ? "https" : "http"}://${c.host}:${c.port}`,
    region: c.database || "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: c.username ?? "", secretAccessKey: c.password ?? "" },
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({ connectionTimeout: timeoutMs, requestTimeout: timeoutMs, ...(c.tls ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) } : {}) }),
  });
}

// The SDK hides response headers: one unauthenticated GET / gives the `Server` header
// ("MinIO", "AmazonS3", "Ceph"...), the only version-like information S3 exposes.
export async function serverHeader(c: Conn): Promise<string | undefined> {
  try {
    const r = await httpRequest({ url: new URL(`${c.tls ? "https" : "http"}://${c.host}:${c.port}/`), timeoutMs: PROBE_TIMEOUT_MS, insecureTls: c.tls });
    const h = r.headers.server;
    return Array.isArray(h) ? h[0] : h;
  } catch {
    return undefined;
  }
}

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  const client = clientOf(c);
  try {
    return await withTimeout(
      (async () => {
        const res = await client.send(new ListBucketsCommand({}));
        const latencyMs = Date.now() - t0;
        const buckets = res.Buckets ?? [];
        const server = await serverHeader(c);
        return {
          up: true,
          latencyMs,
          version: server ?? "S3",
          connUsed: buckets.length,
          role: `${buckets.length} bucket${buckets.length > 1 ? "s" : ""}${res.Owner?.DisplayName ? ` · ${res.Owner.DisplayName}` : ""}`,
        } satisfies Probe;
      })(),
      PROBE_TIMEOUT_MS + 1000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  } finally {
    client.destroy();
  }
}

// Objects + bytes of one bucket, paginated 1000 at a time, stopped after OBJECT_CAP objects
// (then `capped: true`, the figures are a lower bound shown as ">=").
export async function bucketStats(client: S3Client, bucket: string, cap = OBJECT_CAP): Promise<{ objects: number; bytes: bigint; capped: boolean; lastModified?: Date }> {
  let objects = 0;
  let bytes = 0n;
  let token: string | undefined;
  let lastModified: Date | undefined;
  for (;;) {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      objects++;
      bytes += BigInt(o.Size ?? 0);
      if (o.LastModified && (!lastModified || o.LastModified > lastModified)) lastModified = o.LastModified;
    }
    if (!page.IsTruncated || !page.NextContinuationToken) return { objects, bytes, capped: false, lastModified };
    if (objects >= cap) return { objects, bytes, capped: true, lastModified };
    token = page.NextContinuationToken;
  }
}

export type S3Detail = { buckets: Row[]; totalBytes: bigint; totalObjects: number; anyCapped: boolean; server?: string; owner?: string };

export async function detail(c: Conn): Promise<S3Detail> {
  const client = clientOf(c, 20_000);
  try {
    const [res, server] = await Promise.all([client.send(new ListBucketsCommand({})), serverHeader(c)]);
    const buckets = await Promise.all(
      (res.Buckets ?? []).map(async (b) => {
        const name = b.Name ?? "";
        const [stats, region, versioning] = await Promise.all([
          bucketStats(client, name).catch((e: Error) => ({ objects: null, bytes: null, capped: false, lastModified: undefined, error: e.message })),
          client.send(new GetBucketLocationCommand({ Bucket: name })).then((r) => r.LocationConstraint ?? "us-east-1", () => null),
          client.send(new GetBucketVersioningCommand({ Bucket: name })).then((r) => r.Status ?? "Disabled", () => null),
        ]);
        const s = stats as { objects: number | null; bytes: bigint | null; capped: boolean; lastModified?: Date; error?: string };
        return { name, created: b.CreationDate?.toISOString() ?? null, objects: s.objects === null ? null : `${s.capped ? ">= " : ""}${s.objects}`, size_bytes: s.bytes === null ? null : s.bytes.toString(), size: s.bytes === null ? (s.error ?? "n/d") : `${s.capped ? ">= " : ""}${fmtBytes(s.bytes)}`, last_modified: s.lastModified?.toISOString() ?? null, region, versioning, capped: s.capped, error: s.error ?? null, _bytes: s.bytes ?? 0n, _objects: s.objects ?? 0 };
      }),
    );
    const totalBytes = buckets.reduce((acc, b) => acc + (b._bytes as bigint), 0n);
    const totalObjects = buckets.reduce((acc, b) => acc + (b._objects as number), 0);
    const anyCapped = buckets.some((b) => b.capped);
    const rows: Row[] = buckets
      .sort((a, b) => Number((b._bytes as bigint) - (a._bytes as bigint)))
      .map((b) => {
        const { _bytes, _objects, ...rest } = b;
        void _bytes;
        void _objects;
        return rest;
      });
    return { buckets: rows, totalBytes, totalObjects, anyCapped, server, owner: res.Owner?.DisplayName };
  } finally {
    client.destroy();
  }
}

function fmtBytes(n: bigint): string {
  let v = Number(n);
  const units = ["o", "Kio", "Mio", "Gio", "Tio"];
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
