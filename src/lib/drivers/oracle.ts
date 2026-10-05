import oracledb, { type Connection } from "oracledb";
import { guardReadOnly } from "@/lib/sqlguard";
import { MAX_ROWS, PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS, errorMessage, plainRow, withTimeout, type Conn, type Probe, type QueryResult, type Row } from "./types";

// Oracle Database (Free 23ai and up) in node-oracledb *thin* mode: pure JS, no Instant Client.
// Tested against gvenzl/oracle-free:23-slim (tests/integration/oracle.test.ts).

oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB];
oracledb.fetchAsBuffer = [oracledb.BLOB];

export const DEFAULT_SERVICE = "FREEPDB1";

export async function withConnection<T>(c: Conn, fn: (conn: Connection) => Promise<T>, callTimeoutMs = PROBE_TIMEOUT_MS): Promise<T> {
  const connectString = `${c.tls ? "tcps" : "tcp"}://${c.host}:${c.port}/${c.database || DEFAULT_SERVICE}${c.tls ? "?ssl_server_dn_match=false" : ""}`;
  const conn = await withTimeout(oracledb.getConnection({ user: c.username ?? "", password: c.password ?? "", connectString, connectTimeout: Math.ceil(PROBE_TIMEOUT_MS / 1000) }), PROBE_TIMEOUT_MS + 1000, "connect");
  conn.callTimeout = callTimeoutMs;
  try {
    return await fn(conn);
  } finally {
    await conn.close().catch(() => undefined);
  }
}

export async function rows(conn: Connection, sql: string, binds: oracledb.BindParameters = {}, maxRows = 1000): Promise<Row[]> {
  const r = await conn.execute<Row>(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows });
  return (r.rows ?? []).map((x) => plainRow(lowerKeys(x)));
}

export function lowerKeys(r: Row): Row {
  const o: Row = {};
  for (const [k, v] of Object.entries(r)) o[k.toLowerCase()] = v;
  return o;
}

// Pure: v$instance + v$database + session count + v$resource_limit + size -> probe (unit-tested on fixtures).
export function fromInstance(inst: Row, db: Row, sessions: number, limit: Row | undefined, sizeBytes: bigint | undefined): Omit<Probe, "up" | "latencyMs"> {
  const max = Number(limit?.limit_value);
  return {
    version: String(inst.version_full ?? inst.version ?? "?"),
    uptimeSec: inst.uptime_sec === null || inst.uptime_sec === undefined ? undefined : Math.max(0, Math.round(Number(inst.uptime_sec))),
    connUsed: sessions,
    connMax: Number.isFinite(max) && max > 0 ? max : undefined,
    sizeBytes,
    role: `${String(db.database_role ?? "?").toLowerCase()} · ${String(db.open_mode ?? "?").toLowerCase()}${inst.status && inst.status !== "OPEN" ? ` · ${String(inst.status).toLowerCase()}` : ""}`,
  };
}

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      withConnection(c, async (conn) => {
        await conn.execute("SELECT 1 FROM dual");
        const latencyMs = Date.now() - t0;
        const [inst] = await rows(conn, "SELECT instance_name, host_name, version, version_full, status, database_status, (SYSDATE - startup_time) * 86400 AS uptime_sec FROM v$instance");
        const [db] = await rows(conn, "SELECT name, database_role, open_mode, cdb FROM v$database");
        const [cnt] = await rows(conn, "SELECT count(*) AS n FROM v$session WHERE type = 'USER'");
        // v$resource_limit is empty inside a PDB: fall back to the SESSIONS parameter.
        const [limit] = await rows(conn, "SELECT resource_name, current_utilization, max_utilization, limit_value FROM v$resource_limit WHERE resource_name = 'sessions' UNION ALL SELECT 'sessions', NULL, NULL, value FROM v$parameter WHERE name = 'sessions' AND NOT EXISTS (SELECT 1 FROM v$resource_limit WHERE resource_name = 'sessions')");
        const [size] = await rows(conn, "SELECT sum(bytes) AS bytes FROM dba_data_files");
        return { up: true, latencyMs, ...fromInstance(inst ?? {}, db ?? {}, Number(cnt?.n ?? 0), limit, size?.bytes ? BigInt(String(size.bytes)) : undefined) } satisfies Probe;
      }),
      PROBE_TIMEOUT_MS + 2000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

