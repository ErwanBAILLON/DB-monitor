import sql from "mssql";
import { guardReadOnly } from "@/lib/sqlguard";
import { MAX_ROWS, PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS, errorMessage, plainRow, withTimeout, type Conn, type Probe, type QueryResult, type Row } from "./types";

// Microsoft SQL Server through the tedious driver (package mssql).
// Tested against mcr.microsoft.com/mssql/server:2022-latest (tests/integration/mssql.test.ts).

function configOf(c: Conn, database?: string, requestTimeout = PROBE_TIMEOUT_MS): sql.config {
  return {
    server: c.host,
    port: c.port,
    user: c.username ?? "sa",
    password: c.password ?? "",
    database: database ?? c.database ?? "master",
    connectionTimeout: PROBE_TIMEOUT_MS,
    requestTimeout,
    pool: { max: 2, min: 0, idleTimeoutMillis: 1000 },
    options: { encrypt: c.tls, trustServerCertificate: true, appName: "db-monitor", readOnlyIntent: false },
  };
}

export async function withMs<T>(c: Conn, fn: (pool: sql.ConnectionPool) => Promise<T>, database?: string, requestTimeout?: number): Promise<T> {
  const pool = new sql.ConnectionPool(configOf(c, database, requestTimeout));
  pool.on("error", () => undefined);
  await pool.connect();
  try {
    return await fn(pool);
  } finally {
    await pool.close().catch(() => undefined);
  }
}

async function rows(pool: sql.ConnectionPool, text: string): Promise<Row[]> {
  const r = await pool.request().query(text);
  return (r.recordset as Row[]).map(plainRow);
}

// "Microsoft SQL Server 2022 (RTM-CU15) (KB5041321) - 16.0.4145.4 (X64) ..." -> "2022 16.0.4145.4"
export function shortVersion(v: string): string {
  const year = v.match(/SQL Server (\d{4})/)?.[1];
  const build = v.match(/- (\d+\.\d+\.\d+\.\d+)/)?.[1];
  return [year, build].filter(Boolean).join(" ") || v.split("\n")[0].slice(0, 60);
}

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      withMs(c, async (pool) => {
        await pool.request().query("SELECT 1");
        const latencyMs = Date.now() - t0;
        const r = await rows(
          pool,
          `SELECT @@VERSION AS version,
                  DATEDIFF(second, sqlserver_start_time, SYSDATETIME()) AS uptime,
                  (SELECT COUNT(*) FROM sys.dm_exec_connections) AS conn_used,
                  (SELECT CAST(value_in_use AS int) FROM sys.configurations WHERE name = 'user connections') AS conn_max,
                  @@MAX_CONNECTIONS AS hard_max,
                  (SELECT SUM(CAST(size AS bigint)) * 8 * 1024 FROM sys.master_files) AS size_bytes,
                  CASE WHEN SERVERPROPERTY('IsHadrEnabled') = 1 THEN 'hadr' ELSE 'standalone' END AS role
             FROM sys.dm_os_sys_info`,
        );
        const row = r[0] ?? {};
        return {
          up: true,
          latencyMs,
          version: shortVersion(String(row.version)),
          uptimeSec: Number(row.uptime),
          connUsed: Number(row.conn_used),
          connMax: Number(row.conn_max) > 0 ? Number(row.conn_max) : Number(row.hard_max),
          sizeBytes: BigInt(String(row.size_bytes ?? 0)),
          role: String(row.role),
        } satisfies Probe;
      }),
      PROBE_TIMEOUT_MS + 1000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

export type MsDetail = { databases: Row[]; sessions: Row[]; requests: Row[]; blocking: Row[]; waits: Row[]; config: Row[]; logins: Row[] };

