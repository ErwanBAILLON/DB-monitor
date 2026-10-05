import { MongoClient, type Document } from "mongodb";
import { MAX_ROWS, PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS, errorMessage, plainRow, withTimeout, type Conn, type Probe, type QueryResult, type Row } from "./types";

// Tested against mongo:7.0 (tests/integration/mongodb.test.ts).

function urlOf(c: Conn): string {
  const auth = c.username ? `${encodeURIComponent(c.username)}:${encodeURIComponent(c.password ?? "")}@` : "";
  const authSource = c.username ? `authSource=${encodeURIComponent(c.database || "admin")}&` : "";
  return `mongodb://${auth}${c.host}:${c.port}/?${authSource}directConnection=true${c.tls ? "&tls=true&tlsAllowInvalidCertificates=true" : ""}`;
}

export async function withMongo<T>(c: Conn, fn: (client: MongoClient) => Promise<T>): Promise<T> {
  const client = new MongoClient(urlOf(c), { serverSelectionTimeoutMS: PROBE_TIMEOUT_MS, connectTimeoutMS: PROBE_TIMEOUT_MS, socketTimeoutMS: 15_000, maxPoolSize: 2, appName: "db-monitor" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : v && typeof v === "object" && "toNumber" in v ? (v as { toNumber: () => number }).toNumber() : undefined);

// serverStatus / replSetGetStatus -> probe fields (pure, unit-tested on fixtures).
export function fromServerStatus(s: Document, repl?: Document | null): Omit<Probe, "up" | "latencyMs"> {
  const conns = s.connections ?? {};
  let role: string | undefined;
  if (s.repl?.ismaster !== undefined || s.repl?.isWritablePrimary !== undefined) role = s.repl.ismaster || s.repl.isWritablePrimary ? "primary" : s.repl.secondary ? "secondary" : "member";
  else if (repl?.myState !== undefined) role = repl.myState === 1 ? "primary" : repl.myState === 2 ? "secondary" : `state ${repl.myState}`;
  else role = "standalone";
  return {
    version: s.version,
    uptimeSec: n(s.uptime) !== undefined ? Math.round(n(s.uptime)!) : undefined,
    connUsed: n(conns.current),
    connMax: n(conns.current) !== undefined && n(conns.available) !== undefined ? n(conns.current)! + n(conns.available)! : undefined,
    role,
  };
}

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      withMongo(c, async (client) => {
        const admin = client.db("admin");
        await admin.command({ ping: 1 });
        const latencyMs = Date.now() - t0;
        const s = await admin.command({ serverStatus: 1, repl: 1, connections: 1, mem: 1 });
        const dbs = await admin.command({ listDatabases: 1 });
        return { up: true, latencyMs, ...fromServerStatus(s), sizeBytes: BigInt(Math.round(n(dbs.totalSize) ?? 0)) } satisfies Probe;
      }),
      PROBE_TIMEOUT_MS + 1000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

export type MongoDetail = {
  server: Row;
  databases: Row[];
  currentOp: Row[];
  replicaSet: Row[] | null;
  mem: Row;
};

export async function detail(c: Conn): Promise<MongoDetail> {
  return withMongo(c, async (client) => {
    const admin = client.db("admin");
    const [s, dbs, ops] = await Promise.all([
      admin.command({ serverStatus: 1 }),
      admin.command({ listDatabases: 1 }),
      // $currentOp through the aggregation pipeline (the currentOp command is deprecated).
      admin
        .aggregate([{ $currentOp: { allUsers: true, idleConnections: false } }, { $limit: 200 }])
        .toArray()
        .catch(() => [] as Document[]),
    ]);
    const replicaSet = await admin
      .command({ replSetGetStatus: 1 })
      .then((r: Document) => (r.members ?? []).map((m: Document) => plainRow({ name: m.name, state: m.stateStr, health: m.health, uptime: m.uptime, optime: m.optimeDate, ping_ms: m.pingMs, self: !!m.self })))
      .catch(() => null);
    return {
      server: plainRow({ version: s.version, process: s.process, pid: s.pid, host: s.host, uptime_s: Math.round(s.uptime ?? 0), storage_engine: s.storageEngine?.name, connections_current: s.connections?.current, connections_available: s.connections?.available, connections_total_created: s.connections?.totalCreated, ops_insert: s.opcounters?.insert, ops_query: s.opcounters?.query, ops_update: s.opcounters?.update, ops_delete: s.opcounters?.delete, ops_command: s.opcounters?.command }),
      mem: plainRow({ resident_mb: s.mem?.resident, virtual_mb: s.mem?.virtual, wiredtiger_cache_bytes: s.wiredTiger?.cache?.["bytes currently in the cache"], wiredtiger_cache_max_bytes: s.wiredTiger?.cache?.["maximum bytes configured"] }),
      databases: ((dbs.databases ?? []) as Document[]).map((d) => plainRow({ name: d.name, size_bytes: n(d.sizeOnDisk), empty: d.empty })),
      currentOp: ops.map((o) => plainRow({ opid: o.opid, active: o.active, secs_running: o.secs_running, op: o.op, ns: o.ns, client: o.client, app: o.appName, user: Object.keys(o.effectiveUsers?.[0] ?? {}).length ? `${o.effectiveUsers[0].user}@${o.effectiveUsers[0].db}` : "", desc: o.desc, command: JSON.stringify(o.command ?? {}).slice(0, 300), waiting_for_lock: o.waitingForLock })),
      replicaSet,
    };
  });
}

// Collections of one database with counts, sizes and index list.
export async function collections(c: Conn, database: string): Promise<Row[]> {
  assertDbName(database);
  return withMongo(c, async (client) => {
    const db = client.db(database);
    const cols = await db.listCollections({}, { nameOnly: false }).toArray();
    const out: Row[] = [];
    for (const col of cols.slice(0, 200)) {
      if (col.type === "view") {
        out.push({ name: col.name, type: "view", documents: null, size_bytes: null, storage_bytes: null, indexes: null, index_bytes: null, index_names: "" });
        continue;
      }
      const st = (await db
        .collection(col.name)
        .aggregate([{ $collStats: { storageStats: {} } }])
        .next()
        .catch(() => null)) as Document | null;
      const ss = st?.storageStats ?? {};
      const idx = await db
        .collection(col.name)
        .indexes()
        .catch(() => [] as Document[]);
      out.push({ name: col.name, type: col.type ?? "collection", documents: n(ss.count), size_bytes: n(ss.size), storage_bytes: n(ss.storageSize), indexes: n(ss.nindexes), index_bytes: n(ss.totalIndexSize), index_names: idx.map((i: Document) => i.name).join(", ") });
    }
    return out.sort((a, b) => Number(b.storage_bytes ?? 0) - Number(a.storage_bytes ?? 0));
  });
}

export async function killOp(c: Conn, opid: number | string): Promise<void> {
  await withMongo(c, async (client) => {
    await client.db("admin").command({ killOp: 1, op: typeof opid === "string" && /^\d+$/.test(opid) ? Number(opid) : opid });
  });
}

const DB_NAME = /^[A-Za-z0-9_-]{1,63}$/;
export function assertDbName(s: string): string {
  if (!DB_NAME.test(s)) throw new Error("Nom de base invalide : lettres, chiffres, _ et - (max 63).");
  return s;
}

// Creates <database>.<user> with readWrite on that database. The database itself
// appears when its first collection is written, so a marker collection is created.
export async function createDatabase(c: Conn, database: string, user: string | undefined, password: string | undefined): Promise<void> {
  assertDbName(database);
  await withMongo(c, async (client) => {
    const db = client.db(database);
    await db.createCollection("_dbmon_init").catch(() => undefined);
    if (user) {
      assertDbName(user);
      if (!password) throw new Error("Mot de passe requis pour un nouvel utilisateur.");
      await db.command({ createUser: user, pwd: password, roles: [{ role: "readWrite", db: database }] });
    }
  });
}

// --- read-only console --------------------------------------------------------
// A JSON spec: { "collection": "x", "filter": {...}, "projection": {...}, "sort": {...}, "limit": 50 }
// or { "collection": "x", "pipeline": [ ... ] }. Executed with readPreference
// secondaryPreferred and maxTimeMS; operator names that run code are refused.

export type MongoQuerySpec = { collection: string; filter?: Document; projection?: Document; sort?: Document; limit?: number; pipeline?: Document[] };
const FORBIDDEN_OPS = new Set(["$where", "$function", "$accumulator", "$out", "$merge", "$currentOp", "$listLocalSessions", "$listSessions", "$planCacheStats", "$collStats", "$indexStats", "$shardedDataDistribution", "$changeStream", "$queryStats", "$listSampledQueries", "$listSearchIndexes", "$listCatalog"]);
// Stages that read another collection of the same database: the referenced name must
// pass the same check as the top-level collection (system.users holds the SCRAM credentials).
const COLLECTION_REFS: Record<string, (v: unknown) => unknown> = {
  $unionWith: (v) => (typeof v === "string" ? v : (v as Document)?.coll),
  $lookup: (v) => fromOf((v as Document)?.from),
  $graphLookup: (v) => fromOf((v as Document)?.from),
};
// `from` may be a string or { db, coll } (cross-database forms are refused by the server anyway).
const fromOf = (v: unknown) => (v && typeof v === "object" ? ((v as Document).coll ?? "") : v);
const MAX_LIMIT = 200;

export function isAllowedCollection(name: unknown): name is string {
  return typeof name === "string" && /^[\w.-]{1,120}$/.test(name) && !/^system\.|\.system\./i.test(name);
}

export function guardMongoSpec(input: string): { ok: true; spec: MongoQuerySpec } | { ok: false; reason: string } {
  if (input.length > 20_000) return { ok: false, reason: "Requête trop longue." };
  let spec: MongoQuerySpec;
  try {
    spec = JSON.parse(input);
  } catch {
    return { ok: false, reason: "JSON invalide." };
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, reason: "Un objet JSON est attendu." };
  if (!isAllowedCollection(spec.collection)) return { ok: false, reason: "collection : nom requis." };
  if (spec.pipeline !== undefined && !Array.isArray(spec.pipeline)) return { ok: false, reason: "pipeline doit être un tableau." };
  const limit = spec.limit === undefined ? 50 : Number(spec.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { ok: false, reason: `limit : entier entre 1 et ${MAX_LIMIT}.` };
  const bad = findForbidden(spec);
  if (bad) return { ok: false, reason: `Opérateur interdit : ${bad}.` };
  return { ok: true, spec: { ...spec, limit } };
}

function findForbidden(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = findForbidden(x);
      if (r) return r;
    }
    return null;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_OPS.has(k)) return k;
      if (k.startsWith("$") && /^\$(where|function|accumulator|out|merge)$/i.test(k)) return k;
      const ref = COLLECTION_REFS[k];
      if (ref) {
        const target = ref(x);
        // $lookup without `from` (sub-pipeline with $documents) is fine; a system.* target is not.
        if (target !== undefined && !isAllowedCollection(target)) return `${k} vers ${String(target)}`;
      }
      const r = findForbidden(x);
      if (r) return r;
    }
  }
  return null;
}

