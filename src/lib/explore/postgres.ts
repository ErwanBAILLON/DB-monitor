import type { Client } from "pg";
import { readOnlyExec } from "@/lib/drivers/postgres";
import { plainRow, type Conn, type Row } from "@/lib/drivers/types";
import { assertExploreIdent, composeBrowse, placeholderDollar, quoteDouble, splitQualified } from "./sql";
import { PROFILE_SAMPLE, truncateCell, type BrowseRequest, type BrowseResult, type ColumnProfile, type ExploreColumn, type ExploreConstraint, type ExploreContainer, type ExploreDescription, type ExploreIndex, type ExploreObject, type ExploreStats, type Explorer, type StatSection } from "./types";

// PostgreSQL explorer. Containers = databases (one connection per database: catalogs are
// per-database). Objects = tables, partitioned tables, views, materialized views, foreign
// tables outside pg_catalog / information_schema / pg_toast. Every call runs inside
// readOnlyExec (BEGIN READ ONLY + statement_timeout 5 s, rolled back).

const q = quoteDouble;
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
const KIND: Record<string, string> = { r: "table", p: "partitioned", v: "view", m: "matview", f: "foreign" };
const TEXT_TYPES = /^(text|character varying|character|name|citext|bpchar|varchar)/;
const ORDERED_TYPES = /^(smallint|integer|bigint|numeric|real|double precision|date|timestamp|time|interval|boolean|uuid|inet|money|oid)/;

type Rel = { oid: number; schema: string; name: string; kind: string };

async function relOf(client: Client, object: string): Promise<Rel> {
  const [schema, name] = splitQualified(object, "public");
  const r = await client.query(
    `SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m','f')`,
    [schema, name],
  );
  if (!r.rows[0]) throw new Error(`Objet introuvable : ${schema}.${name}.`);
  return { oid: Number(r.rows[0].oid), schema, name, kind: String(r.rows[0].kind) };
}

async function columnsOf(client: Client, oid: number): Promise<ExploreColumn[]> {
  const r = await client.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
            pg_get_expr(d.adbin, d.adrelid) AS "default",
            EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS pk,
            a.attidentity <> '' AS identity, a.attgenerated <> '' AS generated,
            col_description(a.attrelid, a.attnum) AS comment
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [oid],
  );
  return r.rows.map((x) => {
    const extra: Record<string, unknown> = {};
    if (x.identity) extra.identity = true;
    if (x.generated) extra.generated = true;
    if (x.comment) extra.comment = x.comment;
    return { name: String(x.name), type: String(x.type), nullable: Boolean(x.nullable), default: x.default ?? null, pk: Boolean(x.pk), ...(Object.keys(extra).length ? { extra } : {}) };
  });
}

function dbOf(c: Conn, container: string): string {
  return assertExploreIdent(container, "Base");
}