export type OracleDetail = { instance: Row; database: Row; tablespaces: Row[]; sessions: Row[]; longops: Row[]; limits: Row[]; parameters: Row[]; pdbs: Row[] };

export async function detail(c: Conn): Promise<OracleDetail> {
  return withConnection(
    c,
    async (conn) => {
      const [instance] = await rows(conn, "SELECT instance_name, host_name, version_full, status, database_status, instance_role, logins, archiver, startup_time, edition FROM v$instance");
      const [database] = await rows(conn, "SELECT name, db_unique_name, database_role, open_mode, log_mode, protection_mode, cdb, platform_name, created, flashback_on, force_logging FROM v$database");
      const tablespaces = await rows(
        conn,
        `SELECT m.tablespace_name, t.contents, t.status, t.bigfile,
                m.used_space * t.block_size AS used_bytes, m.tablespace_size * t.block_size AS max_bytes, round(m.used_percent, 1) AS used_pct,
                (SELECT sum(bytes) FROM dba_data_files f WHERE f.tablespace_name = m.tablespace_name) AS allocated_bytes
           FROM dba_tablespace_usage_metrics m JOIN dba_tablespaces t ON t.tablespace_name = m.tablespace_name
          ORDER BY used_pct DESC`,
      );
      const sessions = await rows(
        conn,
        `SELECT s.sid, s.serial# AS serial, s.username, s.status, s.type, s.osuser, s.machine, s.program, s.module, s.event, s.wait_class, s.seconds_in_wait, s.blocking_session, s.logon_time, s.sql_id, s.last_call_et,
                substr(q.sql_text, 1, 300) AS sql_text
           FROM v$session s LEFT JOIN v$sql q ON q.sql_id = s.sql_id AND q.child_number = 0
          WHERE s.type = 'USER' AND s.sid <> SYS_CONTEXT('USERENV', 'SID')
          ORDER BY s.status, s.last_call_et DESC`,
        {},
        500,
      );
      const longops = await rows(conn, "SELECT sid, serial# AS serial, username, opname, target, sofar, totalwork, units, round(sofar / nullif(totalwork, 0) * 100, 1) AS pct, elapsed_seconds, time_remaining, start_time, last_update_time, message FROM v$session_longops WHERE sofar < totalwork OR time_remaining > 0 ORDER BY start_time DESC", {}, 200);
      let limits = await rows(conn, "SELECT resource_name, current_utilization, max_utilization, initial_allocation, limit_value FROM v$resource_limit WHERE resource_name IN ('processes', 'sessions', 'transactions', 'enqueue_locks', 'parallel_max_servers', 'max_shared_servers') ORDER BY resource_name");
      if (limits.length === 0) limits = await rows(conn, "SELECT name AS resource_name, (SELECT count(*) FROM v$session) AS current_utilization, NULL AS max_utilization, NULL AS initial_allocation, value AS limit_value FROM v$parameter WHERE name IN ('processes', 'sessions') ORDER BY name");
      const parameters = await rows(conn, "SELECT name, value, isdefault, description FROM v$parameter WHERE name IN ('sga_target', 'sga_max_size', 'pga_aggregate_target', 'memory_target', 'processes', 'sessions', 'open_cursors', 'db_block_size', 'compatible', 'cpu_count', 'undo_retention', 'db_recovery_file_dest_size', 'service_names') ORDER BY name");
      const pdbs = await rows(conn, "SELECT con_id, name, open_mode, restricted, total_size, block_size, creation_time FROM v$pdbs ORDER BY con_id").catch(() => [] as Row[]);
      return { instance: instance ?? {}, database: database ?? {}, tablespaces, sessions, longops, limits, parameters, pdbs };
    },
    QUERY_TIMEOUT_MS * 2,
  );
}

