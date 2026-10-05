import cassandra, { types as cqlTypes, policies } from "cassandra-driver";
import { MAX_ROWS, PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS, errorMessage, withTimeout, type Conn, type Probe, type QueryResult, type Row } from "./types";

// Apache Cassandra / ScyllaDB over CQL (9042) with the DataStax driver.
// Tested against scylladb/scylla:6.1 (tests/integration/cassandra.test.ts).
// One short-lived client per call: the fleet checker probes every 30 s and a pooled
// driver would keep a control connection + gossip refresh running per instance.

export const CONSOLE_LIMIT = 200;

export async function withClient<T>(c: Conn, fn: (client: cassandra.Client) => Promise<T>, readTimeout = PROBE_TIMEOUT_MS): Promise<T> {
  const client = new cassandra.Client({
    contactPoints: [`${c.host}:${c.port}`],
    // RoundRobin needs no localDataCenter (unknown before the first connection); one DC in the homelab anyway.
    policies: { loadBalancing: new policies.loadBalancing.RoundRobinPolicy(), reconnection: new policies.reconnection.ConstantReconnectionPolicy(60_000) },
    credentials: c.username ? { username: c.username, password: c.password ?? "" } : undefined,
    sslOptions: c.tls ? { rejectUnauthorized: false } : undefined,
    socketOptions: { connectTimeout: PROBE_TIMEOUT_MS, readTimeout },
    queryOptions: { consistency: cqlTypes.consistencies.localOne, fetchSize: MAX_ROWS, prepare: false },
    applicationName: "db-monitor",
    // The console's keyspace: `USE` on connect (the per-query keyspace option needs protocol v5, Scylla speaks v4).
    keyspace: c.database || undefined,
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.shutdown().catch(() => undefined);
  }
}

// CQL values to plain JSON: Long/Integer/BigDecimal/Uuid/InetAddress/LocalDate/Duration have a textual form.
export function cqlValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `0x${v.toString("hex").slice(0, 64)}${v.length > 32 ? "…" : ""}`;
  if (Array.isArray(v)) return v.map(cqlValue);
  if (v instanceof Map) return JSON.stringify(Object.fromEntries([...v.entries()].map(([k, x]) => [String(cqlValue(k)), cqlValue(x)])));
  if (v instanceof Set) return [...v].map(cqlValue);
  if (typeof v === "object") {
    const o = v as { toString?: () => string; constructor?: { name?: string } };
    const name = o.constructor?.name ?? "";
    if (["Long", "Integer", "BigDecimal", "Uuid", "TimeUuid", "InetAddress", "LocalDate", "LocalTime", "Duration"].includes(name) && typeof o.toString === "function") return o.toString();
    return JSON.stringify(v);
  }
  return v;
}

export function rowsOf(rs: cqlTypes.ResultSet): Row[] {
  return rs.rows.map((r) => {
    const o: Row = {};
    for (const k of r.keys()) o[k] = cqlValue(r.get(k));
    return o;
  });
}

// Pure: system.local + peers + client count -> probe fields (unit-tested on fixtures).
// Version: Scylla reports a Cassandra-compatible `release_version` (3.0.8) in system.local and its
// own version in system.versions; Cassandra has only release_version.
// Uptime: Scylla exposes it in system.runtime_info ("43 seconds"); Cassandra has no CQL uptime, so
// `gossip_generation` (epoch second at which the node started gossiping = last start) approximates it.
export function fromLocal(local: Row, peers: Row[], clients: number | undefined, extra: { scyllaVersion?: string; runtimeUptime?: string } = {}, now = Date.now()): Omit<Probe, "up" | "latencyMs"> {
  const gen = Number(local.gossip_generation);
  const parsed = parseUptime(extra.runtimeUptime);
  const uptimeSec = parsed ?? (Number.isFinite(gen) && gen > 1_000_000_000 ? Math.max(0, Math.round(now / 1000 - gen)) : undefined);
  const nodes = peers.length + 1;
  const dcs = new Set([String(local.data_center), ...peers.map((p) => String(p.data_center))]);
  const flavour = extra.scyllaVersion ? `scylla ${extra.scyllaVersion}` : `cassandra ${local.release_version ?? "?"}`;
  return {
    version: flavour,
    uptimeSec,
    connUsed: clients,
    role: `${local.data_center ?? "?"}/${local.rack ?? "?"} · ${nodes} nœud${nodes > 1 ? "s" : ""}${dcs.size > 1 ? ` · ${dcs.size} DC` : ""}`,
  };
}