export const explorer: Explorer = {
  caveats: ["Totaux : comptage exact jusqu'au délai de 5 s, sinon estimation du planificateur.", "Profil : échantillon des 10 000 premières lignes (ordre physique)."],

  async listContainers(c) {
    return readOnlyExec(c, undefined, async (client) => {
      const r = await client.query(
        `SELECT d.datname AS name, pg_database_size(d.oid) AS size, pg_get_userbyid(d.datdba) AS owner,
                pg_encoding_to_char(d.encoding) AS encoding, d.datallowconn AS allow_conn
           FROM pg_database d WHERE NOT d.datistemplate ORDER BY d.datname`,
      );
      return r.rows.map((x): ExploreContainer => ({ name: String(x.name), kind: "database", sizeBytes: n(x.size), objectCount: null, extra: { owner: x.owner, encoding: x.encoding, ...(x.allow_conn ? {} : { allow_conn: false }) } }));
    });
  },

  async listObjects(c, container) {
    return readOnlyExec(c, dbOf(c, container), async (client) => {
      const r = await client.query(
        `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.reltuples AS est_rows,
                CASE WHEN c.relkind IN ('r','p','m') THEN pg_total_relation_size(c.oid) ELSE NULL END AS size,
                greatest(s.last_autovacuum, s.last_vacuum, s.last_autoanalyze, s.last_analyze) AS last_maint,
                s.n_dead_tup AS dead
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
          WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
            AND n.nspname NOT LIKE 'pg\\_temp%'
          ORDER BY n.nspname, c.relname`,
      );
      return r.rows.map((x): ExploreObject => ({
        name: `${x.schema}.${x.name}`,
        kind: KIND[String(x.kind)] ?? String(x.kind),
        estRows: Number(x.est_rows) < 0 ? null : n(x.est_rows),
        sizeBytes: n(x.size),
        lastModified: iso(x.last_maint),
        extra: { schema: x.schema, ...(n(x.dead) ? { dead_rows: n(x.dead) } : {}) },
      }));
    });
  },

  async describeObject(c, container, object) {
    return readOnlyExec(c, dbOf(c, container), async (client) => {
      const rel = await relOf(client, object);
      const columns = await columnsOf(client, rel.oid);
      const idx = await client.query(
        `SELECT ic.relname AS name, i.indisunique AS "unique", i.indisprimary AS "primary", i.indisvalid AS valid,
                am.amname AS method, pg_relation_size(ic.oid) AS size, pg_get_indexdef(i.indexrelid) AS def,
                ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS cols,
                st.idx_scan AS scans
           FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
           LEFT JOIN pg_stat_all_indexes st ON st.indexrelid = i.indexrelid
          WHERE i.indrelid = $1 ORDER BY i.indisprimary DESC, ic.relname`,
        [rel.oid],
      );
      const indexes: ExploreIndex[] = idx.rows.map((x) => ({ name: String(x.name), columns: (x.cols as string[]).filter(Boolean), unique: Boolean(x.unique), primary: Boolean(x.primary), sizeBytes: n(x.size), definition: String(x.def), extra: { method: x.method, scans: n(x.scans), ...(x.valid ? {} : { valid: false }) } }));
      const con = await client.query(
        `SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS def,
                ARRAY(SELECT a.attname FROM unnest(conkey) k(attnum) JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k.attnum)::text[] AS cols,
                CASE WHEN contype = 'f' THEN confrelid::regclass::text END AS ref,
                ARRAY(SELECT a.attname FROM unnest(confkey) k(attnum) JOIN pg_attribute a ON a.attrelid = confrelid AND a.attnum = k.attnum)::text[] AS refcols
           FROM pg_constraint WHERE conrelid = $1 ORDER BY contype, conname`,
        [rel.oid],
      );
      const KINDC: Record<string, ExploreConstraint["kind"]> = { p: "pk", f: "fk", u: "unique", c: "check", x: "exclusion" };
      const constraints: ExploreConstraint[] = con.rows.map((x) => ({ name: String(x.name), kind: KINDC[String(x.type)] ?? "other", columns: x.cols as string[], definition: String(x.def), ...(x.ref ? { refObject: String(x.ref), refColumns: x.refcols as string[] } : {}) }));
      // Partitioning: parent (pg_partitioned_table) or child (relpartbound).
      let partitioning: Record<string, unknown> | null = null;
      const part = await client.query(
        `SELECT pg_get_partkeydef($1::oid) AS key, (SELECT count(*) FROM pg_inherits WHERE inhparent = $1) AS parts,
                (SELECT pg_get_expr(relpartbound, oid) FROM pg_class WHERE oid = $1) AS bound,
                (SELECT inhparent::regclass::text FROM pg_inherits WHERE inhrelid = $1 LIMIT 1) AS parent`,
        [rel.oid],
      );
      const p = part.rows[0];
      if (p?.key) partitioning = { strategy: String(p.key).split(" ")[0], key: p.key, partitions: n(p.parts) };
      else if (p?.bound) partitioning = { parent: p.parent, bound: p.bound };
      const st = await client.query(
        `SELECT pg_total_relation_size(c.oid) AS total, pg_relation_size(c.oid) AS heap, pg_indexes_size(c.oid) AS indexes,
                pg_total_relation_size(c.reltoastrelid) AS toast, c.relpages AS pages, c.reltuples AS est_rows, c.reloptions AS options,
                s.n_live_tup, s.n_dead_tup, s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze,
                s.seq_scan, s.idx_scan, s.n_tup_ins, s.n_tup_upd, s.n_tup_del, s.n_mod_since_analyze
           FROM pg_class c LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid WHERE c.oid = $1`,
        [rel.oid],
      );
      const s = st.rows[0] ?? {};
      const live = n(s.n_live_tup) ?? 0;
      const dead = n(s.n_dead_tup) ?? 0;
      const storage: Record<string, unknown> = {
        taille_totale: n(s.total),
        heap: n(s.heap),
        index: n(s.indexes),
        toast: n(s.toast),
        pages: n(s.pages),
        lignes_vivantes: live,
        lignes_mortes: dead,
        bloat_pct: live + dead > 0 ? Math.round((1000 * dead) / (live + dead)) / 10 : 0,
        dernier_vacuum: iso(s.last_autovacuum ?? s.last_vacuum),
        dernier_analyze: iso(s.last_autoanalyze ?? s.last_analyze),
        modif_depuis_analyze: n(s.n_mod_since_analyze),
        seq_scan: n(s.seq_scan),
        idx_scan: n(s.idx_scan),
        ins_upd_del: `${n(s.n_tup_ins) ?? 0} / ${n(s.n_tup_upd) ?? 0} / ${n(s.n_tup_del) ?? 0}`,
        ...(s.options ? { options: (s.options as string[]).join(", ") } : {}),
      };
      let sample: Row | null = null;
      if (columns.length) {
        const r = await client.query(`SELECT ${columns.map((x) => q(x.name)).join(", ")} FROM ${q(rel.schema)}.${q(rel.name)} LIMIT 1`).catch(() => ({ rows: [] as Row[] }));
        sample = r.rows[0] ? truncRow(plainRow(r.rows[0] as Row)) : null;
      }
      const notes = ["Tailles en octets ; lignes_vivantes/mortes viennent de pg_stat (approximatif) ; bloat_pct = mortes / (vivantes + mortes)."];
      return { object: { name: `${rel.schema}.${rel.name}`, kind: KIND[rel.kind] ?? rel.kind, estRows: Number(s.est_rows) < 0 ? null : n(s.est_rows), sizeBytes: n(s.total) }, columns, indexes, constraints, partitioning, storage, sample, notes } satisfies ExploreDescription;
    });
  },

  async browseRows(c, container, object, req) {
    return readOnlyExec(c, dbOf(c, container), async (client) => browse(client, object, req));
  },

  async columnProfile(c, container, object, column) {
    return readOnlyExec(c, dbOf(c, container), async (client) => {
      const rel = await relOf(client, object);
      const cols = await columnsOf(client, rel.oid);
      const col = cols.find((x) => x.name === assertExploreIdent(column, "Colonne"));
      if (!col) throw new Error(`Colonne inconnue : ${column}.`);
      const table = `${q(rel.schema)}.${q(rel.name)}`;
      const v = q(col.name);
      const ordered = ORDERED_TYPES.test(col.type) || TEXT_TYPES.test(col.type);
      const minmax = ordered ? `min(v), max(v)` : `min(v::text), max(v::text)`;
      const agg = await client.query(`WITH s AS (SELECT ${v} AS v FROM ${table} LIMIT $1) SELECT count(*) AS n, count(v) AS nn, count(DISTINCT v::text) AS d, ${minmax} FROM s`, [PROFILE_SAMPLE]);
      const a = agg.rows[0];
      const top = await client.query(`WITH s AS (SELECT ${v} AS v FROM ${table} LIMIT $1) SELECT v::text AS value, count(*) AS n FROM s WHERE v IS NOT NULL GROUP BY v::text ORDER BY n DESC, value LIMIT 10`, [PROFILE_SAMPLE]);
      const size = Number(a.n);
      return {
        column: col.name,
        sampleSize: size,
        nullPct: size ? Math.round((1000 * (size - Number(a.nn))) / size) / 10 : 0,
        distinct: Number(a.d),
        min: truncateCell(plain(a.min)),
        max: truncateCell(plain(a.max)),
        top: top.rows.map((t) => ({ value: truncateCell(t.value), count: Number(t.n) })),
        notes: [`Type ${col.type}${ordered ? "" : " : min/max calculés sur la représentation texte"}.`],
      } satisfies ColumnProfile;
    });
  },

  async stats(c, container) {
    const t0 = Date.now();
    const db = container ? dbOf(c, container) : c.database || "postgres";
    return readOnlyExec(c, db, async (client) => {
      const sections: StatSection[] = [];
      const rows = async (sql: string) => (await client.query(sql)).rows.map(plainRow);
      const ext = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'");
      if (ext.rowCount) {
        try {
          await client.query("SAVEPOINT s");
          sections.push({
            key: "statements",
            title: "Top 20 requêtes par temps total (pg_stat_statements)",
            columns: ["calls", "total_ms", "mean_ms", "rows", "hit_pct", "query"],
            rows: await rows(`SELECT calls, round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms, rows,
                                     CASE WHEN shared_blks_hit + shared_blks_read > 0 THEN round(100.0 * shared_blks_hit / (shared_blks_hit + shared_blks_read), 1) END AS hit_pct,
                                     left(query, 300) AS query
                                FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = current_database()
                               ORDER BY total_exec_time DESC LIMIT 20`),
            note: "Cumul depuis le dernier pg_stat_statements_reset().",
          });
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT s");
          sections.push({ key: "statements", title: "Top 20 requêtes (pg_stat_statements)", rows: [], unsupported: true, note: err instanceof Error ? err.message : String(err) });
        }
      } else {
        sections.push({ key: "statements", title: "Top 20 requêtes (pg_stat_statements)", rows: [], unsupported: true, note: "extension pg_stat_statements absente de cette base (CREATE EXTENSION pg_stat_statements + shared_preload_libraries)." });
      }
      sections.push({
        key: "cache",
        title: "Taux de cache (shared_buffers)",
        columns: ["quoi", "hit_pct", "blocs_lus", "blocs_cache"],
        rows: await rows(`SELECT 'tables' AS quoi, round(100.0 * sum(heap_blks_hit) / nullif(sum(heap_blks_hit + heap_blks_read), 0), 2) AS hit_pct, sum(heap_blks_read) AS blocs_lus, sum(heap_blks_hit) AS blocs_cache FROM pg_statio_user_tables
                         UNION ALL
                         SELECT 'index', round(100.0 * sum(idx_blks_hit) / nullif(sum(idx_blks_hit + idx_blks_read), 0), 2), sum(idx_blks_read), sum(idx_blks_hit) FROM pg_statio_user_indexes`),
        note: "< 99 % sur une base OLTP : shared_buffers probablement trop petit.",
      });
      sections.push({
        key: "vacuum",
        title: "Tables à vacuumer / analyser",
        description: "lignes mortes > 10 % des vivantes (et > 1 000), ou jamais analysées",
        columns: ["table", "live", "dead", "dead_pct", "mod_since_analyze", "last_autovacuum", "last_autoanalyze"],
        rows: await rows(`SELECT schemaname || '.' || relname AS "table", n_live_tup AS live, n_dead_tup AS dead,
                                 round(100.0 * n_dead_tup / greatest(n_live_tup, 1), 1) AS dead_pct, n_mod_since_analyze AS mod_since_analyze,
                                 last_autovacuum, last_autoanalyze
                            FROM pg_stat_user_tables
                           WHERE (n_dead_tup > 1000 AND n_dead_tup > 0.1 * n_live_tup) OR (last_analyze IS NULL AND last_autoanalyze IS NULL AND n_live_tup > 1000)
                           ORDER BY n_dead_tup DESC LIMIT 30`),
      });
      sections.push({
        key: "unused-indexes",
        title: "Index jamais utilisés (hors PK/unique)",
        columns: ["table", "index", "size_bytes", "scans"],
        rows: await rows(`SELECT s.schemaname || '.' || s.relname AS "table", s.indexrelname AS index, pg_relation_size(s.indexrelid) AS size_bytes, s.idx_scan AS scans
                            FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
                           WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
                           ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 30`),
        note: "Compteurs depuis le dernier reset des stats ; un index peut servir à des contraintes ou à des rapports rares.",
      });
      sections.push({
        key: "seq-scans",
        title: "Tables volumineuses lues séquentiellement",
        columns: ["table", "seq_scan", "seq_tup_read", "idx_scan", "live"],
        rows: await rows(`SELECT schemaname || '.' || relname AS "table", seq_scan, seq_tup_read, idx_scan, n_live_tup AS live
                            FROM pg_stat_user_tables WHERE seq_scan > 0 AND n_live_tup > 10000
                           ORDER BY seq_tup_read DESC LIMIT 20`),
      });
      sections.push({
        key: "biggest",
        title: "Plus grosses tables",
        columns: ["table", "total_bytes", "heap_bytes", "index_bytes", "est_rows"],
        rows: await rows(`SELECT n.nspname || '.' || c.relname AS "table", pg_total_relation_size(c.oid) AS total_bytes, pg_relation_size(c.oid) AS heap_bytes,
                                 pg_indexes_size(c.oid) AS index_bytes, c.reltuples::bigint AS est_rows
                            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE c.relkind IN ('r','m','p') AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
                           ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 20`),
      });
      return { container: db, sections, durationMs: Date.now() - t0 } satisfies ExploreStats;
    });
  },
};

