import mysql from "mysql2/promise";
import { guardReadOnly } from "@/lib/sqlguard";
import { MAX_ROWS, PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS, errorMessage, plainRow, withTimeout, type Conn, type Probe, type QueryResult, type Row } from "./types";

// Built from the documentation; no MySQL instance in the homelab yet, so this
// driver is untested against a live server (see README).

async function withMy<T>(c: Conn, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({
    host: c.host,
    port: c.port,
    user: c.username ?? "root",
    password: c.password ?? "",
    database: c.database || undefined,
    ssl: c.tls ? { rejectUnauthorized: false } : undefined,
    connectTimeout: PROBE_TIMEOUT_MS,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function rows(conn: mysql.Connection, sql: string, params: unknown[] = []): Promise<Row[]> {
  const [r] = await conn.query(sql, params);
  return (r as Row[]).map(plainRow);
}

const status = async (conn: mysql.Connection, names: string[]) => {
  const r = await rows(conn, `SHOW GLOBAL STATUS WHERE Variable_name IN (${names.map(() => "?").join(",")})`, names);
  return Object.fromEntries(r.map((x) => [String(x.Variable_name), String(x.Value)]));
};
const variables = async (conn: mysql.Connection, names: string[]) => {
  const r = await rows(conn, `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${names.map(() => "?").join(",")})`, names);
  return Object.fromEntries(r.map((x) => [String(x.Variable_name), String(x.Value)]));
};

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      withMy(c, async (conn) => {
        await conn.query("SELECT 1");
        const latencyMs = Date.now() - t0;
        const s = await status(conn, ["Uptime", "Threads_connected"]);
        const v = await variables(conn, ["version", "max_connections", "read_only"]);
        const size = await rows(conn, "SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes FROM information_schema.tables");
        return {
          up: true,
          latencyMs,
          version: v.version,
          uptimeSec: Number(s.Uptime),
          connUsed: Number(s.Threads_connected),
          connMax: Number(v.max_connections),
          sizeBytes: BigInt(String(size[0]?.bytes ?? 0)),
          role: v.read_only === "ON" ? "replica" : "primary",
        } satisfies Probe;
      }),
      PROBE_TIMEOUT_MS + 1000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

export type MyDetail = { databases: Row[]; processlist: Row[]; variables: Row[]; status: Row[] };

export async function detail(c: Conn): Promise<MyDetail> {
  return withMy(c, async (conn) => {
    const [databases, processlist, vars, st] = await Promise.all([
      rows(
        conn,
        `SELECT s.schema_name AS name, s.default_character_set_name AS charset,
                COALESCE(SUM(t.data_length + t.index_length), 0) AS size_bytes, COUNT(t.table_name) AS tables
           FROM information_schema.schemata s
           LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
          GROUP BY s.schema_name, s.default_character_set_name ORDER BY size_bytes DESC`,
      ),
      rows(conn, "SELECT id, user, host, db, command, time, state, LEFT(info, 300) AS info FROM information_schema.processlist ORDER BY time DESC"),
      rows(
        conn,
        `SHOW GLOBAL VARIABLES WHERE Variable_name IN ('version','version_comment','max_connections','wait_timeout','interactive_timeout',
         'innodb_buffer_pool_size','max_allowed_packet','read_only','sql_mode','character_set_server','collation_server','datadir','log_bin','slow_query_log','long_query_time')`,
      ),
      rows(conn, "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Max_used_connections','Questions','Slow_queries','Aborted_connects','Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests')"),
    ]);
    return { databases, processlist, variables: vars, status: st };
  });
}

export async function killProcess(c: Conn, id: number): Promise<void> {
  await withMy(c, async (conn) => {
    await conn.query("KILL ?", [id]);
  });
}

export async function readOnlyQuery(c: Conn, sql: string, database?: string): Promise<QueryResult> {
  const g = guardReadOnly(sql);
  if (!g.ok) throw new Error(g.reason);
  return withMy({ ...c, database: database ?? c.database }, async (conn) => {
    const t0 = Date.now();
    await conn.query("SET SESSION TRANSACTION READ ONLY");
    await conn.query(`SET SESSION max_execution_time = ${QUERY_TIMEOUT_MS}`).catch(() => undefined);
    await conn.query("START TRANSACTION READ ONLY");
    try {
      const [res, fields] = await conn.query({ sql: g.sql, rowsAsArray: true });
      const all = res as unknown[][];
      const columns = (fields ?? []).map((f) => f.name);
      const out = all.slice(0, MAX_ROWS).map((arr) => {
        const o: Row = {};
        columns.forEach((name, i) => (o[name] = arr[i]));
        return plainRow(o);
      });
      return { columns, rows: out, rowCount: all.length, durationMs: Date.now() - t0, truncated: all.length > MAX_ROWS };
    } finally {
      await conn.query("ROLLBACK").catch(() => undefined);
    }
  });
}
