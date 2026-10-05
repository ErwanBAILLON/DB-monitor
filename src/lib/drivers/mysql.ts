import mysql from "mysql2/promise";
import { guardReadOnly } from "@/lib/sqlguard";
import { PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS, errorMessage, plainRow, tabulate, withTimeout, type Conn, type Probe, type QueryResult, type Row } from "./types";

// Tested against mariadb:11.4 and mysql:8.4 (tests/integration/mysql.test.ts).
// mysql2 negotiates both caching_sha2_password (MySQL 8 default) and
// mysql_native_password (MariaDB default).

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

// SHOW ... WHERE Variable_name IN (...) -> { name: value }
export function kv(r: Row[]): Record<string, string> {
  return Object.fromEntries(r.map((x) => [String(x.Variable_name), String(x.Value)]));
}
const status = async (conn: mysql.Connection, names: string[]) => kv(await rows(conn, `SHOW GLOBAL STATUS WHERE Variable_name IN (${names.map(() => "?").join(",")})`, names));
const variables = async (conn: mysql.Connection, names: string[]) => kv(await rows(conn, `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${names.map(() => "?").join(",")})`, names));

// "11.4.3-MariaDB-ubu2404" -> mariadb, "8.4.3" -> mysql
export function flavourOf(version: string, comment = ""): "mariadb" | "mysql" {
  return /mariadb/i.test(version) || /mariadb/i.test(comment) ? "mariadb" : "mysql";
}