const plain = (v: unknown) => (v instanceof Date ? v.toISOString() : v !== null && typeof v === "object" ? JSON.stringify(v) : v);
function truncRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) out[k] = truncateCell(v);
  return out;
}

async function browse(client: Client, object: string, req: BrowseRequest): Promise<BrowseResult> {
  const t0 = Date.now();
  const rel = await relOf(client, object);
  const cols = await columnsOf(client, rel.oid);
  const columnTypes = Object.fromEntries(cols.map((x) => [x.name, x.type]));
  const table = `${q(rel.schema)}.${q(rel.name)}`;
  const composed = composeBrowse({
    quote: q,
    placeholder: placeholderDollar,
    table,
    columns: cols.map((x) => x.name),
    columnTypes,
    req,
    // LIKE needs text; comparisons let the server type the parameter from the column.
    castForOp: (quoted, op, type) => (op === "like" && !(type && TEXT_TYPES.test(type)) ? `${quoted}::text` : quoted),
  });
  const r = await client.query(composed.select, composed.params);
  const rows = (r.rows as Row[]).map((x) => truncRow(plainRow(x)));
  const notes: string[] = [];
  let total: number | null = null;
  let totalIsEstimate = false;
  const est = await client.query("SELECT reltuples FROM pg_class WHERE oid = $1", [rel.oid]);
  const reltuples = Number(est.rows[0]?.reltuples ?? -1);
  if (req.filters.length === 0 && reltuples > 1_000_000) {
    total = Math.round(reltuples);
    totalIsEstimate = true;
    notes.push("Total estimé (pg_class.reltuples) : table > 1 M de lignes, comptage exact évité.");
  } else {
    await client.query("SAVEPOINT cnt");
    try {
      const cr = await client.query(composed.count, composed.whereParams);
      total = Number(cr.rows[0]?.n ?? 0);
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT cnt");
      // count(*) timed out: ask the planner.
      try {
        const ex = await client.query(`EXPLAIN (FORMAT JSON) ${composed.count.replace(/^SELECT count\(\*\) AS n/, "SELECT 1")}`, composed.whereParams);
        const plan = (ex.rows[0] as { "QUERY PLAN": { Plan: { "Plan Rows": number } }[] })["QUERY PLAN"][0].Plan;
        total = Number(plan["Plan Rows"]);
        totalIsEstimate = true;
        notes.push("Total estimé par le planificateur : le comptage exact a dépassé 5 s.");
      } catch {
        total = null;
        notes.push("Total inconnu : comptage trop long.");
      }
    }
  }
  return { columns: cols.map((x) => x.name), rows, page: req.page, pageSize: req.pageSize, total, totalIsEstimate, durationMs: Date.now() - t0, ...(notes.length ? { notes } : {}) };
}