export async function detail(c: Conn): Promise<MsDetail> {
  return withMs(c, async (pool) => {
    const [databases, sessions, requests, blocking, waits, config, logins] = await Promise.all([
      rows(
        pool,
        `SELECT d.name, d.database_id AS id, d.state_desc AS state, d.recovery_model_desc AS recovery, d.compatibility_level AS compat, d.collation_name AS collation,
                SUM(CASE WHEN f.type = 0 THEN CAST(f.size AS bigint) ELSE 0 END) * 8 * 1024 AS data_bytes,
                SUM(CASE WHEN f.type = 1 THEN CAST(f.size AS bigint) ELSE 0 END) * 8 * 1024 AS log_bytes,
                SUM(CAST(f.size AS bigint)) * 8 * 1024 AS size_bytes,
                SUSER_SNAME(d.owner_sid) AS owner, d.is_read_only AS read_only
           FROM sys.databases d JOIN sys.master_files f ON f.database_id = d.database_id
          GROUP BY d.name, d.database_id, d.state_desc, d.recovery_model_desc, d.compatibility_level, d.collation_name, d.owner_sid, d.is_read_only
          ORDER BY size_bytes DESC`,
      ),
      rows(
        pool,
        `SELECT s.session_id, s.login_name AS [login], s.host_name AS host, s.program_name AS program, DB_NAME(s.database_id) AS [database], s.status,
                s.cpu_time AS cpu_ms, s.memory_usage * 8 AS memory_kb, s.reads, s.writes, s.logical_reads, s.last_request_start_time, s.is_user_process AS user_process
           FROM sys.dm_exec_sessions s WHERE s.session_id <> @@SPID AND s.is_user_process = 1 ORDER BY s.status, s.last_request_start_time DESC`,
      ),
      rows(
        pool,
        `SELECT r.session_id, r.status, r.command, DB_NAME(r.database_id) AS [database], r.wait_type, r.wait_time AS wait_ms, r.blocking_session_id, r.cpu_time AS cpu_ms,
                r.total_elapsed_time AS elapsed_ms, r.percent_complete, LEFT(t.text, 300) AS query
           FROM sys.dm_exec_requests r OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
          WHERE r.session_id <> @@SPID AND r.session_id > 50 ORDER BY r.total_elapsed_time DESC`,
      ),
      rows(
        pool,
        `SELECT r.session_id AS blocked, r.blocking_session_id AS blocker, r.wait_type, r.wait_time AS wait_ms, r.wait_resource, LEFT(t.text, 200) AS blocked_query
           FROM sys.dm_exec_requests r OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t WHERE r.blocking_session_id <> 0 ORDER BY r.wait_time DESC`,
      ),
      rows(pool, `SELECT TOP 15 wait_type, waiting_tasks_count, wait_time_ms, signal_wait_time_ms FROM sys.dm_os_wait_stats WHERE wait_type NOT LIKE '%SLEEP%' AND wait_type NOT IN ('BROKER_TASK_STOP','BROKER_TO_FLUSH','CHECKPOINT_QUEUE','CLR_AUTO_EVENT','CLR_MANUAL_EVENT','DIRTY_PAGE_POLL','DISPATCHER_QUEUE_SEMAPHORE','FT_IFTS_SCHEDULER_IDLE_WAIT','HADR_FILESTREAM_IOMGR_IOCOMPLETION','LOGMGR_QUEUE','ONDEMAND_TASK_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH','SP_SERVER_DIAGNOSTICS_SLEEP','SQLTRACE_BUFFER_FLUSH','SQLTRACE_INCREMENTAL_FLUSH_SLEEP','WAITFOR','XE_DISPATCHER_WAIT','XE_TIMER_EVENT','QDS_PERSIST_TASK_MAIN_LOOP_SLEEP','QDS_ASYNC_QUEUE','PREEMPTIVE_XE_GETTARGETSTATE','PVS_PREALLOCATE','PWAIT_EXTENSIBILITY_CLEANUP_TASK','VDI_CLIENT_OTHER') ORDER BY wait_time_ms DESC`),
      rows(pool, `SELECT name, CAST(value AS bigint) AS value, CAST(value_in_use AS bigint) AS in_use, LEFT(description, 100) AS description FROM sys.configurations WHERE name IN ('user connections','max server memory (MB)','min server memory (MB)','max degree of parallelism','cost threshold for parallelism','remote query timeout (s)','optimize for ad hoc workloads','backup compression default','clr enabled','xp_cmdshell','Ad Hoc Distributed Queries') ORDER BY name`),
      rows(pool, `SELECT name, type_desc AS type, is_disabled AS disabled, create_date, default_database_name AS default_db FROM sys.server_principals WHERE type IN ('S','U','G') AND name NOT LIKE '##%' ORDER BY name`),
    ]);
    return { databases, sessions, requests, blocking, waits, config, logins };
  });
}

