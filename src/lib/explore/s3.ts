import { GetBucketLocationCommand, GetBucketVersioningCommand, GetObjectCommand, HeadObjectCommand, ListBucketsCommand, ListObjectsV2Command, type S3Client, type _Object } from "@aws-sdk/client-s3";
import { clientOf, serverHeader } from "@/lib/drivers/s3";
import { plainRow, withTimeout, type Conn, type Row } from "@/lib/drivers/types";
import { FILTER_OPS, PROFILE_SAMPLE, CELL_MAX_BYTES, truncateCell, type BrowseRequest, type BrowseResult, type ColumnProfile, type ExploreContainer, type ExploreDescription, type ExploreFilter, type ExploreObject, type ExploreStats, type Explorer, type StatSection } from "./types";

// MinIO / S3 explorer, read-only (ListBuckets, ListObjectsV2, GetBucketLocation/Versioning,
// HeadObject, GetObject with a 4 KiB Range for text previews). No SQL: S3 only filters by
// prefix, so filters and sorts are applied in memory on a bounded listing (SCAN_CAP objects)
// and the total is flagged as an estimate (lower bound) when the cap is hit. Values typed in
// filters never reach the wire except as a `Prefix` when the filter is `key like 'abc%'`.
//
// Containers = buckets. Objects = first-level prefixes ("photos/", kind "prefix") plus the
// objects sitting at the bucket root (kind "object"), and a synthetic "/" entry = whole bucket.

export const SCAN_CAP = 5000; // objects read per browse / profile / stats (5 ListObjectsV2 pages)
export const LIST_TIMEOUT_MS = 20_000;
export const PREVIEW_BYTES = CELL_MAX_BYTES;
export const BROWSE_COLUMNS = ["key", "size", "last_modified", "etag", "storage_class"] as const;
export type BrowseColumn = (typeof BROWSE_COLUMNS)[number];
const TEXT_PREVIEW = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-ndjson|csv|toml|sql)|image\/svg\+xml)/i;

// Bucket names: S3 rules (3..63 chars, lowercase letters, digits, dots, dashes, starts/ends alnum).
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
export function assertBucket(s: unknown): string {
  if (typeof s !== "string" || !BUCKET.test(s) || s.includes("..")) throw new Error(`Bucket invalide : « ${String(s).slice(0, 40)} ».`);
  return s;
}

// Object identifiers: "/" (whole bucket), "<prefix>/" (recursive listing under the prefix) or a
// plain key. Keys are free-form in S3; refused here: control characters, "..", a leading "/"
// (except the root marker), "//" and more than 1024 bytes (the S3 key limit).
// eslint-disable-next-line no-control-regex
const BAD_KEY = /[\u0000-\u001f\u007f]/;
export function assertKey(s: unknown): string {
  if (typeof s !== "string" || !s) throw new Error("Objet invalide : vide.");
  if (s === "/") return s;
  if (s.length > 1024 || BAD_KEY.test(s) || s.startsWith("/") || s.includes("//") || s.split("/").includes("..")) throw new Error(`Objet invalide : « ${s.slice(0, 60)} ».`);
  return s;
}
export const isPrefix = (object: string): boolean => object === "/" || object.endsWith("/");
export const prefixOf = (object: string): string => (object === "/" ? "" : object);

export function assertColumn(s: unknown, what = "Colonne"): BrowseColumn {
  if (typeof s !== "string" || !(BROWSE_COLUMNS as readonly string[]).includes(s)) throw new Error(`${what} invalide : « ${String(s).slice(0, 40)} » (key, size, last_modified, etag, storage_class).`);
  return s as BrowseColumn;
}

export type Entry = { key: string; size: number; last_modified: string | null; etag: string | null; storage_class: string | null };
const entryOf = (o: _Object): Entry => ({ key: o.Key ?? "", size: Number(o.Size ?? 0), last_modified: o.LastModified?.toISOString() ?? null, etag: o.ETag ? o.ETag.replace(/^"|"$/g, "") : null, storage_class: o.StorageClass ?? null });

// --- in-memory filtering (values are compared, never interpolated anywhere) -----------------

function cmpValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

