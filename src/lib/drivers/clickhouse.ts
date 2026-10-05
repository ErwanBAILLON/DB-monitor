import { httpRequest } from "./http";
import { guardReadOnly } from "@/lib/sqlguard";
import { PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS, errorMessage, plainRow, tabulate, withTimeout, type Conn, type Probe, type QueryResult, type Row } from "./types";

// ClickHouse over its HTTP interface (8123/8443), plain fetch, no client library.
// Tested against clickhouse/clickhouse-server:24.8 (tests/integration/clickhouse.test.ts).

type ChResponse = { meta: { name: string; type: string }[]; data: unknown[][]; rows: number; statistics?: { elapsed: number } };

// One query with JSONCompact output. `settings` are passed as URL parameters, which
// ClickHouse enforces server-side (readonly=1 forbids any write and any SET).
export async function query(c: Conn, sql: string, settings: Record<string, string | number> = {}, timeoutMs = PROBE_TIMEOUT_MS): Promise<ChResponse> {
  const url = new URL(`${c.tls ? "https" : "http"}://${c.host}:${c.port}/`);
  url.searchParams.set("default_format", "JSONCompact");
  url.searchParams.set("max_execution_time", String(Math.ceil(timeoutMs / 1000)));
  if (c.database) url.searchParams.set("database", c.database);
  for (const [k, v] of Object.entries(settings)) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { "X-ClickHouse-User": c.username || "default", "X-ClickHouse-Key": c.password ?? "", "Content-Type": "text/plain" };
  const res = await httpRequest({ url, method: "POST", headers, body: sql, timeoutMs: timeoutMs + 1000, insecureTls: c.tls });
  if (res.status !== 200) throw new Error(`ClickHouse HTTP ${res.status}: ${res.text.slice(0, 500).trim()}`);
  if (!res.text.trim()) return { meta: [], data: [], rows: 0 };
  return JSON.parse(res.text) as ChResponse;
}

export function toRows(r: ChResponse): Row[] {
  const cols = r.meta.map((m) => m.name);
  return r.data.map((arr) => {
    const o: Row = {};
    cols.forEach((name, i) => (o[name] = arr[i]));
    return plainRow(o);
  });
}
const scalar = (r: ChResponse) => r.data[0]?.[0];

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      (async () => {
        await query(c, "SELECT 1");
        const latencyMs = Date.now() - t0;
        const r = await query(
          c,
          `SELECT version() AS version, uptime() AS uptime,
                  (SELECT value FROM system.metrics WHERE metric = 'TCPConnection') + (SELECT value FROM system.metrics WHERE metric = 'HTTPConnection') AS conns,
                  (SELECT value FROM system.server_settings WHERE name = 'max_connections') AS max_conns,
                  (SELECT sum(bytes_on_disk) FROM system.parts WHERE active) AS bytes,
                  (SELECT value FROM system.metrics WHERE metric = 'MemoryTracking') AS mem,
                  (SELECT value FROM system.server_settings WHERE name = 'max_server_memory_usage') AS mem_max,
                  (SELECT count() FROM system.replicas WHERE is_readonly) AS ro_replicas`,
        );
        const row = toRows(r)[0] ?? {};
        return {
          up: true,
          latencyMs,
          version: String(row.version),
          uptimeSec: Number(row.uptime),
          connUsed: Number(row.conns),
          connMax: Number(row.max_conns) || undefined,
          sizeBytes: BigInt(String(row.bytes ?? 0)),
          role: Number(row.ro_replicas) > 0 ? "readonly-replica" : "server",
        } satisfies Probe;
      })(),
      PROBE_TIMEOUT_MS + 1000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

export type ChDetail = { databases: Row[]; tables: Row[]; processes: Row[]; merges: Row[]; replication: Row[]; metrics: Row[]; settings: Row[] };

