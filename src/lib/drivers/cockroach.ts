import { withPg, readOnlyQuery as pgReadOnlyQuery, assertIdent } from "./postgres";
import { PROBE_TIMEOUT_MS, errorMessage, plainRow, withTimeout, type Conn, type Probe, type QueryResult, type Row } from "./types";

// CockroachDB over the Postgres wire protocol (pg driver), introspection through
// crdb_internal instead of pg_stat_*. Tested against cockroachdb/cockroach:v24.2
// single node --insecure (tests/integration/cockroach.test.ts).

const n = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
export const isCockroachVersion = (v: string) => /cockroachdb/i.test(v);
// "CockroachDB CCL v24.2.3 (x86_64-pc-linux-gnu, ...)" -> "24.2.3"
export const shortVersion = (v: string) => v.match(/v(\d+\.\d+\.\d+[^\s)]*)/)?.[1] ?? v;

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      withPg(c, async (client) => {
        const latencyMs = Date.now() - t0;
        const r = await client.query(`
          SELECT version() AS version,
                 (SELECT extract(epoch from now() - started_at)::int FROM crdb_internal.kv_node_status ORDER BY node_id LIMIT 1) AS uptime,
                 (SELECT count(*) FROM crdb_internal.cluster_sessions) AS conn_used,
                 (SELECT sum(range_size)::int8 FROM crdb_internal.ranges) AS size_bytes,
                 (SELECT count(*) FROM crdb_internal.gossip_nodes WHERE is_live) AS live_nodes,
                 (SELECT count(*) FROM crdb_internal.gossip_nodes) AS nodes`);
        const row = r.rows[0];
        let connMax: number | undefined;
        try {
          const m = await client.query("SHOW CLUSTER SETTING server.max_connections_per_gateway");
          const v = Number(Object.values(m.rows[0] ?? {})[0]);
          connMax = v > 0 ? v : undefined;
        } catch {
          // setting absent on older versions
        }
        return {
          up: true,
          latencyMs,
          version: shortVersion(String(row.version)),
          uptimeSec: n(row.uptime),
          connUsed: n(row.conn_used),
          connMax,
          sizeBytes: row.size_bytes === null ? undefined : BigInt(row.size_bytes),
          role: `${row.live_nodes}/${row.nodes} nœuds`,
        } satisfies Probe;
      }),
      PROBE_TIMEOUT_MS + 1000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

export type CrdbDetail = { databases: Row[]; sessions: Row[]; roles: Row[]; nodes: Row[]; settings: Row[]; jobs: Row[] };

export async function detail(c: Conn): Promise<CrdbDetail> {
  return withPg(c, async (client) => {
    const q = async (sql: string) => (await client.query(sql)).rows.map(plainRow);
    const [dbList, sessions, roles, nodes, settings, jobs] = await Promise.all([
      q(`SELECT d.database_name AS name, d.owner,
                (SELECT count(*) FROM crdb_internal.tables t WHERE t.database_name = d.database_name AND t.state = 'PUBLIC') AS tables
           FROM [SHOW DATABASES] d ORDER BY d.database_name`),
      q(`SELECT session_id, node_id, user_name AS "user", client_address AS client, application_name AS app, status,
                extract(epoch from now() - session_start)::int AS age_s,
                active_query_start, left(active_queries, 300) AS active_queries, left(last_active_query, 200) AS last_query
           FROM crdb_internal.cluster_sessions WHERE session_id <> (SELECT session_id FROM [SHOW session_id]) ORDER BY status = 'ACTIVE' DESC, session_start`),
      q(`SELECT username AS name, options, member_of FROM [SHOW ROLES] ORDER BY username`),
      q(`SELECT node_id, address, sql_address, is_live, started_at, build_tag AS version, locality, ranges, leases FROM crdb_internal.gossip_nodes ORDER BY node_id`),
      q(`SELECT variable AS name, value, setting_type AS type, left(description, 120) AS description FROM [SHOW CLUSTER SETTINGS]
          WHERE variable IN ('server.max_connections_per_gateway','sql.defaults.statement_timeout','sql.defaults.idle_in_session_timeout','kv.range_split.by_load.enabled',
                             'kv.rangefeed.enabled','server.time_until_store_dead','sql.stats.automatic_collection.enabled','cluster.organization','enterprise.license','version')
          ORDER BY variable`),
      q(`SELECT job_id, job_type, status, left(description, 120) AS description, created, round(fraction_completed * 100) AS finished_percent FROM [SHOW JOBS] ORDER BY created DESC LIMIT 30`),
    ]);
    // Per-database size: SHOW RANGES ... WITH DETAILS (range_size_mb), one query per database (few of them).
    const databases: Row[] = [];
    for (const d of dbList.slice(0, 30)) {
      const name = String(d.name);
      let size_bytes: string | null = null;
      let ranges: string | null = null;
      try {
        const r = await client.query(`SELECT coalesce(sum(range_size_mb), 0) * 1048576 AS bytes, count(*) AS ranges FROM [SHOW RANGES FROM DATABASE "${name.replace(/"/g, '""')}" WITH DETAILS]`);
        size_bytes = String(Math.round(Number(r.rows[0]?.bytes ?? 0)));
        ranges = String(r.rows[0]?.ranges ?? 0);
      } catch {
        // SHOW RANGES needs the ZONECONFIG/admin privilege; sizes stay unknown then.
      }
      databases.push({ ...d, size_bytes, ranges });
    }
    databases.sort((a, b) => Number(b.size_bytes ?? 0) - Number(a.size_bytes ?? 0));
    return { databases, sessions, roles, nodes, settings, jobs };
  });
}