// LIKE with % and _ -> anchored regex; everything else escaped.
export function likeToRegex(pattern: string): RegExp {
  const src = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${src}$`, "s");
}

export type CompiledFilter = { column: BrowseColumn; test: (e: Entry) => boolean };
export function compileFilters(filters: ExploreFilter[]): { tests: CompiledFilter[]; prefixHint: string | undefined } {
  let prefixHint: string | undefined;
  const tests = filters.map((f) => {
    const column = assertColumn(f.column, "Colonne de filtre");
    if (!(FILTER_OPS as readonly string[]).includes(f.op)) throw new Error(`Opérateur inconnu : ${String(f.op)}.`);
    const raw = f.value ?? "";
    const numeric = column === "size" && f.op !== "like" && f.op !== "is null" && f.op !== "is not null";
    const value: unknown = numeric ? Number(raw) : raw;
    if (numeric && !Number.isFinite(value as number)) throw new Error(`Filtre size : nombre attendu.`);
    const get = (e: Entry): unknown => e[column];
    let test: (e: Entry) => boolean;
    switch (f.op) {
      case "is null":
        test = (e) => get(e) === null;
        break;
      case "is not null":
        test = (e) => get(e) !== null;
        break;
      case "like": {
        const re = likeToRegex(raw);
        test = (e) => get(e) !== null && re.test(String(get(e)));
        // "key like 'abc%'" with no other wildcard: let S3 narrow the listing with a Prefix.
        const m = /^([^%_]*)%$/.exec(raw);
        if (column === "key" && m && m[1]) prefixHint = m[1];
        break;
      }
      case "=":
        test = (e) => get(e) !== null && cmpValues(get(e), value) === 0;
        if (column === "key") prefixHint = raw;
        break;
      case "!=":
        test = (e) => get(e) !== null && cmpValues(get(e), value) !== 0;
        break;
      case "<":
        test = (e) => get(e) !== null && cmpValues(get(e), value) < 0;
        break;
      case "<=":
        test = (e) => get(e) !== null && cmpValues(get(e), value) <= 0;
        break;
      case ">":
        test = (e) => get(e) !== null && cmpValues(get(e), value) > 0;
        break;
      case ">=":
        test = (e) => get(e) !== null && cmpValues(get(e), value) >= 0;
        break;
      default:
        throw new Error(`Opérateur inconnu : ${String(f.op)}.`);
    }
    return { column, test };
  });
  return { tests, prefixHint };
}

// Applies filters, sort and paging to a bounded listing. Pure: unit-tested without S3.
export function pageEntries(entries: Entry[], req: BrowseRequest, capped: boolean): BrowseResult & { filtered: Entry[] } {
  const { tests } = compileFilters(req.filters);
  const filtered = entries.filter((e) => tests.every((t) => t.test(e)));
  const sortCol = req.sortColumn ? assertColumn(req.sortColumn, "Colonne de tri") : "key";
  const dir = req.sortDir === "desc" ? -1 : 1;
  filtered.sort((a, b) => dir * cmpValues(a[sortCol], b[sortCol]) || cmpValues(a.key, b.key));
  const offset = (req.page - 1) * req.pageSize;
  const rows = filtered.slice(offset, offset + req.pageSize).map((e) => plainRow({ ...e }));
  const notes: string[] = [];
  if (capped) notes.push(`Listing limité aux ${SCAN_CAP} premiers objets (ordre des clés) : total = borne inférieure, filtre et tri appliqués sur cet échantillon.`);
  return { columns: [...BROWSE_COLUMNS], rows, page: req.page, pageSize: req.pageSize, total: filtered.length, totalIsEstimate: capped, durationMs: 0, notes, filtered };
}

// --- S3 access (read-only key, console timeouts) --------------------------------------------

async function withClient<T>(c: Conn, fn: (client: S3Client) => Promise<T>, what = "listing"): Promise<T> {
  const client = clientOf(c, LIST_TIMEOUT_MS);
  try {
    return await withTimeout(fn(client), LIST_TIMEOUT_MS + 1000, what);
  } finally {
    client.destroy();
  }
}

// Recursive listing under a prefix, at most `cap` objects.
export async function scan(client: S3Client, bucket: string, prefix: string, cap = SCAN_CAP): Promise<{ entries: Entry[]; capped: boolean }> {
  const entries: Entry[] = [];
  let token: string | undefined;
  for (;;) {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || undefined, MaxKeys: Math.min(1000, cap - entries.length), ContinuationToken: token }));
    for (const o of page.Contents ?? []) entries.push(entryOf(o));
    if (!page.IsTruncated || !page.NextContinuationToken) return { entries, capped: false };
    if (entries.length >= cap) return { entries, capped: true };
    token = page.NextContinuationToken;
  }
}

function aggregate(entries: Entry[]) {
  let bytes = 0;
  let last: string | null = null;
  const classes: Record<string, number> = {};
  const ext: Record<string, { n: number; bytes: number }> = {};
  for (const e of entries) {
    bytes += e.size;
    if (e.last_modified && (!last || e.last_modified > last)) last = e.last_modified;
    const sc = e.storage_class ?? "STANDARD";
    classes[sc] = (classes[sc] ?? 0) + 1;
    const base = e.key.slice(e.key.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    const x = dot > 0 ? base.slice(dot + 1).toLowerCase().slice(0, 16) : "(sans extension)";
    ext[x] = { n: (ext[x]?.n ?? 0) + 1, bytes: (ext[x]?.bytes ?? 0) + e.size };
  }
  return { bytes, last, classes, ext };
}

function topPrefixes(entries: Entry[], base: string): Row[] {
  const agg: Record<string, { n: number; bytes: number; last: string | null }> = {};
  for (const e of entries) {
    const rest = e.key.slice(base.length);
    const i = rest.indexOf("/");
    const p = i >= 0 ? base + rest.slice(0, i + 1) : "(racine)";
    const a = (agg[p] ??= { n: 0, bytes: 0, last: null });
    a.n++;
    a.bytes += e.size;
    if (e.last_modified && (!a.last || e.last_modified > a.last)) a.last = e.last_modified;
  }
  return Object.entries(agg)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 50)
    .map(([prefix, a]) => ({ prefix, objects: a.n, bytes: a.bytes, last_modified: a.last }));
}

const httpStatus = (e: unknown): number | undefined => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;

// HeadObject when the key allows it (s3:GetObject); a list-only key (403) falls back to the
// ListObjectsV2 entry of that exact key: size, date, etag, class, but no content type / preview.
async function headRow(client: S3Client, bucket: string, key: string): Promise<{ row: Row; contentType: string | null; size: number; headDenied: boolean }> {
  try {
    const h = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const contentType = h.ContentType ?? null;
    const size = Number(h.ContentLength ?? 0);
    const row: Row = { key, size, last_modified: h.LastModified?.toISOString() ?? null, etag: h.ETag?.replace(/^"|"$/g, "") ?? null, storage_class: h.StorageClass ?? null, content_type: contentType, content_encoding: h.ContentEncoding ?? null, version_id: h.VersionId ?? null, user_metadata_keys: Object.keys(h.Metadata ?? {}).length, sse: h.ServerSideEncryption ?? null };
    return { row, contentType, size, headDenied: false };
  } catch (err) {
    const status = httpStatus(err);
    if (status === 404) throw new Error(`Objet introuvable : ${key}.`);
    if (status !== 403) throw err;
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }));
    const o = (page.Contents ?? []).find((x) => x.Key === key);
    if (!o) throw new Error(`Objet introuvable : ${key}.`);
    const e = entryOf(o);
    return { row: { ...e, content_type: null, content_encoding: null, version_id: null, user_metadata_keys: null, sse: null }, contentType: null, size: e.size, headDenied: true };
  }
}

// First PREVIEW_BYTES bytes of text-typed objects only; binaries are never fetched.
async function preview(client: S3Client, bucket: string, key: string, contentType: string | null, size: number): Promise<string | null> {
  if (!contentType || !TEXT_PREVIEW.test(contentType) || size === 0) return null;
  const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${PREVIEW_BYTES - 1}` }));
  const bytes = await r.Body?.transformToByteArray();
  if (!bytes) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, PREVIEW_BYTES));
  return size > PREVIEW_BYTES ? `${text}… [aperçu tronqué, ${size} octets]` : text;
}

