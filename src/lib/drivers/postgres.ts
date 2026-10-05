import { Client } from "pg";
import { guardReadOnly } from "@/lib/sqlguard";
import * as crdb from "./cockroach";
import { MAX_ROWS, PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS, errorMessage, plainRow, withTimeout, type Conn, type Probe, type QueryResult, type Row } from "./types";

// pg returns int8/numeric as strings; keep that (exact) and convert where we need numbers.

function clientFor(c: Conn, database?: string): Client {
  return new Client({
    host: c.host,
    port: c.port,
    user: c.username ?? "postgres",
    password: c.password ?? "",
    database: database ?? c.database ?? "postgres",
    ssl: c.tls ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
    // Client-side timeout: a server-side statement_timeout startup parameter is
    // rejected by PgBouncer ("unsupported startup parameter"), and the read-only
    // query path sets it per transaction anyway.
    query_timeout: QUERY_TIMEOUT_MS,
    application_name: "db-monitor",
  });
}

export async function withPg<T>(c: Conn, fn: (client: Client) => Promise<T>, database?: string): Promise<T> {
  const client = clientFor(c, database);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

const n = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));

export async function probe(c: Conn): Promise<Probe> {
  if (c.type === "cockroach") return crdb.probe(c);
  const t0 = Date.now();
  try {
    return await withTimeout(
      withPg(c, async (client) => {
        const latencyMs = Date.now() - t0;
        // A "postgres" instance that is really CockroachDB: delegate (no pg_postmaster_start_time there).
        const v = await client.query("SELECT version() AS v");
        if (crdb.isCockroachVersion(String(v.rows[0]?.v))) throw new CockroachDetected();
        const r = await client.query(`
          SELECT current_setting('server_version') AS version,
                 extract(epoch from now() - pg_postmaster_start_time())::bigint AS uptime,
                 (SELECT count(*) FROM pg_stat_activity) AS conn_used,
                 current_setting('max_connections')::int AS conn_max,
                 (SELECT sum(pg_database_size(oid)) FROM pg_database) AS size_bytes,
                 pg_is_in_recovery() AS in_recovery`);
        const row = r.rows[0];
        return {
          up: true,
          latencyMs,
          version: String(row.version),
          uptimeSec: n(row.uptime),
          connUsed: n(row.conn_used),
          connMax: n(row.conn_max),
          sizeBytes: row.size_bytes === null ? undefined : BigInt(row.size_bytes),
          role: row.in_recovery ? "replica" : "primary",
        } satisfies Probe;
      }),
      PROBE_TIMEOUT_MS + 1000,
      "probe",
    );
  } catch (err) {
    if (err instanceof CockroachDetected) return crdb.probe({ ...c, type: "cockroach" });
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}
class CockroachDetected extends Error {}

export type PgDetail = {
  databases: Row[];
  roles: Row[];
  sessions: Row[];
  longQueries: Row[];
  locks: Row[];
  topTables: Row[];
  settings: Row[];
  extensions: Row[];
};

export async function detail(c: Conn): Promise<PgDetail> {
  return withPg(c, async (client) => {
    const q = async (sql: string) => (await client.query(sql)).rows.map(plainRow);
    const [databases, roles, sessions, longQueries, locks, settings, extensions] = await Promise.all([
      q(`SELECT d.datname AS name, pg_get_userbyid(d.datdba) AS owner, pg_database_size(d.oid) AS size_bytes,
                pg_size_pretty(pg_database_size(d.oid)) AS size, d.encoding, pg_encoding_to_char(d.encoding) AS encoding_name,
                (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname) AS sessions,
                d.datallowconn AS allow_conn
           FROM pg_database d WHERE NOT d.datistemplate ORDER BY pg_database_size(d.oid) DESC`),
      q(`SELECT rolname AS name, rolsuper AS superuser, rolcreaterole AS create_role, rolcreatedb AS create_db,
                rolcanlogin AS login, rolreplication AS replication, rolconnlimit AS conn_limit,
                rolvaliduntil AS valid_until,
                ARRAY(SELECT b.rolname FROM pg_auth_members m JOIN pg_roles b ON m.roleid = b.oid WHERE m.member = r.oid) AS member_of
           FROM pg_roles r WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname`),
      q(`SELECT pid, usename AS "user", datname AS database, application_name AS app, client_addr::text AS client, state,
                wait_event_type AS wait_type, wait_event, backend_type,
                extract(epoch from now() - backend_start)::int AS backend_age_s,
                extract(epoch from now() - state_change)::int AS state_age_s,
                extract(epoch from now() - query_start)::int AS query_age_s,
                left(query, 300) AS query
           FROM pg_stat_activity WHERE pid <> pg_backend_pid() ORDER BY state = 'active' DESC, query_start NULLS LAST`),
      q(`SELECT pid, usename AS "user", datname AS database, state,
                extract(epoch from now() - query_start)::int AS duration_s, left(query, 400) AS query
           FROM pg_stat_activity
          WHERE state <> 'idle' AND pid <> pg_backend_pid() AND query_start < now() - interval '5 seconds'
            AND backend_type = 'client backend'
          ORDER BY query_start LIMIT 50`),
      q(`SELECT l.pid, l.locktype, l.mode, l.granted, l.relation::regclass::text AS relation, a.datname AS database,
                a.usename AS "user", left(a.query, 200) AS query
           FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE NOT l.granted OR l.mode LIKE '%Exclusive%'
          ORDER BY l.granted, l.pid LIMIT 100`),
      q(`SELECT name, setting, unit, short_desc, source
           FROM pg_settings
          WHERE name IN ('max_connections','superuser_reserved_connections','shared_buffers','work_mem','maintenance_work_mem',
                         'effective_cache_size','idle_in_transaction_session_timeout','idle_session_timeout','statement_timeout',
                         'lock_timeout','log_min_duration_statement','wal_level','max_wal_size','checkpoint_timeout',
                         'autovacuum','synchronous_commit','ssl','data_directory','listen_addresses','TimeZone')
          ORDER BY name`),
      q(`SELECT name, default_version, installed_version, left(comment, 120) AS comment
           FROM pg_available_extensions WHERE installed_version IS NOT NULL ORDER BY name`),
    ]);
    return { databases, roles, sessions, longQueries, locks, topTables: [], settings, extensions };
  });
}

// Top tables by size within one database (needs a separate connection: per-database catalogs).
export async function topTables(c: Conn, database: string): Promise<Row[]> {
  return withPg(
    c,
    async (client) =>
      (
        await client.query(`
          SELECT n.nspname AS schema, c.relname AS "table",
                 pg_total_relation_size(c.oid) AS total_bytes,
                 pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
                 pg_size_pretty(pg_relation_size(c.oid)) AS heap,
                 pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
                 c.reltuples::bigint AS est_rows,
                 s.n_dead_tup AS dead_rows,
                 CASE WHEN c.reltuples > 0 THEN round((100.0 * s.n_dead_tup / greatest(c.reltuples, 1))::numeric, 1) ELSE 0 END AS dead_pct,
                 s.last_autovacuum, s.last_analyze
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
           WHERE c.relkind IN ('r','m','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
           ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 30`)
      ).rows.map(plainRow),
    database,
  );
}

export async function terminateBackend(c: Conn, pid: number): Promise<boolean> {
  return withPg(c, async (client) => {
    const r = await client.query("SELECT pg_terminate_backend($1) AS ok", [pid]);
    return Boolean(r.rows[0]?.ok);
  });
}

// Read-only query: guard + READ ONLY transaction + statement_timeout + row cap.
export async function readOnlyQuery(c: Conn, sql: string, database?: string): Promise<QueryResult> {
  const g = guardReadOnly(sql);
  if (!g.ok) throw new Error(g.reason);
  return withPg(
    c,
    async (client) => {
      const t0 = Date.now();
      await client.query("BEGIN READ ONLY");
      try {
        await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
        const r = await client.query({ text: g.sql, rowMode: "array" });
        const rows = (r.rows as unknown[][]).slice(0, MAX_ROWS).map((arr) => {
          const o: Row = {};
          r.fields.forEach((f, i) => (o[f.name] = arr[i]));
          return plainRow(o);
        });
        return { columns: r.fields.map((f) => f.name), rows, rowCount: r.rowCount ?? rows.length, durationMs: Date.now() - t0, truncated: (r.rows?.length ?? 0) > MAX_ROWS };
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
      }
    },
    database,
  );
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
export function assertIdent(s: string, what: string): string {
  if (!IDENT.test(s)) throw new Error(`${what} invalide : lettres minuscules, chiffres et _ (max 63), commençant par une lettre.`);
  return s;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function createRole(c: Conn, name: string, password: string, opts: { login?: boolean; createdb?: boolean } = {}): Promise<void> {
  assertIdent(name, "Nom de rôle");
  await withPg(c, async (client) => {
    await client.query(`CREATE ROLE "${name}" ${opts.login === false ? "NOLOGIN" : "LOGIN"} ${opts.createdb ? "CREATEDB" : ""} PASSWORD ${lit(password)}`);
  });
}

// Creates the database and, when `withOwner`, a dedicated owner role with a fresh password.
export async function createDatabase(c: Conn, name: string, owner: string | undefined, ownerPassword: string | undefined): Promise<void> {
  assertIdent(name, "Nom de base");
  await withPg(c, async (client) => {
    if (owner) {
      assertIdent(owner, "Nom de rôle");
      const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [owner]);
      if (exists.rowCount === 0) {
        if (!ownerPassword) throw new Error("Mot de passe requis pour un nouveau rôle.");
        await client.query(`CREATE ROLE "${owner}" LOGIN PASSWORD ${lit(ownerPassword)}`);
      }
      // The creating role must be a member of the owner to hand over ownership (non-superuser).
      await client.query(`GRANT "${owner}" TO current_user`).catch(() => undefined);
    }
    await client.query(`CREATE DATABASE "${name}"${owner ? ` OWNER "${owner}"` : ""}`);
    await client.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
  });
}

// pg_dump arguments and environment for the dump route (binary from postgresql16-client).
export function dumpSpec(c: Conn, database: string): { args: string[]; env: Record<string, string> } {
  assertIdent(database, "Nom de base");
  return {
    args: ["--no-password", "--format=plain", "--no-owner", "--no-privileges", "-h", c.host, "-p", String(c.port), "-U", c.username ?? "postgres", database],
    env: { PGPASSWORD: c.password ?? "", PGSSLMODE: c.tls ? "require" : "prefer", PGCONNECT_TIMEOUT: "10" },
  };
}