// "2 days, 3 hours, 4 minutes, 5 seconds" (Scylla runtime_info) -> seconds.
export function parseUptime(s: string | undefined): number | undefined {
  if (!s) return undefined;
  let total = 0;
  let any = false;
  for (const m of s.matchAll(/(\d+)\s*(day|hour|minute|second)s?/gi)) {
    any = true;
    total += Number(m[1]) * { day: 86400, hour: 3600, minute: 60, second: 1 }[m[2].toLowerCase() as "day" | "hour" | "minute" | "second"];
  }
  return any ? total : undefined;
}

// Scylla only: system.versions (real version) and system.runtime_info (uptime, memory).
async function scyllaExtras(client: cassandra.Client): Promise<{ scyllaVersion?: string; runtimeUptime?: string; runtime: Row[] }> {
  const v = await tryRows(client, "SELECT version FROM system.versions WHERE key = 'local'");
  const runtime = (await tryRows(client, "SELECT group, item, value FROM system.runtime_info")) ?? [];
  const up = runtime.find((r) => r.group === "generic" && r.item === "uptime");
  return { scyllaVersion: v?.[0]?.version ? String(v[0].version) : undefined, runtimeUptime: up ? String(up.value) : undefined, runtime };
}

async function tryRows(client: cassandra.Client, cql: string): Promise<Row[] | undefined> {
  try {
    return rowsOf(await client.execute(cql));
  } catch {
    return undefined;
  }
}

// Scylla: system.clients; Cassandra 4+: system_views.clients. Either may be absent.
async function clientCount(client: cassandra.Client): Promise<number | undefined> {
  for (const cql of ["SELECT count(*) AS n FROM system.clients", "SELECT count(*) AS n FROM system_views.clients"]) {
    const r = await tryRows(client, cql);
    if (r) return Number(r[0]?.n);
  }
  return undefined;
}

export async function sizeEstimates(client: cassandra.Client): Promise<Row[]> {
  // partitions_count * mean_partition_size per range; summed per table below.
  const rows = (await tryRows(client, "SELECT keyspace_name, table_name, partitions_count, mean_partition_size FROM system.size_estimates")) ?? [];
  const agg = new Map<string, { keyspace_name: string; table_name: string; partitions: number; size_bytes: number; ranges: number }>();
  for (const r of rows) {
    const key = `${r.keyspace_name}.${r.table_name}`;
    const a = agg.get(key) ?? { keyspace_name: String(r.keyspace_name), table_name: String(r.table_name), partitions: 0, size_bytes: 0, ranges: 0 };
    a.partitions += Number(r.partitions_count) || 0;
    a.size_bytes += (Number(r.partitions_count) || 0) * (Number(r.mean_partition_size) || 0);
    a.ranges++;
    agg.set(key, a);
  }
  return [...agg.values()].sort((a, b) => b.size_bytes - a.size_bytes);
}

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      withClient(c, async (client) => {
        const latencyMs = Date.now() - t0;
        const local = rowsOf(await client.execute("SELECT * FROM system.local"))[0] ?? {};
        const peers = (await tryRows(client, "SELECT peer, data_center, rack, release_version FROM system.peers")) ?? [];
        const clients = await clientCount(client);
        const est = await sizeEstimates(client);
        const extras = await scyllaExtras(client);
        const sizeBytes = est.filter((e) => !String(e.keyspace_name).startsWith("system")).reduce((s, e) => s + BigInt(Math.round(Number(e.size_bytes))), 0n);
        return { up: true, latencyMs, ...fromLocal(local, peers, clients, extras), sizeBytes } satisfies Probe;
      }),
      PROBE_TIMEOUT_MS + 2000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

