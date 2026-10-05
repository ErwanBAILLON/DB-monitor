import type mysql from "mysql2/promise";
import { readOnlyExec } from "@/lib/drivers/mysql";
import { plainRow, type Row } from "@/lib/drivers/types";
import { assertExploreIdent, composeBrowse, placeholderQuestion, quoteBacktick } from "./sql";
import { PROFILE_SAMPLE, truncateCell, type BrowseRequest, type BrowseResult, type ColumnProfile, type ExploreColumn, type ExploreConstraint, type ExploreContainer, type ExploreDescription, type ExploreIndex, type ExploreObject, type ExploreStats, type Explorer, type StatSection } from "./types";

// MySQL / MariaDB explorer. Containers = schemas (information_schema, performance_schema
// and sys hidden). Objects = tables and views of information_schema.tables. Every call runs
// inside readOnlyExec (SESSION TRANSACTION READ ONLY + max_execution_time /
// max_statement_time 5 s, rolled back). Values are passed as query parameters, escaped by
// mysql2 (the server has no bound placeholders in the text protocol).

const q = quoteBacktick;
const HIDDEN = ["information_schema", "performance_schema", "sys"];
const n = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

async function rows(conn: mysql.Connection, sql: string, params: unknown[] = []): Promise<Row[]> {
  const [r] = await conn.query(sql, params);
  return (r as Row[]).map((x) => plainRow(lower(x)));
}
// information_schema column names come back upper-case on MySQL, lower on MariaDB: normalise.
function lower(r: Row): Row {
  const o: Row = {};
  for (const [k, v] of Object.entries(r)) o[k.toLowerCase()] = v;
  return o;
}
const schemaOf = (s: string) => assertExploreIdent(s, "Schéma");
const tableOf = (s: string) => assertExploreIdent(s, "Table");