export async function killSession(c: Conn, sessionId: number): Promise<void> {
  if (!Number.isInteger(sessionId) || sessionId <= 50) throw new Error("session_id invalide (sessions utilisateur > 50).");
  await withMs(c, async (pool) => {
    await pool.request().query(`KILL ${sessionId}`);
  });
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export function assertIdent(s: string, what: string): string {
  if (!IDENT.test(s)) throw new Error(`${what} invalide : lettres, chiffres et _ (max 64), commençant par une lettre.`);
  return s;
}
const lit = (s: string) => `N'${s.replace(/'/g, "''")}'`;

// CREATE DATABASE + optional SQL login mapped to a db_owner user of that database.
export async function createDatabase(c: Conn, name: string, login: string | undefined, password: string | undefined): Promise<void> {
  assertIdent(name, "Nom de base");
  await withMs(
    c,
    async (pool) => {
      await pool.request().query(`CREATE DATABASE [${name}]`);
      if (login) {
        assertIdent(login, "Nom de login");
        if (!password) throw new Error("Mot de passe requis pour un nouveau login.");
        await pool.request().query(`CREATE LOGIN [${login}] WITH PASSWORD = ${lit(password)}, DEFAULT_DATABASE = [${name}], CHECK_POLICY = OFF`);
        await pool.request().query(`USE [${name}]; CREATE USER [${login}] FOR LOGIN [${login}]; ALTER ROLE db_owner ADD MEMBER [${login}]`);
      }
    },
    undefined,
    30_000,
  );
}

// Read-only console. SQL Server has no READ ONLY transaction: the guard is the only
// write barrier here (plus a db_datareader-only login if the operator registers one,
// see docs/engines.md). SNAPSHOT/READ COMMITTED isolation + requestTimeout bound it.
export async function readOnlyQuery(c: Conn, text: string, database?: string): Promise<QueryResult> {
  const g = guardReadOnly(text, { allowFirst: ["exec"] });
  if (!g.ok) throw new Error(g.reason);
  if (/^\s*exec/i.test(g.sql) && !/^\s*exec(ute)?\s+sp_(help|who2?|spaceused|columns|tables|databases|configure|lock|monitor|readerrorlog)\b/i.test(g.sql)) throw new Error("EXEC n'est permis que pour sp_help*, sp_who, sp_spaceused, sp_columns, sp_tables, sp_databases, sp_configure, sp_lock, sp_monitor.");
  if (/\b(openrowset|opendatasource|openquery|xp_\w+|bulk\s+insert|writetext|updatetext)\b/i.test(g.sql)) throw new Error("Fonction interdite (OPENROWSET / xp_* / BULK).");
  return withMs(
    c,
    async (pool) => {
      const t0 = Date.now();
      const req = pool.request();
      req.arrayRowMode = true;
      const r = await req.query(`SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SET LOCK_TIMEOUT ${QUERY_TIMEOUT_MS}; ${g.sql}`);
      const recordset = r.recordset as unknown as (unknown[][] & { columns?: Record<string, { name: string }> }) | undefined;
      const columns = recordset ? Object.values(recordset.columns ?? {}).map((col) => col.name) : [];
      const all = recordset ?? [];
      const out = all.slice(0, MAX_ROWS).map((arr) => {
        const o: Row = {};
        columns.forEach((name, i) => (o[name || `col${i + 1}`] = arr[i]));
        return plainRow(o);
      });
      return { columns: columns.map((n, i) => n || `col${i + 1}`), rows: out, rowCount: all.length, durationMs: Date.now() - t0, truncated: all.length > MAX_ROWS };
    },
    database,
    QUERY_TIMEOUT_MS,
  );
}