export type CassandraDetail = { local: Row; runtime: Row[]; peers: Row[]; keyspaces: Row[]; tables: Row[]; estimates: Row[]; clients: Row[]; compactions: Row[]; streams: Row[]; clientsSource?: string };

export async function detail(c: Conn): Promise<CassandraDetail> {
  return withClient(c, async (client) => {
    const local = rowsOf(await client.execute("SELECT cluster_name, data_center, rack, release_version, cql_version, native_protocol_version, partitioner, host_id, broadcast_address, gossip_generation, tokens FROM system.local"))[0] ?? {};
    if (Array.isArray(local.tokens)) local.tokens = `${(local.tokens as unknown[]).length} tokens`;
    const extras = await scyllaExtras(client);
    if (extras.scyllaVersion) local.scylla_version = extras.scyllaVersion;
    const peers = (await tryRows(client, "SELECT peer, data_center, rack, release_version, host_id, schema_version FROM system.peers")) ?? [];
    const ks = rowsOf(await client.execute("SELECT keyspace_name, durable_writes, replication FROM system_schema.keyspaces"));
    const tbl = rowsOf(await client.execute("SELECT keyspace_name, table_name, compaction, compression, default_time_to_live, gc_grace_seconds FROM system_schema.tables"));
    const estimates = await sizeEstimates(client);
    const estBy = new Map(estimates.map((e) => [`${e.keyspace_name}.${e.table_name}`, e]));
    const tables = tbl
      .map((t) => {
        const e = estBy.get(`${t.keyspace_name}.${t.table_name}`);
        let compaction = "";
        try {
          const cmp = JSON.parse(String(t.compaction ?? "{}")) as Record<string, string>;
          compaction = String(cmp.class ?? "").split(".").pop() ?? "";
        } catch {
          compaction = String(t.compaction ?? "");
        }
        return { keyspace: t.keyspace_name, table: t.table_name, partitions_est: e?.partitions ?? null, size_bytes_est: e ? Math.round(Number(e.size_bytes)) : null, compaction, ttl: t.default_time_to_live, gc_grace: t.gc_grace_seconds };
      })
      .sort((a, b) => Number(b.size_bytes_est ?? 0) - Number(a.size_bytes_est ?? 0));
    const keyspaces = ks.map((k) => ({ ...k, tables: tbl.filter((t) => t.keyspace_name === k.keyspace_name).length, size_bytes_est: estimates.filter((e) => e.keyspace_name === k.keyspace_name).reduce((s, e) => s + Number(e.size_bytes), 0) }));
    let clients: Row[] = [];
    let clientsSource: string | undefined;
    for (const [src, cql] of [
      ["system.clients", "SELECT address, port, username, driver_name, driver_version, protocol_version, ssl_enabled, connection_stage FROM system.clients"],
      ["system_views.clients", "SELECT address, port, username, driver_name, driver_version, protocol_version, ssl_enabled, request_count, connection_stage FROM system_views.clients"],
    ]) {
      const r = await tryRows(client, cql);
      if (r) {
        clients = r;
        clientsSource = src;
        break;
      }
    }
    // Cassandra 4: system_views.sstable_tasks (running compactions) and streaming; Scylla: compaction history only.
    const compactions = (await tryRows(client, "SELECT keyspace_name, table_name, task_id, kind, progress, total, unit FROM system_views.sstable_tasks")) ?? (await tryRows(client, "SELECT keyspace_name, columnfamily_name AS table_name, compacted_at, bytes_in, bytes_out FROM system.compaction_history LIMIT 50")) ?? [];
    const streams = (await tryRows(client, "SELECT * FROM system_views.streaming")) ?? [];
    return { local, runtime: extras.runtime, peers, keyspaces, tables, estimates, clients, compactions, streams, clientsSource };
  });
}