export async function readOnlyQuery(c: Conn, input: string, database?: string): Promise<QueryResult> {
  const g = guardMongoSpec(input);
  if (!g.ok) throw new Error(g.reason);
  const dbName = database || c.database || "admin";
  assertDbName(dbName);
  return withMongo(c, async (client) => {
    const t0 = Date.now();
    const col = client.db(dbName, { readPreference: "secondaryPreferred" }).collection(g.spec.collection);
    let docs: Document[];
    if (g.spec.pipeline) {
      docs = await col.aggregate([...g.spec.pipeline, { $limit: g.spec.limit! }], { maxTimeMS: QUERY_TIMEOUT_MS, allowDiskUse: false }).toArray();
    } else {
      docs = await col
        .find(g.spec.filter ?? {}, { projection: g.spec.projection, sort: g.spec.sort, limit: g.spec.limit, maxTimeMS: QUERY_TIMEOUT_MS })
        .toArray();
    }
    const cols = new Set<string>();
    for (const d of docs) for (const k of Object.keys(d)) cols.add(k);
    const columns = [...cols].slice(0, 60);
    const rows = docs.slice(0, MAX_ROWS).map((d) => {
      const o: Row = {};
      for (const k of columns) o[k] = d[k] === undefined ? null : d[k];
      return plainRow(o);
    });
    return { columns, rows, rowCount: docs.length, durationMs: Date.now() - t0, truncated: docs.length > MAX_ROWS };
  });
}