export const explorer: Explorer = {
  caveats: ["Listings limités à 5 000 objets par requête : au-delà, totaux = bornes inférieures (>=), filtres et tris sur cet échantillon.", "Aperçu du contenu : 4 Kio des objets de type texte uniquement, jamais les binaires.", "Clé en lecture seule : aucune écriture possible."],

  async listContainers(c) {
    return withClient(c, async (client) => {
      const res = await client.send(new ListBucketsCommand({}));
      return Promise.all(
        (res.Buckets ?? []).map(async (b): Promise<ExploreContainer> => {
          const name = b.Name ?? "";
          const [s, region, versioning] = await Promise.all([
            scan(client, name, "", 1000).catch(() => null),
            client.send(new GetBucketLocationCommand({ Bucket: name })).then((r) => r.LocationConstraint ?? "us-east-1", () => null),
            client.send(new GetBucketVersioningCommand({ Bucket: name })).then((r) => r.Status ?? "Disabled", () => null),
          ]);
          const a = s ? aggregate(s.entries) : null;
          return { name, kind: "bucket", sizeBytes: a ? a.bytes : null, objectCount: s ? s.entries.length : null, extra: { created: b.CreationDate?.toISOString() ?? null, region, versioning, ...(s?.capped ? { capped: ">= 1000 objets" } : {}) } };
        }),
      );
    }, "ListBuckets");
  },

  async listObjects(c, container) {
    const bucket = assertBucket(container);
    return withClient(c, async (client) => {
      const out: ExploreObject[] = [];
      const prefixes: string[] = [];
      let token: string | undefined;
      let rootObjects = 0;
      // Delimited listing: first-level prefixes + root objects (at most SCAN_CAP entries).
      for (;;) {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Delimiter: "/", MaxKeys: 1000, ContinuationToken: token }));
        for (const p of page.CommonPrefixes ?? []) if (p.Prefix) prefixes.push(p.Prefix);
        for (const o of page.Contents ?? []) {
          rootObjects++;
          const e = entryOf(o);
          if (out.length < 200) out.push({ name: e.key, kind: "object", estRows: 1, sizeBytes: e.size, lastModified: e.last_modified, extra: { storage_class: e.storage_class } });
        }
        if (!page.IsTruncated || !page.NextContinuationToken || prefixes.length + rootObjects >= SCAN_CAP) break;
        token = page.NextContinuationToken;
      }
      // Per-prefix counts: one ListObjectsV2 page (1000) per prefix, at most 100 prefixes counted.
      const counted = await Promise.all(
        prefixes.slice(0, 100).map(async (p): Promise<ExploreObject> => {
          const s = await scan(client, bucket, p, 1000).catch(() => null);
          const a = s ? aggregate(s.entries) : null;
          return { name: p, kind: "prefix", estRows: s ? s.entries.length : null, sizeBytes: a?.bytes ?? null, lastModified: a?.last ?? null, extra: s?.capped ? { capped: ">= 1000 objets" } : undefined };
        }),
      );
      const rest = prefixes.slice(100).map((p): ExploreObject => ({ name: p, kind: "prefix" }));
      const root: ExploreObject = { name: "/", kind: "bucket", estRows: null, extra: { description: "Tout le bucket (listing récursif)" } };
      return [root, ...counted, ...rest, ...out];
    }, "ListObjectsV2");
  },

  async describeObject(c, container, object) {
    const bucket = assertBucket(container);
    const key = assertKey(object);
    return withClient(c, async (client) => {
      const columns = [
        { name: "key", type: "string", nullable: false, pk: true },
        { name: "size", type: "integer (octets)", nullable: false },
        { name: "last_modified", type: "timestamp", nullable: true },
        { name: "etag", type: "string (MD5 ou multipart)", nullable: true },
        { name: "storage_class", type: "string", nullable: true },
      ];
      if (isPrefix(key)) {
        const { entries, capped } = await scan(client, bucket, prefixOf(key));
        const a = aggregate(entries);
        const notes = ["Colonnes = métadonnées de listing S3 (ListObjectsV2), pas un schéma.", "Pas d'index ni de contraintes : stockage objet."];
        if (capped) notes.push(`Statistiques calculées sur les ${SCAN_CAP} premiers objets (bornes inférieures).`);
        const sample = entries[0] ? plainRow({ ...entries[0] }) : null;
        const storage: Record<string, unknown> = { objects: `${capped ? ">= " : ""}${entries.length}`, bytes: `${capped ? ">= " : ""}${a.bytes}`, last_modified: a.last, storage_classes: a.classes, capped };
        return { object: { name: key, kind: key === "/" ? "bucket" : "prefix", estRows: entries.length, sizeBytes: a.bytes, lastModified: a.last }, columns, indexes: [], constraints: [], partitioning: null, storage, sample, notes } satisfies ExploreDescription;
      }
      const { row, contentType, size, headDenied } = await headRow(client, bucket, key);
      const text = headDenied ? null : await preview(client, bucket, key, contentType, size).catch((e: Error) => `[aperçu indisponible : ${httpStatus(e) === 403 ? "accès refusé (clé sans s3:GetObject)" : e.message}]`);
      const notes = [headDenied ? "HeadObject refusé (clé sans s3:GetObject) : métadonnées du listing seulement, ni type de contenu ni aperçu." : "Objet unique : métadonnées HeadObject.", text === null ? "Aperçu non affiché : type non textuel, objet vide ou lecture refusée (les binaires ne sont jamais lus)." : `Aperçu : ${Math.min(size, PREVIEW_BYTES)} premiers octets (type ${contentType}).`];
      return { object: { name: key, kind: "object", estRows: 1, sizeBytes: size, lastModified: (row.last_modified as string | null) ?? null }, columns: [...columns, { name: "content_type", type: "string", nullable: true }, { name: "content_encoding", type: "string", nullable: true }, { name: "version_id", type: "string", nullable: true }, { name: "user_metadata_keys", type: "integer", nullable: false }, { name: "sse", type: "string", nullable: true }], indexes: [], constraints: [], partitioning: null, storage: { bytes: size, content_type: contentType, preview_bytes: text === null ? 0 : Math.min(size, PREVIEW_BYTES) }, sample: plainRow({ ...row, preview: truncateCell(text ?? null) }), notes } satisfies ExploreDescription;
    }, "describe");
  },

  async browseRows(c, container, object, req) {
    const bucket = assertBucket(container);
    const key = assertKey(object);
    const t0 = Date.now();
    // Validate filters and sort before touching the network.
    const { prefixHint } = compileFilters(req.filters);
    if (req.sortColumn) assertColumn(req.sortColumn, "Colonne de tri");
    return withClient(c, async (client) => {
      if (!isPrefix(key)) {
        const { row, contentType, size, headDenied } = await headRow(client, bucket, key);
        const text = headDenied ? null : await preview(client, bucket, key, contentType, size).catch(() => null);
        const entry: Entry = { key, size, last_modified: row.last_modified as string | null, etag: row.etag as string | null, storage_class: row.storage_class as string | null };
        const { filtered: _single, ...r } = pageEntries([entry], req, false);
        void _single;
        const rows = r.rows.map((x) => ({ ...x, content_type: contentType, preview: truncateCell(text ?? null) }));
        return { ...r, columns: [...BROWSE_COLUMNS, "content_type", "preview"], rows, durationMs: Date.now() - t0, notes: [headDenied ? "Objet unique : clé sans s3:GetObject, métadonnées du listing seulement." : "Objet unique : une ligne, aperçu texte 4 Kio au plus."] };
      }
      const base = prefixOf(key);
      // A key filter `= x` / `like 'x%'` narrows the server-side listing when it falls under the prefix.
      const effective = prefixHint && prefixHint.startsWith(base) ? prefixHint : base;
      const { entries, capped } = await scan(client, bucket, effective);
      const { filtered: _f, ...r } = pageEntries(entries, req, capped);
      void _f;
      return { ...r, durationMs: Date.now() - t0 };
    }, "browse");
  },

  async columnProfile(c, container, object, column) {
    const bucket = assertBucket(container);
    const key = assertKey(object);
    const col = assertColumn(column);
    if (!isPrefix(key)) return { unsupported: true, reason: "Profil disponible sur un préfixe ou le bucket entier, pas sur un objet unique." };
    return withClient(c, async (client) => {
      const { entries, capped } = await scan(client, bucket, prefixOf(key), PROFILE_SAMPLE);
      const values = entries.map((e) => e[col]);
      const nonNull = values.filter((v) => v !== null && v !== undefined);
      const counts = new Map<string, number>();
      for (const v of nonNull) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 10)
        .map(([value, count]) => ({ value: col === "size" ? Number(value) : value, count }));
      const sorted = [...nonNull].sort(cmpValues);
      const notes = [`Échantillon : ${entries.length} objet${entries.length > 1 ? "s" : ""} listés (ordre des clés)${capped ? `, listing tronqué à ${PROFILE_SAMPLE}` : ""}.`];
      return { column: col, sampleSize: entries.length, nullPct: entries.length ? Math.round((1000 * (entries.length - nonNull.length)) / entries.length) / 10 : 0, distinct: counts.size, distinctIsEstimate: capped, min: sorted[0] ?? null, max: sorted[sorted.length - 1] ?? null, top, notes } satisfies ColumnProfile;
    }, "profile");
  },

  async stats(c, container) {
    const t0 = Date.now();
    const sections: StatSection[] = [];
    if (!container) {
      const [buckets, server] = await Promise.all([explorer.listContainers(c), serverHeader(c)]);
      sections.push({ key: "server", title: "Serveur", rows: [{ server: server ?? "n/d", buckets: buckets.length, objects: buckets.reduce((a, b) => a + (b.objectCount ?? 0), 0), bytes: buckets.reduce((a, b) => a + (b.sizeBytes ?? 0), 0) }] });
      sections.push({ key: "buckets", title: "Buckets", description: "Objets et volume (listing limité à 1 000 objets par bucket).", columns: ["bucket", "objects", "bytes", "region", "versioning", "created", "capped"], rows: buckets.map((b) => ({ bucket: b.name, objects: b.objectCount, bytes: b.sizeBytes, region: b.extra?.region ?? null, versioning: b.extra?.versioning ?? null, created: b.extra?.created ?? null, capped: b.extra?.capped ?? null })) });
      return { container: null, sections, durationMs: Date.now() - t0 };
    }
    const bucket = assertBucket(container);
    return withClient(c, async (client) => {
      const [{ entries, capped }, region, versioning] = await Promise.all([
        scan(client, bucket, ""),
        client.send(new GetBucketLocationCommand({ Bucket: bucket })).then((r) => r.LocationConstraint ?? "us-east-1", () => null),
        client.send(new GetBucketVersioningCommand({ Bucket: bucket })).then((r) => r.Status ?? "Disabled", () => null),
      ]);
      const a = aggregate(entries);
      const note = capped ? `Calculé sur les ${SCAN_CAP} premiers objets (ordre des clés) : bornes inférieures.` : undefined;
      sections.push({ key: "bucket", title: "Bucket", rows: [{ bucket, region, versioning, objects: `${capped ? ">= " : ""}${entries.length}`, bytes: `${capped ? ">= " : ""}${a.bytes}`, last_modified: a.last, avg_object_bytes: entries.length ? Math.round(a.bytes / entries.length) : 0 }], note });
      sections.push({ key: "prefixes", title: "Volume par préfixe de premier niveau", description: "Top 50 par volume.", columns: ["prefix", "objects", "bytes", "last_modified"], rows: topPrefixes(entries, ""), note });
      sections.push({ key: "extensions", title: "Répartition par extension", columns: ["extension", "objects", "bytes"], rows: Object.entries(a.ext).sort((x, y) => y[1].bytes - x[1].bytes).slice(0, 30).map(([extension, v]) => ({ extension, objects: v.n, bytes: v.bytes })), note });
      sections.push({ key: "classes", title: "Classes de stockage", columns: ["storage_class", "objects"], rows: Object.entries(a.classes).map(([storage_class, objects]) => ({ storage_class, objects })) });
      sections.push({ key: "largest", title: "Plus gros objets", columns: ["key", "size", "last_modified"], rows: [...entries].sort((x, y) => y.size - x.size).slice(0, 20).map((e) => ({ key: e.key, size: e.size, last_modified: e.last_modified })), note });
      sections.push({ key: "recent", title: "Objets les plus récents", columns: ["key", "size", "last_modified"], rows: [...entries].sort((x, y) => cmpValues(y.last_modified, x.last_modified)).slice(0, 20).map((e) => ({ key: e.key, size: e.size, last_modified: e.last_modified })), note });
      const empty = entries.filter((e) => e.size === 0).length;
      sections.push({ key: "hygiene", title: "Hygiène", rows: [{ empty_objects: empty, multipart_etags: entries.filter((e) => e.etag?.includes("-")).length, delimiter_markers: entries.filter((e) => e.key.endsWith("/")).length }], note });
      return { container: bucket, sections, durationMs: Date.now() - t0 };
    }, "stats");
  },
};