// Replication status rows (SHOW REPLICA STATUS / SHOW SLAVE STATUS) -> compact summary.
export function replicationSummary(r: Row | undefined): Row | null {
  if (!r) return null;
  const pick = (...keys: string[]) => keys.map((k) => r[k]).find((v) => v !== undefined && v !== null);
  return {
    source_host: pick("Source_Host", "Master_Host"),
    io_running: pick("Replica_IO_Running", "Slave_IO_Running"),
    sql_running: pick("Replica_SQL_Running", "Slave_SQL_Running"),
    seconds_behind: pick("Seconds_Behind_Source", "Seconds_Behind_Master"),
    last_error: pick("Last_Error"),
  };
}

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      withMy(c, async (conn) => {
        await conn.query("SELECT 1");
        const latencyMs = Date.now() - t0;
        const s = await status(conn, ["Uptime", "Threads_connected"]);
        const v = await variables(conn, ["version", "version_comment", "max_connections", "read_only"]);
        const size = await rows(conn, "SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes FROM information_schema.tables");
        return {
          up: true,
          latencyMs,
          version: v.version,
          uptimeSec: Number(s.Uptime),
          connUsed: Number(s.Threads_connected),
          connMax: Number(v.max_connections),
          sizeBytes: BigInt(String(size[0]?.bytes ?? 0).split(".")[0]),
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

export type MyDetail = { flavour: "mariadb" | "mysql"; databases: Row[]; processlist: Row[]; variables: Row[]; status: Row[]; replication: Row | null; users: Row[] };

export async function detail(c: Conn): Promise<MyDetail> {
  return withMy(c, async (conn) => {
    const v = await variables(conn, ["version", "version_comment"]);
    const flavour = flavourOf(v.version ?? "", v.version_comment);
    const [databases, processlist, vars, st, users] = await Promise.all([
      rows(
        conn,
        `SELECT s.schema_name AS name, s.default_character_set_name AS charset, s.default_collation_name AS collation,
                COALESCE(SUM(t.data_length + t.index_length), 0) AS size_bytes, COUNT(t.table_name) AS tables
           FROM information_schema.schemata s
           LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
          GROUP BY s.schema_name, s.default_character_set_name, s.default_collation_name ORDER BY size_bytes DESC`,
      ),
      rows(conn, "SELECT id, user, host, db, command, time, state, LEFT(info, 300) AS info FROM information_schema.processlist WHERE id <> CONNECTION_ID() ORDER BY time DESC"),
      rows(
        conn,
        `SHOW GLOBAL VARIABLES WHERE Variable_name IN ('version','version_comment','max_connections','wait_timeout','interactive_timeout',
         'innodb_buffer_pool_size','max_allowed_packet','read_only','sql_mode','character_set_server','collation_server','datadir','log_bin','slow_query_log','long_query_time','max_execution_time','max_statement_time')`,
      ),
      rows(conn, "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Max_used_connections','Questions','Queries','Slow_queries','Aborted_connects','Connections','Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests','Bytes_received','Bytes_sent')"),
      // MariaDB's mysql.user view has no account_locked column; degrade to user/host.
      rows(conn, "SELECT user AS user, host AS host, account_locked, max_user_connections FROM mysql.user ORDER BY user, host").catch(() => rows(conn, "SELECT user AS user, host AS host, max_user_connections FROM mysql.user ORDER BY user, host").catch(() => [] as Row[])),
    ]);
    const replRows = await rows(conn, flavour === "mariadb" ? "SHOW ALL SLAVES STATUS" : "SHOW REPLICA STATUS").catch(() => rows(conn, "SHOW SLAVE STATUS").catch(() => [] as Row[]));
    return { flavour, databases, processlist, variables: vars, status: st, replication: replicationSummary(replRows[0]), users };
  });
}

export async function killProcess(c: Conn, id: number): Promise<void> {
  await withMy(c, async (conn) => {
    await conn.query("KILL ?", [id]);
  });
}

const IDENT = /^[a-z_][a-z0-9_]{0,63}$/;
export function assertIdent(s: string, what: string): string {
  if (!IDENT.test(s)) throw new Error(`${what} invalide : lettres minuscules, chiffres et _ (max 64), commençant par une lettre.`);
  return s;
}
const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

// CREATE DATABASE + optional dedicated user (ALL PRIVILEGES on that database only).
export async function createDatabase(c: Conn, name: string, user: string | undefined, password: string | undefined): Promise<void> {
  assertIdent(name, "Nom de base");
  await withMy(c, async (conn) => {
    await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
    if (user) {
      assertIdent(user, "Nom d'utilisateur");
      if (!password) throw new Error("Mot de passe requis pour un nouvel utilisateur.");
      await conn.query(`CREATE USER \`${user}\`@'%' IDENTIFIED BY ${lit(password)}`);
      await conn.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO \`${user}\`@'%'`);
    }
  });
}

// Read-only query: guard + READ ONLY transaction + max_execution_time (MySQL) /
// max_statement_time (MariaDB) + row cap.
export async function readOnlyQuery(c: Conn, sql: string, database?: string): Promise<QueryResult> {
  const g = guardReadOnly(sql);
  if (!g.ok) throw new Error(g.reason);
  return readOnlyExec(c, database, async (conn) => {
    const t0 = Date.now();
    const [res, fields] = await conn.query({ sql: g.sql, rowsAsArray: true });
    const columns = (fields ?? []).map((f) => f.name);
    return tabulate(columns, res as unknown[][], t0);
  });
}

// Read-only execution path shared by the console and the explorer: READ ONLY session
// + transaction, statement timeout, always rolled back. `fn` may run several
// parametrised statements.
export async function readOnlyExec<T>(c: Conn, database: string | undefined, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  return withMy({ ...c, database: database ?? c.database }, async (conn) => {
    await conn.query("SET SESSION TRANSACTION READ ONLY");
    // MySQL: ms; MariaDB: seconds (max_statement_time). One of the two exists.
    await conn.query(`SET SESSION max_execution_time = ${QUERY_TIMEOUT_MS}`).catch(() => conn.query(`SET SESSION max_statement_time = ${QUERY_TIMEOUT_MS / 1000}`).catch(() => undefined));
    await conn.query("START TRANSACTION READ ONLY");
    try {
      return await fn(conn);
    } finally {
      await conn.query("ROLLBACK").catch(() => undefined);
    }
  });
}

// mysqldump/mariadb-dump arguments for the dump route (binary from mariadb-client).
export function dumpSpec(c: Conn, database: string): { args: string[]; env: Record<string, string> } {
  assertIdent(database, "Nom de base");
  return {
    args: ["--single-transaction", "--skip-lock-tables", "--routines", "--triggers", "-h", c.host, "-P", String(c.port), "-u", c.username ?? "root", ...(c.tls ? ["--ssl"] : []), database],
    env: { MYSQL_PWD: c.password ?? "" },
  };
}