async function columnsOf(conn: mysql.Connection, schema: string, table: string): Promise<ExploreColumn[]> {
  const r = await rows(
    conn,
    `SELECT column_name, column_type, is_nullable, column_default, column_key, extra, collation_name, column_comment
       FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
    [schema, table],
  );
  if (!r.length) throw new Error(`Objet introuvable : ${schema}.${table}.`);
  return r.map((x) => {
    const extra: Record<string, unknown> = {};
    if (x.extra) extra.extra = x.extra;
    if (x.collation_name) extra.collation = x.collation_name;
    if (x.column_comment) extra.comment = x.column_comment;
    if (x.column_key === "MUL" || x.column_key === "UNI") extra.key = x.column_key;
    return { name: String(x.column_name), type: String(x.column_type), nullable: x.is_nullable === "YES", default: x.column_default === null || x.column_default === undefined ? null : String(x.column_default), pk: x.column_key === "PRI", ...(Object.keys(extra).length ? { extra } : {}) };
  });
}

export const explorer: Explorer = {
  caveats: ["Nombres de lignes : estimations d'information_schema (InnoDB) ; le total d'une page est un count(*) exact.", "Profil : échantillon des 10 000 premières lignes.", "Identifiants hors [A-Za-z0-9_$] non explorables."],

  async listContainers(c) {
    return readOnlyExec(c, undefined, async (conn) => {
      const r = await rows(
        conn,
        `SELECT s.schema_name AS name, s.default_character_set_name AS charset, s.default_collation_name AS collation,
                COALESCE(SUM(t.data_length + t.index_length), 0) AS size_bytes, COUNT(t.table_name) AS tables
           FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
          WHERE s.schema_name NOT IN (${HIDDEN.map(() => "?").join(",")})
          GROUP BY s.schema_name, s.default_character_set_name, s.default_collation_name ORDER BY s.schema_name`,
        HIDDEN,
      );
      return r.map((x): ExploreContainer => ({ name: String(x.name), kind: "schema", sizeBytes: n(x.size_bytes), objectCount: n(x.tables), extra: { charset: x.charset, collation: x.collation } }));
    });
  },

  async listObjects(c, container) {
    const schema = schemaOf(container);
    return readOnlyExec(c, undefined, async (conn) => {
      const r = await rows(conn, `SELECT table_name, table_type, engine, table_rows, data_length + index_length AS size_bytes, data_free, update_time, create_time FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`, [schema]);
      return r.map((x): ExploreObject => ({
        name: String(x.table_name),
        kind: /view/i.test(String(x.table_type)) ? "view" : "table",
        estRows: n(x.table_rows),
        sizeBytes: n(x.size_bytes),
        lastModified: iso(x.update_time ?? x.create_time),
        extra: { engine: x.engine ?? null, ...(n(x.data_free) ? { data_free: n(x.data_free) } : {}) },
      }));
    });
  },

  async describeObject(c, container, object) {
    const schema = schemaOf(container);
    const table = tableOf(object);
    return readOnlyExec(c, undefined, async (conn) => {
      const columns = await columnsOf(conn, schema, table);
      const st = await rows(conn, `SELECT index_name, non_unique, seq_in_index, column_name, index_type, cardinality, sub_part FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? ORDER BY index_name, seq_in_index`, [schema, table]);
      const byIndex = new Map<string, ExploreIndex>();
      for (const s of st) {
        const name = String(s.index_name);
        const ix = byIndex.get(name) ?? { name, columns: [], unique: String(s.non_unique) === "0", primary: name === "PRIMARY", extra: { method: s.index_type, cardinality: n(s.cardinality) } };
        ix.columns.push(String(s.column_name) + (s.sub_part ? `(${s.sub_part})` : ""));
        byIndex.set(name, ix);
      }
      const indexes = [...byIndex.values()].sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
      const tc = await rows(conn, `SELECT constraint_name, constraint_type FROM information_schema.table_constraints WHERE table_schema = ? AND table_name = ?`, [schema, table]);
      const kcu = await rows(conn, `SELECT constraint_name, column_name, referenced_table_schema, referenced_table_name, referenced_column_name FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? ORDER BY constraint_name, ordinal_position`, [schema, table]);
      const checks = await rows(conn, `SELECT constraint_name, check_clause FROM information_schema.check_constraints WHERE constraint_schema = ? AND table_name = ?`, [schema, table]).catch(() => rows(conn, `SELECT cc.constraint_name, cc.check_clause FROM information_schema.check_constraints cc JOIN information_schema.table_constraints tc ON tc.constraint_name = cc.constraint_name AND tc.constraint_schema = cc.constraint_schema WHERE cc.constraint_schema = ? AND tc.table_name = ? AND tc.constraint_type = 'CHECK'`, [schema, table]).catch(() => [] as Row[]));
      const KIND: Record<string, ExploreConstraint["kind"]> = { "PRIMARY KEY": "pk", "FOREIGN KEY": "fk", UNIQUE: "unique", CHECK: "check" };
      const constraints: ExploreConstraint[] = tc.map((t) => {
        const name = String(t.constraint_name);
        const cols = kcu.filter((k) => k.constraint_name === name);
        const kind = KIND[String(t.constraint_type)] ?? "other";
        const out: ExploreConstraint = { name, kind, columns: cols.map((k) => String(k.column_name)) };
        if (kind === "fk" && cols[0]?.referenced_table_name) {
          out.refObject = cols[0].referenced_table_schema && cols[0].referenced_table_schema !== schema ? `${cols[0].referenced_table_schema}.${cols[0].referenced_table_name}` : String(cols[0].referenced_table_name);
          out.refColumns = cols.map((k) => String(k.referenced_column_name));
        }
        if (kind === "check") out.definition = String(checks.find((k) => k.constraint_name === name)?.check_clause ?? "");
        return out;
      });
      const parts = await rows(conn, `SELECT partition_method, partition_expression, count(*) AS parts FROM information_schema.partitions WHERE table_schema = ? AND table_name = ? AND partition_name IS NOT NULL GROUP BY partition_method, partition_expression`, [schema, table]).catch(() => [] as Row[]);
      const partitioning = parts[0] ? { strategy: parts[0].partition_method, key: parts[0].partition_expression, partitions: n(parts[0].parts) } : null;
      const t = (await rows(conn, `SELECT table_type, engine, row_format, table_rows, avg_row_length, data_length, index_length, data_free, auto_increment, create_time, update_time, table_collation, table_comment FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`, [schema, table]))[0] ?? {};
      const data = n(t.data_length) ?? 0;
      const free = n(t.data_free) ?? 0;
      const storage: Record<string, unknown> = {
        moteur: t.engine ?? null,
        format_ligne: t.row_format ?? null,
        taille_donnees: n(t.data_length),
        taille_index: n(t.index_length),
        espace_libre: n(t.data_free),
        fragmentation_pct: data + free > 0 ? Math.round((1000 * free) / (data + free)) / 10 : 0,
        lignes_estimees: n(t.table_rows),
        taille_ligne_moy: n(t.avg_row_length),
        auto_increment: n(t.auto_increment),
        collation: t.table_collation ?? null,
        cree_le: iso(t.create_time),
        modifie_le: iso(t.update_time),
        ...(t.table_comment ? { commentaire: t.table_comment } : {}),
      };
      let sample: Row | null = null;
      const [sr] = await conn.query(`SELECT ${columns.map((x) => q(x.name)).join(", ")} FROM ${q(schema)}.${q(table)} LIMIT 1`).catch(() => [[] as Row[]]);
      if ((sr as Row[])[0]) sample = truncRow(plainRow((sr as Row[])[0]));
      const kind = /view/i.test(String(t.table_type)) ? "view" : "table";
      return { object: { name: table, kind, estRows: n(t.table_rows), sizeBytes: data + (n(t.index_length) ?? 0) }, columns, indexes, constraints, partitioning, storage, sample, notes: ["Tailles en octets ; lignes_estimees et cardinalités viennent d'information_schema (InnoDB : approximatif, modifie_le souvent NULL)."] } satisfies ExploreDescription;
    });
  },

  async browseRows(c, container, object, req) {
    const schema = schemaOf(container);
    const table = tableOf(object);
    return readOnlyExec(c, undefined, async (conn) => browse(conn, schema, table, req));
  },

  async columnProfile(c, container, object, column) {
    const schema = schemaOf(container);
    const table = tableOf(object);
    return readOnlyExec(c, undefined, async (conn) => {
      const cols = await columnsOf(conn, schema, table);
      const col = cols.find((x) => x.name === assertExploreIdent(column, "Colonne"));
      if (!col) throw new Error(`Colonne inconnue : ${column}.`);
      // Without ORDER BY the optimizer may scan a covering secondary index, which sorts the
      // sample by that column: order by the primary key (cheap) when there is one.
      const pk = cols.filter((x) => x.pk).map((x) => q(x.name));
      const from = `(SELECT ${q(col.name)} AS v FROM ${q(schema)}.${q(table)}${pk.length ? ` ORDER BY ${pk.join(", ")}` : ""} LIMIT ?) s`;
      const [a] = (await rows(conn, `SELECT count(*) AS n, count(v) AS nn, count(DISTINCT v) AS d, min(v) AS mn, max(v) AS mx FROM ${from}`, [PROFILE_SAMPLE])) as Row[];
      const top = await rows(conn, `SELECT v AS value, count(*) AS n FROM ${from} WHERE v IS NOT NULL GROUP BY v ORDER BY n DESC, v LIMIT 10`, [PROFILE_SAMPLE]);
      const size = Number(a.n);
      return {
        column: col.name,
        sampleSize: size,
        nullPct: size ? Math.round((1000 * (size - Number(a.nn))) / size) / 10 : 0,
        distinct: Number(a.d),
        min: truncateCell(a.mn),
        max: truncateCell(a.mx),
        top: top.map((t) => ({ value: truncateCell(t.value), count: Number(t.n) })),
        notes: [`Type ${col.type}${pk.length ? " ; échantillon = premières lignes par clé primaire" : " ; échantillon = premières lignes lues (ordre non garanti)"}.`],
      } satisfies ColumnProfile;
    });
  },

  async stats(c, container) {
    const t0 = Date.now();
    const schema = container ? schemaOf(container) : c.database || null;
    return readOnlyExec(c, undefined, async (conn) => {
      const sections: StatSection[] = [];
      const safe = async (key: string, title: string, fn: () => Promise<Row[]>, extra: Partial<StatSection> = {}) => {
        try {
          sections.push({ key, title, rows: await fn(), ...extra });
        } catch (err) {
          sections.push({ key, title, rows: [], unsupported: true, note: err instanceof Error ? err.message : String(err) });
        }
      };
      await safe(
        "digests",
        "Top 20 requêtes par temps total (performance_schema digests)",
        async () => {
          const r = await rows(
            conn,
            `SELECT schema_name AS schema_, count_star AS calls, round(sum_timer_wait / 1e9, 1) AS total_ms, round(avg_timer_wait / 1e9, 2) AS mean_ms,
                    sum_rows_examined AS rows_examined, sum_rows_sent AS rows_sent, sum_no_index_used AS no_index, LEFT(digest_text, 300) AS query
               FROM performance_schema.events_statements_summary_by_digest
              ${schema ? "WHERE schema_name = ?" : ""} ORDER BY sum_timer_wait DESC LIMIT 20`,
            schema ? [schema] : [],
          );
          return r.map((x) => ({ schema: x.schema_, calls: x.calls, total_ms: x.total_ms, mean_ms: x.mean_ms, rows_examined: x.rows_examined, rows_sent: x.rows_sent, no_index: x.no_index, query: x.query }));
        },
        { columns: ["schema", "calls", "total_ms", "mean_ms", "rows_examined", "rows_sent", "no_index", "query"], note: "performance_schema doit être ON (MariaDB : OFF par défaut)." },
      );
      await safe(
        "buffer-pool",
        "InnoDB buffer pool",
        async () => {
          const s = await rows(conn, `SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads','Innodb_buffer_pool_pages_total','Innodb_buffer_pool_pages_free','Innodb_buffer_pool_pages_dirty','Innodb_buffer_pool_pages_data','Innodb_buffer_pool_wait_free','Innodb_row_lock_waits','Innodb_row_lock_time_avg')`);
          const kv = Object.fromEntries(s.map((x) => [String(x.variable_name), Number(x.value)]));
          const size = await rows(conn, `SHOW GLOBAL VARIABLES WHERE Variable_name = 'innodb_buffer_pool_size'`);
          const req = kv.Innodb_buffer_pool_read_requests ?? 0;
          const reads = kv.Innodb_buffer_pool_reads ?? 0;
          return [
            { metrique: "taille (octets)", valeur: Number(size[0]?.value ?? 0) },
            { metrique: "hit ratio %", valeur: req > 0 ? Math.round(10000 * (1 - reads / req)) / 100 : null },
            { metrique: "pages total / data / free / dirty", valeur: `${kv.Innodb_buffer_pool_pages_total ?? "?"} / ${kv.Innodb_buffer_pool_pages_data ?? "?"} / ${kv.Innodb_buffer_pool_pages_free ?? "?"} / ${kv.Innodb_buffer_pool_pages_dirty ?? "?"}` },
            { metrique: "wait_free", valeur: kv.Innodb_buffer_pool_wait_free ?? null },
            { metrique: "row lock waits / avg ms", valeur: `${kv.Innodb_row_lock_waits ?? "?"} / ${kv.Innodb_row_lock_time_avg ?? "?"}` },
          ];
        },
        { columns: ["metrique", "valeur"], note: "hit ratio < 99 % ou wait_free > 0 : innodb_buffer_pool_size trop petit." },
      );
      await safe(
        "unused-indexes",
        "Index jamais utilisés (hors PRIMARY)",
        () =>
          rows(
            conn,
            `SELECT object_schema AS schema_, object_name AS table_, index_name AS index_
               FROM performance_schema.table_io_waits_summary_by_index_usage
              WHERE index_name IS NOT NULL AND index_name <> 'PRIMARY' AND count_star = 0 ${schema ? "AND object_schema = ?" : "AND object_schema NOT IN ('mysql','sys','performance_schema','information_schema')"}
              ORDER BY object_schema, object_name, index_name LIMIT 50`,
            schema ? [schema] : [],
          ).then((r) => r.map((x) => ({ schema: x.schema_, table: x.table_, index: x.index_ }))),
        { columns: ["schema", "table", "index"], note: "Compteurs depuis le démarrage ; performance_schema requis." },
      );
      await safe(
        "no-pk",
        "Tables sans clé primaire",
        () =>
          rows(
            conn,
            `SELECT t.table_schema AS schema_, t.table_name AS table_, t.engine, t.table_rows
               FROM information_schema.tables t
               LEFT JOIN information_schema.table_constraints k ON k.table_schema = t.table_schema AND k.table_name = t.table_name AND k.constraint_type = 'PRIMARY KEY'
              WHERE t.table_type = 'BASE TABLE' AND k.constraint_name IS NULL ${schema ? "AND t.table_schema = ?" : "AND t.table_schema NOT IN ('mysql','sys','performance_schema','information_schema')"}
              ORDER BY t.table_rows DESC LIMIT 50`,
            schema ? [schema] : [],
          ).then((r) => r.map((x) => ({ schema: x.schema_, table: x.table_, engine: x.engine, rows: x.table_rows }))),
        { columns: ["schema", "table", "engine", "rows"], note: "InnoDB sans PK : réplication lente, clé cachée de 6 octets." },
      );
      await safe(
        "fragmented",
        "Tables fragmentées (data_free > 10 % et > 10 Mio)",
        () =>
          rows(
            conn,
            `SELECT table_schema AS schema_, table_name AS table_, data_length + index_length AS size_bytes, data_free, round(100 * data_free / greatest(data_length + index_length + data_free, 1), 1) AS free_pct
               FROM information_schema.tables
              WHERE data_free > 10485760 AND data_free > 0.1 * (data_length + index_length) ${schema ? "AND table_schema = ?" : ""}
              ORDER BY data_free DESC LIMIT 30`,
            schema ? [schema] : [],
          ).then((r) => r.map((x) => ({ schema: x.schema_, table: x.table_, size_bytes: x.size_bytes, data_free: x.data_free, free_pct: x.free_pct }))),
        { columns: ["schema", "table", "size_bytes", "data_free", "free_pct"], note: "OPTIMIZE TABLE récupère l'espace (verrouille la table)." },
      );
      await safe(
        "biggest",
        "Plus grosses tables",
        () =>
          rows(
            conn,
            `SELECT table_schema AS schema_, table_name AS table_, engine, table_rows, data_length, index_length, data_length + index_length AS total_bytes
               FROM information_schema.tables WHERE table_type = 'BASE TABLE' ${schema ? "AND table_schema = ?" : "AND table_schema NOT IN ('mysql','sys','performance_schema','information_schema')"}
              ORDER BY data_length + index_length DESC LIMIT 20`,
            schema ? [schema] : [],
          ).then((r) => r.map((x) => ({ schema: x.schema_, table: x.table_, engine: x.engine, rows: x.table_rows, data_bytes: x.data_length, index_bytes: x.index_length, total_bytes: x.total_bytes }))),
        { columns: ["schema", "table", "engine", "rows", "data_bytes", "index_bytes", "total_bytes"] },
      );
      return { container: schema, sections, durationMs: Date.now() - t0 } satisfies ExploreStats;
    });
  },
};

function truncRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) out[k] = truncateCell(v);
  return out;
}

async function browse(conn: mysql.Connection, schema: string, table: string, req: BrowseRequest): Promise<BrowseResult> {
  const t0 = Date.now();
  const cols = await columnsOf(conn, schema, table);
  const composed = composeBrowse({ quote: q, placeholder: placeholderQuestion, table: `${q(schema)}.${q(table)}`, columns: cols.map((x) => x.name), req });
  const [r] = await conn.query(composed.select, composed.params);
  const out = (r as Row[]).map((x) => truncRow(plainRow(x)));
  let total: number | null = null;
  let totalIsEstimate = false;
  const notes: string[] = [];
  try {
    const [cr] = await conn.query(composed.count, composed.whereParams);
    total = Number((cr as Row[])[0]?.n ?? 0);
  } catch {
    const est = await rows(conn, `SELECT table_rows FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`, [schema, table]).catch(() => [] as Row[]);
    total = req.filters.length ? null : n(est[0]?.table_rows);
    totalIsEstimate = total !== null;
    notes.push(total === null ? "Total inconnu : comptage trop long." : "Total estimé (information_schema.table_rows) : le comptage exact a dépassé 5 s.");
  }
  return { columns: cols.map((x) => x.name), rows: out, page: req.page, pageSize: req.pageSize, total, totalIsEstimate, durationMs: Date.now() - t0, ...(notes.length ? { notes } : {}) };
}