// Tables of one database with estimated rows and range size (SHOW RANGES ... WITH TABLES, DETAILS).
export async function tables(c: Conn, database: string): Promise<Row[]> {
  assertIdent(database, "Nom de base");
  return withPg(
    c,
    async (client) => {
      const t = await client.query(`SELECT schema_name AS schema, table_name AS "table", type, estimated_row_count AS est_rows, owner FROM [SHOW TABLES FROM "${database}"] ORDER BY table_name LIMIT 100`);
      const sizes = new Map<string, { bytes: number; ranges: number }>();
      try {
        const r = await client.query(`SELECT schema_name, table_name, sum(range_size_mb) * 1048576 AS bytes, count(*) AS ranges FROM [SHOW RANGES FROM DATABASE "${database}" WITH TABLES, DETAILS] GROUP BY 1, 2`);
        for (const row of r.rows) sizes.set(`${row.schema_name}.${row.table_name}`, { bytes: Math.round(Number(row.bytes)), ranges: Number(row.ranges) });
      } catch {
        // privilege missing: sizes unknown
      }
      return t.rows
        .map((row) => {
          const s = sizes.get(`${row.schema}.${row.table}`);
          return plainRow({ ...row, size_bytes: s?.bytes ?? null, ranges: s?.ranges ?? null });
        })
        .sort((a, b) => Number(b.size_bytes ?? 0) - Number(a.size_bytes ?? 0))
        .slice(0, 50);
    },
    database,
  );
}

const SESSION_ID = /^[0-9a-f]{32}$/i;
export async function cancelSession(c: Conn, sessionId: string): Promise<void> {
  if (!SESSION_ID.test(sessionId)) throw new Error("session_id invalide.");
  await withPg(c, async (client) => {
    await client.query(`CANCEL SESSION '${sessionId}'`);
  });
}

export async function createDatabase(c: Conn, name: string, owner: string | undefined): Promise<void> {
  assertIdent(name, "Nom de base");
  await withPg(c, async (client) => {
    await client.query(`CREATE DATABASE "${name}"`);
    if (owner) {
      assertIdent(owner, "Nom de rôle");
      await client.query(`ALTER DATABASE "${name}" OWNER TO "${owner}"`);
    }
  });
}

// Password is ignored by an --insecure node, hence optional.
export async function createRole(c: Conn, name: string, password: string | undefined): Promise<void> {
  assertIdent(name, "Nom de rôle");
  await withPg(c, async (client) => {
    await client.query(`CREATE ROLE "${name}" LOGIN${password ? ` PASSWORD '${password.replace(/'/g, "''")}'` : ""}`);
  });
}

// Same guard and READ ONLY transaction as Postgres (CockroachDB supports both).
export const readOnlyQuery = (c: Conn, sql: string, database?: string): Promise<QueryResult> => pgReadOnlyQuery(c, sql, database);