// ALTER SYSTEM KILL SESSION 'sid,serial#' IMMEDIATE: needs the ALTER SYSTEM privilege.
export async function killSession(c: Conn, sid: number, serial: number): Promise<void> {
  if (!Number.isInteger(sid) || sid <= 0 || !Number.isInteger(serial) || serial < 0) throw new Error("sid / serial# invalides.");
  await withConnection(c, async (conn) => {
    const [me] = await rows(conn, "SELECT SYS_CONTEXT('USERENV', 'SID') AS sid FROM dual");
    if (Number(me?.sid) === sid) throw new Error("Refus de tuer la session de la console elle-même.");
    await conn.execute(`ALTER SYSTEM KILL SESSION '${sid},${serial}' IMMEDIATE`);
  });
}

// --- read-only console ----------------------------------------------------------

const ORACLE_FORBIDDEN = /\b(dbms_\w+|utl_\w+|owa_\w+|htp\.\w+|htf\.\w+|execute\s+immediate|httpuritype|dbms_xmlgen|sys\.kupp\w*|ctx_\w+|wwv_\w+|ords_\w+|apex_\w+|xmltype\s*\(\s*httpuritype|sqlplus|ora_hash_\w+|dbms_scheduler)\b/i;

export type OracleGuard = { ok: true; sql: string } | { ok: false; reason: string };

// The generic guard (single SELECT/WITH, DML/DDL keywords, FOR UPDATE, quoted-identifier calls)
// plus Oracle-specific: PL/SQL blocks (BEGIN/DECLARE are not an allowed first keyword), the
// DBMS_* / UTL_* packages (DBMS_LOCK.SLEEP, UTL_HTTP, UTL_FILE, DBMS_SCHEDULER...), EXECUTE
// IMMEDIATE, HTTPURITYPE. The statement then runs inside SET TRANSACTION READ ONLY.
export function guardOracle(input: string): OracleGuard {
  const raw = input.trim().replace(/;\s*$/, "").replace(/\n\/\s*$/, "");
  if (/^\s*(begin|declare|call|exec|execute)\b/i.test(raw)) return { ok: false, reason: "Bloc PL/SQL ou appel de procédure interdit : SELECT uniquement." };
  const g = guardReadOnly(raw);
  if (!g.ok) return g;
  const stripped = raw.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
  const hit = stripped.match(ORACLE_FORBIDDEN);
  if (hit) return { ok: false, reason: `Paquet ou construction interdit : ${hit[1].toUpperCase()}.` };
  // q'...' and the national nq'...' variant: the generic stripper cannot parse their delimiters,
  // so a q'[']' literal would misalign the quote stripping and hide a forbidden call.
  if (/(^|[^A-Za-z0-9_'])n?q'/i.test(raw)) return { ok: false, reason: "Littéraux q'...' / nq'...' interdits." };
  return { ok: true, sql: g.sql };
}

export async function readOnlyQuery(c: Conn, sql: string, service?: string): Promise<QueryResult> {
  const g = guardOracle(sql);
  if (!g.ok) throw new Error(g.reason);
  const svc = service ?? c.database ?? DEFAULT_SERVICE;
  if (!/^[\w.-]{1,64}$/.test(svc)) throw new Error("Service invalide.");
  const t0 = Date.now();
  return withConnection(
    { ...c, database: svc },
    async (conn) => {
      await conn.execute("SET TRANSACTION READ ONLY");
      try {
        const r = await conn.execute<unknown[]>(g.sql, {}, { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: MAX_ROWS + 1 });
        const columns = (r.metaData ?? []).map((m) => m.name.toLowerCase());
        const all = (r.rows ?? []) as unknown[][];
        const sliced = all.slice(0, MAX_ROWS);
        const out = sliced.map((arr) => {
          const o: Row = {};
          columns.forEach((name, i) => (o[name] = arr[i]));
          return plainRow(o);
        });
        return { columns, rows: out, rowCount: all.length > MAX_ROWS ? MAX_ROWS : all.length, durationMs: Date.now() - t0, truncated: all.length > MAX_ROWS };
      } finally {
        await conn.rollback().catch(() => undefined);
      }
    },
    QUERY_TIMEOUT_MS,
  );
}