// --- read-only CQL console ----------------------------------------------------

const CQL_FORBIDDEN = /\b(insert|update|delete|truncate|drop|alter|create|batch|grant|revoke|use|apply|begin|list|describe|desc)\b/i;

export type CqlGuard = { ok: true; cql: string } | { ok: false; reason: string };

// Single SELECT, no DML/DDL anywhere, LIMIT forced <= CONSOLE_LIMIT, no ALLOW FILTERING on
// system_auth. Strings are stripped before the keyword check; `;` refused.
export function guardCql(input: string): CqlGuard {
  const raw = input.trim().replace(/;\s*$/, "");
  if (!raw) return { ok: false, reason: "Requête vide." };
  if (raw.length > 10_000) return { ok: false, reason: "Requête trop longue." };
  const stripped = raw
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " '' ")
    .replace(/'(?:[^']|'')*'/g, " '' ");
  if (/'(?!')/.test(stripped.replace(/''/g, ""))) return { ok: false, reason: "Littéral non terminé." };
  if (stripped.includes(";")) return { ok: false, reason: "Une seule instruction autorisée." };
  if (/"[^"]*"\s*\(/.test(stripped)) return { ok: false, reason: "Appel de fonction via un identifiant entre guillemets interdit." };
  const first = stripped.match(/^\s*([A-Za-z]+)/)?.[1]?.toLowerCase();
  if (first !== "select") return { ok: false, reason: "Seules les requêtes SELECT sont autorisées (CQL)." };
  const body = stripped.replace(/^\s*[A-Za-z]+/, "").replace(/"[^"]*"/g, ' "" ');
  const hit = body.match(CQL_FORBIDDEN);
  if (hit) return { ok: false, reason: `Mot-clé interdit : ${hit[1].toUpperCase()}.` };
  if (/\bsystem_auth\b/i.test(body)) return { ok: false, reason: "system_auth (hash des mots de passe) n'est pas consultable." };
  // LIMIT: cap an existing one, append otherwise (before ALLOW FILTERING if present).
  const m = raw.match(/\blimit\s+(\d+)\s*(allow\s+filtering)?\s*$/i);
  let cql = raw;
  if (m) {
    if (Number(m[1]) > CONSOLE_LIMIT) cql = raw.replace(/\blimit\s+\d+/i, `LIMIT ${CONSOLE_LIMIT}`);
  } else if (/\blimit\b/i.test(stripped)) {
    return { ok: false, reason: "LIMIT doit être un entier littéral en fin de requête." };
  } else {
    const af = raw.match(/\s+allow\s+filtering\s*$/i);
    cql = af ? `${raw.slice(0, af.index)} LIMIT ${CONSOLE_LIMIT} ALLOW FILTERING` : `${raw} LIMIT ${CONSOLE_LIMIT}`;
  }
  return { ok: true, cql };
}

export async function readOnlyQuery(c: Conn, cql: string, keyspace?: string): Promise<QueryResult> {
  const g = guardCql(cql);
  if (!g.ok) throw new Error(g.reason);
  const ks = keyspace ?? c.database ?? undefined;
  if (ks && !/^[A-Za-z_][\w]{0,47}$/.test(ks)) throw new Error("Keyspace invalide.");
  const t0 = Date.now();
  return withClient(
    { ...c, database: ks },
    async (client) => {
      const rs = await withTimeout(client.execute(g.cql, [], { consistency: cqlTypes.consistencies.localOne, fetchSize: CONSOLE_LIMIT, readTimeout: QUERY_TIMEOUT_MS, prepare: false }), QUERY_TIMEOUT_MS + 500, "query");
      const rows = rowsOf(rs);
      const columns = rs.columns?.map((x) => x.name) ?? Object.keys(rows[0] ?? {});
      return { columns, rows, rowCount: rows.length, durationMs: Date.now() - t0, truncated: rows.length >= CONSOLE_LIMIT };
    },
    QUERY_TIMEOUT_MS,
  );
}