export async function detail(c: Conn): Promise<ChDetail> {
  const q = async (sql: string) => toRows(await query(c, sql));
  const [databases, tables, processes, merges, replication, metrics, settings] = await Promise.all([
    q(`SELECT d.name AS name, d.engine AS engine, count(t.name) AS tables, coalesce(sum(p.bytes), 0) AS size_bytes, coalesce(sum(p.rows), 0) AS rows
         FROM system.databases d
         LEFT JOIN system.tables t ON t.database = d.name
         LEFT JOIN (SELECT database, table, sum(bytes_on_disk) AS bytes, sum(rows) AS rows FROM system.parts WHERE active GROUP BY database, table) p ON p.database = t.database AND p.table = t.name
        GROUP BY d.name, d.engine ORDER BY size_bytes DESC`),
    q(`SELECT database, table, sum(rows) AS rows, sum(bytes_on_disk) AS size_bytes, formatReadableSize(sum(bytes_on_disk)) AS size,
              sum(data_uncompressed_bytes) AS uncompressed_bytes, count() AS parts, max(modification_time) AS last_modified
         FROM system.parts WHERE active GROUP BY database, table ORDER BY size_bytes DESC LIMIT 100`),
    q(`SELECT query_id, user, elapsed, read_rows, formatReadableSize(read_bytes) AS read, formatReadableSize(memory_usage) AS memory, client_name, left(query, 300) AS query
         FROM system.processes WHERE query NOT LIKE '%system.processes%' ORDER BY elapsed DESC`),
    q(`SELECT database, table, elapsed, progress, num_parts, formatReadableSize(total_size_bytes_compressed) AS size, is_mutation, merge_type FROM system.merges ORDER BY elapsed DESC LIMIT 50`),
    q(`SELECT database, table, is_leader, is_readonly, absolute_delay, queue_size, inserts_in_queue, merges_in_queue, total_replicas, active_replicas FROM system.replicas ORDER BY absolute_delay DESC LIMIT 100`),
    q(`SELECT metric, value, description FROM system.metrics WHERE metric IN ('Query','Merge','TCPConnection','HTTPConnection','MemoryTracking','BackgroundMergesAndMutationsPoolTask','ReplicatedFetch','ReadonlyReplica','PartsActive')
       UNION ALL SELECT metric, toInt64(value), description FROM system.asynchronous_metrics WHERE metric IN ('Uptime','OSMemoryAvailable','MaxPartCountForPartition','TotalPartsOfMergeTreeTables','NumberOfDatabases','NumberOfTables','ReplicasMaxQueueSize','ReplicasMaxAbsoluteDelay')
       ORDER BY metric`),
    q(`SELECT name, value, description FROM system.server_settings WHERE name IN ('max_connections','max_concurrent_queries','max_server_memory_usage','max_server_memory_usage_to_ram_ratio','background_pool_size','max_thread_pool_size','keep_alive_timeout','mark_cache_size','uncompressed_cache_size') ORDER BY name`),
  ]);
  return { databases, tables, processes, merges, replication, metrics, settings };
}

export async function killQuery(c: Conn, queryId: string): Promise<string> {
  if (!/^[\w-]{1,128}$/.test(queryId)) throw new Error("query_id invalide.");
  const r = await query(c, `KILL QUERY WHERE query_id = '${queryId}' ASYNC`);
  return String(scalar(r) ?? "sent");
}

// Read-only console: guard + readonly=1 (server-side: no writes, no SET) + max_execution_time.
export async function readOnlyQuery(c: Conn, sql: string, database?: string): Promise<QueryResult> {
  const g = guardReadOnly(sql, { allowFirst: ["describe", "desc", "exists"] });
  if (!g.ok) throw new Error(g.reason);
  const t0 = Date.now();
  const r = await query({ ...c, database: database ?? c.database }, g.sql, { readonly: 1, max_result_rows: 100_000, result_overflow_mode: "break" }, QUERY_TIMEOUT_MS);
  return tabulate(
    r.meta.map((m) => m.name),
    r.data,
    t0,
  );
}
