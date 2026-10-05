import { readOnlyExec, toRows, type ChRun } from "@/lib/drivers/clickhouse";
import type { Conn, Row } from "@/lib/drivers/types";
import { assertExploreIdent, composeBrowse, quoteBacktick, splitQualified } from "./sql";
import { PROFILE_SAMPLE, truncateCell, type BrowseRequest, type BrowseResult, type ColumnProfile, type ExploreColumn, type ExploreContainer, type ExploreDescription, type ExploreIndex, type ExploreObject, type ExploreStats, type Explorer, type StatSection } from "./types";

// ClickHouse explorer over the HTTP interface. Containers = databases (system.databases),
// objects = tables / views / materialized views / dictionaries (system.tables). Every call
// runs through readOnlyExec: readonly=1 enforced by the server, max_execution_time 5 s,
// values bound as ClickHouse query parameters ({pN:Type} + param_pN URL parameter).

const q = quoteBacktick;
const n = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const iso = (v: unknown): string | null => (v ? String(v) : null);

// Parameter types ClickHouse accepts verbatim in {name:Type}: anything else (Array, Map,
// Tuple, Enum, DateTime('UTC'), Nested...) is compared on its text form.
const SIMPLE_TYPE = /^(U?Int(8|16|32|64|128|256)|Float(32|64)|String|FixedString\(\d+\)|Date|Date32|DateTime|DateTime64\(\d+\)|UUID|Bool|Decimal\(\d+, ?\d+\)|Decimal(32|64|128|256)\(\d+\)|IPv4|IPv6)$/;

// Strips Nullable(...) / LowCardinality(...) wrappers.
export function baseType(type: string): string {
  let t = type.trim();
  for (;;) {
    const m = /^(Nullable|LowCardinality)\((.*)\)$/.exec(t);
    if (!m) return t;
    t = m[2];
  }
}

// Type used for the bound parameter of a comparison on this column, or null when the
// column must be compared as text (toString(col) = {p:String}).
export function paramType(columnType: string | undefined): string | null {
  if (!columnType) return null;
  const b = baseType(columnType);
  return SIMPLE_TYPE.test(b) ? b : null;
}

type Composed = ReturnType<typeof composeBrowse>;

// Composes the paged SELECT + count for ClickHouse: backtick identifiers, {pN:Type}
// placeholders typed from the column, text comparison for LIKE and complex types.
export function composeClickHouse(table: string, columns: string[], columnTypes: Record<string, string>, req: BrowseRequest, defaultOrder?: string[]): Composed & { paramMap: Record<string, string | number> } {
  // Placeholder types in the order composeBrowse emits them: one per filter carrying a
  // value, then LIMIT and OFFSET as UInt64.
  const types: string[] = [];
  for (const f of req.filters) {
    if (f.op === "is null" || f.op === "is not null") continue;
    types.push(f.op === "like" ? "String" : (paramType(columnTypes[f.column]) ?? "String"));
  }
  const placeholder = (i: number) => `{p${i}:${types[i - 1] ?? "UInt64"}}`;
  const composed = composeBrowse({
    quote: q,
    placeholder,
    table,
    columns,
    columnTypes,
    req,
    defaultOrder,
    castForOp: (quoted, op, type) => (op === "like" || op === "is null" || op === "is not null" ? (op === "like" ? `toString(${quoted})` : quoted) : paramType(type) ? quoted : `toString(${quoted})`),
  });
  const paramMap: Record<string, string | number> = {};
  composed.params.forEach((v, i) => (paramMap[`p${i + 1}`] = v as string | number));
  return { ...composed, paramMap };
}

const dbOf = (container: string) => assertExploreIdent(container, "Base");
const KIND = (engine: string): string => (engine === "View" ? "view" : engine === "MaterializedView" ? "matview" : engine === "Dictionary" ? "dictionary" : engine === "LiveView" || engine === "WindowView" ? "view" : "table");

type Tbl = { database: string; name: string; engine: string; sorting_key: string; primary_key: string; partition_key: string; sampling_key: string; total_rows: unknown; total_bytes: unknown; metadata_modification_time: unknown; comment: string; engine_full: string };

async function tableOf(run: ChRun, container: string, object: string): Promise<Tbl> {
  const [db, name] = splitQualified(object, dbOf(container));
  if (db !== container) throw new Error(`Objet hors de la base ${container} : ${object}.`);
  const r = toRows(await run(`SELECT database, name, engine, engine_full, sorting_key, primary_key, partition_key, sampling_key, total_rows, total_bytes, metadata_modification_time, comment FROM system.tables WHERE database = {db:String} AND name = {t:String}`, { db, t: name }));
  if (!r[0]) throw new Error(`Objet introuvable : ${db}.${name}.`);
  return r[0] as unknown as Tbl;
}

async function columnsOf(run: ChRun, t: Tbl): Promise<ExploreColumn[]> {
  const r = toRows(
    await run(
      `SELECT name, type, default_kind, default_expression, is_in_primary_key, is_in_sorting_key, is_in_partition_key, comment, compression_codec, data_compressed_bytes, data_uncompressed_bytes
         FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position`,
      { db: t.database, t: t.name },
    ),
  );
  return r.map((x) => {
    const type = String(x.type);
    const extra: Record<string, unknown> = {};
    if (x.default_kind) extra.default_kind = x.default_kind;
    if (x.is_in_sorting_key && !x.is_in_primary_key) extra.sorting_key = true;
    if (x.is_in_partition_key) extra.partition_key = true;
    if (x.comment) extra.comment = x.comment;
    if (x.compression_codec) extra.codec = x.compression_codec;
    const cb = n(x.data_compressed_bytes);
    const ub = n(x.data_uncompressed_bytes);
    if (cb !== null && ub) extra.compression_ratio = Math.round((100 * ub) / Math.max(cb, 1)) / 100;
    return { name: String(x.name), type, nullable: /^Nullable\(/.test(type), default: x.default_expression ? String(x.default_expression) : null, pk: Boolean(x.is_in_primary_key), ...(Object.keys(extra).length ? { extra } : {}) };
  });
}

// Order clause used for samples: the sorting key when it exists (physical order), the first column otherwise.
function orderColumns(t: Tbl, columns: ExploreColumn[]): string[] {
  const keys = String(t.sorting_key || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => columns.some((c) => c.name === s));
  return keys.length ? keys : columns.length ? [columns[0].name] : [];
}

function truncRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) out[k] = truncateCell(typeof v === "object" && v !== null ? JSON.stringify(v) : v);
  return out;
}

export const explorer: Explorer = {
  caveats: ["Totaux : count() exact jusqu'au délai de 5 s, sinon total_rows des parts actives (estimation).", "Profil : échantillon des 10 000 premières lignes dans l'ordre de la clé de tri.", "Pas de contraintes ni de clés étrangères en ClickHouse : la section reste vide."],

  async listContainers(c) {
    return readOnlyExec(c, undefined, async (run) => {
      const r = toRows(
        await run(
          `SELECT d.name AS name, d.engine AS engine, t.tables AS tables, p.size AS size, p.rows AS rows
             FROM system.databases d
             LEFT JOIN (SELECT database, count() AS tables FROM system.tables GROUP BY database) t ON t.database = d.name
             LEFT JOIN (SELECT database, sum(bytes_on_disk) AS size, sum(rows) AS rows FROM system.parts WHERE active GROUP BY database) p ON p.database = d.name
            WHERE d.name NOT IN ('INFORMATION_SCHEMA', 'information_schema') ORDER BY d.name`,
        ),
      );
      return r.map((x): ExploreContainer => ({ name: String(x.name), kind: "database", sizeBytes: n(x.size) ?? 0, objectCount: n(x.tables), extra: { engine: x.engine, ...(n(x.rows) ? { rows: n(x.rows) } : {}), ...(x.name === "system" ? { systeme: true } : {}) } }));
    });
  },

  async listObjects(c, container) {
    const db = dbOf(container);
    return readOnlyExec(c, db, async (run) => {
      const r = toRows(
        await run(
          `SELECT t.name AS name, t.engine AS engine, t.total_rows AS total_rows, t.total_bytes AS total_bytes, t.metadata_modification_time AS meta_time,
                  p.parts AS parts, p.partitions AS partitions, p.last_modified AS last_modified, p.uncompressed AS uncompressed
             FROM system.tables t
             LEFT JOIN (SELECT database, table, count() AS parts, uniqExact(partition) AS partitions, max(modification_time) AS last_modified, sum(data_uncompressed_bytes) AS uncompressed
                          FROM system.parts WHERE active AND database = {db:String} GROUP BY database, table) p ON p.database = t.database AND p.table = t.name
            WHERE t.database = {db:String} ORDER BY t.name`,
          { db },
        ),
      );
      return r.map((x): ExploreObject => {
        const engine = String(x.engine);
        const extra: Record<string, unknown> = { engine };
        if (n(x.parts)) extra.parts = n(x.parts);
        if (n(x.partitions)) extra.partitions = n(x.partitions);
        const cb = n(x.total_bytes);
        const ub = n(x.uncompressed);
        if (cb && ub) extra.compression_ratio = Math.round((100 * ub) / cb) / 100;
        return { name: `${db}.${x.name}`, kind: KIND(engine), estRows: n(x.total_rows), sizeBytes: n(x.total_bytes), lastModified: iso(x.last_modified ?? x.meta_time), extra };
      });
    });
  },

  async describeObject(c, container, object) {
    const db = dbOf(container);
    return readOnlyExec(c, db, async (run) => {
      const t = await tableOf(run, db, object);
      const columns = await columnsOf(run, t);
      const indexes: ExploreIndex[] = [];
      if (t.primary_key) indexes.push({ name: "PRIMARY KEY", columns: String(t.primary_key).split(",").map((s) => s.trim()), unique: false, primary: true, definition: `PRIMARY KEY (${t.primary_key})`, extra: { type: "sparse" } });
      const skip = toRows(await run(`SELECT name, type, expr, granularity, data_compressed_bytes, marks FROM system.data_skipping_indices WHERE database = {db:String} AND table = {t:String} ORDER BY name`, { db, t: t.name }).catch(() => ({ meta: [], data: [], rows: 0 })));
      for (const x of skip) indexes.push({ name: String(x.name), columns: String(x.expr).split(",").map((s) => s.trim()), unique: false, sizeBytes: n(x.data_compressed_bytes), definition: `INDEX ${x.name} ${x.expr} TYPE ${x.type} GRANULARITY ${x.granularity}`, extra: { type: x.type, granularity: n(x.granularity), marks: n(x.marks) } });
      const parts = toRows(
        await run(
          `SELECT count() AS parts, uniqExact(partition) AS partitions, sum(rows) AS rows, sum(bytes_on_disk) AS disk, sum(data_compressed_bytes) AS compressed, sum(data_uncompressed_bytes) AS uncompressed,
                  sum(marks) AS marks, max(modification_time) AS last_modified, min(min_time) AS min_time, max(max_time) AS max_time, max(parts_per_partition) AS max_parts_per_partition
             FROM (SELECT *, count() OVER (PARTITION BY partition) AS parts_per_partition FROM system.parts WHERE active AND database = {db:String} AND table = {t:String})`,
          { db, t: t.name },
        ),
      );
      const p = parts[0] ?? {};
      const partitioning = t.partition_key || t.sorting_key ? { engine: t.engine, cle_partition: t.partition_key || null, cle_tri: t.sorting_key || null, cle_primaire: t.primary_key || null, ...(t.sampling_key ? { cle_echantillonnage: t.sampling_key } : {}), partitions: n(p.partitions) } : null;
      const compressed = n(p.compressed);
      const uncompressed = n(p.uncompressed);
      const storage: Record<string, unknown> = {
        moteur: t.engine_full || t.engine,
        taille_disque: n(p.disk),
        compresse: compressed,
        non_compresse: uncompressed,
        ratio_compression: compressed && uncompressed ? Math.round((100 * uncompressed) / compressed) / 100 : null,
        lignes: n(p.rows) ?? n(t.total_rows),
        parts_actives: n(p.parts),
        max_parts_par_partition: n(p.max_parts_per_partition),
        marks: n(p.marks),
        derniere_modification: iso(p.last_modified) ?? iso(t.metadata_modification_time),
        ...(t.comment ? { commentaire: t.comment } : {}),
      };
      let sample: Row | null = null;
      if (columns.length) {
        const order = orderColumns(t, columns).map(q).join(", ");
        const r = await run(`SELECT ${columns.map((x) => q(x.name)).join(", ")} FROM ${q(db)}.${q(t.name)}${order ? ` ORDER BY ${order}` : ""} LIMIT 1`).catch(() => null);
        sample = r ? (toRows(r)[0] ? truncRow(toRows(r)[0]) : null) : null;
      }
      const notes = ["Tailles en octets (parts actives) ; ratio_compression = non compressé / compressé ; la clé primaire est un index épars (pas d'unicité), les index listés ensuite sont des index de saut (data skipping)."];
      if (!t.sorting_key && KIND(t.engine) === "table") notes.push("Table sans clé de tri (moteur non MergeTree) : l'ordre d'affichage suit la première colonne.");
      return { object: { name: `${db}.${t.name}`, kind: KIND(t.engine), estRows: n(p.rows) ?? n(t.total_rows), sizeBytes: n(p.disk) ?? n(t.total_bytes), extra: { engine: t.engine } }, columns, indexes, constraints: [], partitioning, storage, sample, notes } satisfies ExploreDescription;
    });
  },

  async browseRows(c, container, object, req) {
    const db = dbOf(container);
    return readOnlyExec(c, db, async (run) => {
      const t0 = Date.now();
      const t = await tableOf(run, db, object);
      const cols = await columnsOf(run, t);
      const columnTypes = Object.fromEntries(cols.map((x) => [x.name, x.type]));
      const composed = composeClickHouse(`${q(db)}.${q(t.name)}`, cols.map((x) => x.name), columnTypes, req, orderColumns(t, cols));
      const rows = toRows(await run(composed.select, composed.paramMap)).map(truncRow);
      const notes: string[] = [];
      let total: number | null = null;
      let totalIsEstimate = false;
      const whereParams: Record<string, string | number> = {};
      composed.whereParams.forEach((v, i) => (whereParams[`p${i + 1}`] = v as string | number));
      try {
        const cr = toRows(await run(composed.count, whereParams));
        total = n(cr[0]?.n) ?? 0;
      } catch {
        if (req.filters.length === 0 && n(t.total_rows) !== null) {
          total = n(t.total_rows);
          totalIsEstimate = true;
          notes.push("Total estimé (system.tables.total_rows) : le comptage exact a dépassé 5 s.");
        } else {
          notes.push("Total inconnu : comptage trop long.");
        }
      }
      return { columns: cols.map((x) => x.name), rows, page: req.page, pageSize: req.pageSize, total, totalIsEstimate, durationMs: Date.now() - t0, ...(notes.length ? { notes } : {}) } satisfies BrowseResult;
    });
  },

  async columnProfile(c, container, object, column) {
    const db = dbOf(container);
    return readOnlyExec(c, db, async (run) => {
      const t = await tableOf(run, db, object);
      const cols = await columnsOf(run, t);
      const col = cols.find((x) => x.name === assertExploreIdent(column, "Colonne"));
      if (!col) throw new Error(`Colonne inconnue : ${column}.`);
      const order = orderColumns(t, cols).map(q).join(", ");
      const sampleSql = `SELECT ${q(col.name)} AS v FROM ${q(db)}.${q(t.name)}${order ? ` ORDER BY ${order}` : ""} LIMIT {lim:UInt64}`;
      const simple = paramType(col.type) !== null;
      const minmax = simple ? "toString(min(v)) AS mn, toString(max(v)) AS mx" : "min(toString(v)) AS mn, max(toString(v)) AS mx";
      const a = toRows(await run(`SELECT count() AS n, count(v) AS nn, uniqExact(v) AS d, ${minmax} FROM (${sampleSql})`, { lim: PROFILE_SAMPLE }))[0] ?? {};
      const top = toRows(await run(`SELECT toString(v) AS value, count() AS n FROM (${sampleSql}) WHERE v IS NOT NULL GROUP BY v ORDER BY n DESC, value LIMIT 10`, { lim: PROFILE_SAMPLE }));
      const size = n(a.n) ?? 0;
      const nn = n(a.nn) ?? size;
      return {
        column: col.name,
        sampleSize: size,
        nullPct: size ? Math.round((1000 * (size - nn)) / size) / 10 : 0,
        distinct: n(a.d),
        min: truncateCell(a.mn),
        max: truncateCell(a.mx),
        top: top.map((x) => ({ value: truncateCell(x.value), count: n(x.n) ?? 0 })),
        notes: [`Type ${col.type}${simple ? "" : " : min/max calculés sur la représentation texte"}.`],
      } satisfies ColumnProfile;
    });
  },

  async stats(c, container) {
    const t0 = Date.now();
    const db = container ? dbOf(container) : c.database || "default";
    return readOnlyExec(c, db, async (run) => {
      const sections: StatSection[] = [];
      const rows = (sql: string, params?: Record<string, string | number>) => run(sql, params).then(toRows);
      sections.push({
        key: "parts",
        title: "Parts et compression par table",
        description: "parts actives, partitions, lignes, octets compressés / non compressés, ratio, marks",
        columns: ["table", "engine", "parts", "partitions", "max_parts_partition", "rows", "compressed", "uncompressed", "ratio", "marks", "last_modified"],
        rows: await rows(
          `SELECT concat(p.database, '.', p.table) AS "table", any(t.engine) AS engine, count() AS parts, uniqExact(p.partition) AS partitions, max(p.ppp) AS max_parts_partition,
                  sum(p.rows) AS rows, sum(p.data_compressed_bytes) AS compressed, sum(p.data_uncompressed_bytes) AS uncompressed,
                  round(sum(p.data_uncompressed_bytes) / greatest(sum(p.data_compressed_bytes), 1), 2) AS ratio, sum(p.marks) AS marks, max(p.modification_time) AS last_modified
             FROM (SELECT *, count() OVER (PARTITION BY database, table, partition) AS ppp FROM system.parts WHERE active AND database = {db:String}) p
             LEFT JOIN system.tables t ON t.database = p.database AND t.name = p.table
            GROUP BY p.database, p.table ORDER BY compressed DESC LIMIT 50`,
          { db },
        ),
        note: "> 300 parts actives dans une partition : les insertions sont trop fréquentes ou trop petites (parts_to_throw_insert = 300 par défaut).",
      });
      sections.push({
        key: "columns",
        title: "Colonnes les plus volumineuses",
        columns: ["table", "column", "type", "codec", "compressed", "uncompressed", "ratio"],
        rows: await rows(
          `SELECT concat(database, '.', table) AS "table", name AS column, type, compression_codec AS codec, data_compressed_bytes AS compressed, data_uncompressed_bytes AS uncompressed,
                  round(data_uncompressed_bytes / greatest(data_compressed_bytes, 1), 2) AS ratio
             FROM system.columns WHERE database = {db:String} AND data_compressed_bytes > 0 ORDER BY data_compressed_bytes DESC LIMIT 30`,
          { db },
        ),
        note: "Les parts compactes (petites tables, < min_bytes_for_wide_part) ne tiennent pas de statistiques par colonne : elles n'apparaissent pas ici.",
      });
      sections.push({
        key: "merges",
        title: "Fusions et mutations en cours",
        columns: ["table", "kind", "elapsed_s", "progress", "parts", "size", "is_mutation"],
        rows: [
          ...(await rows(`SELECT concat(database, '.', table) AS "table", merge_type AS kind, round(elapsed, 1) AS elapsed_s, round(progress * 100, 1) AS progress, num_parts AS parts, formatReadableSize(total_size_bytes_compressed) AS size, is_mutation FROM system.merges WHERE database = {db:String} ORDER BY elapsed DESC LIMIT 20`, { db })),
          ...(await rows(`SELECT concat(database, '.', table) AS "table", 'mutation' AS kind, round(dateDiff('second', create_time, now()), 1) AS elapsed_s, NULL AS progress, length(parts_to_do_names) AS parts, left(command, 120) AS size, 1 AS is_mutation FROM system.mutations WHERE database = {db:String} AND NOT is_done ORDER BY create_time LIMIT 20`, { db })),
        ],
        note: "Les mutations (ALTER ... UPDATE/DELETE) réécrivent les parts entières ; une mutation bloquée apparaît ici tant que is_done = 0.",
      });
      try {
        sections.push({
          key: "queries",
          title: "Top 20 requêtes par temps total (system.query_log, 24 h)",
          columns: ["calls", "total_ms", "mean_ms", "read_rows", "read_bytes", "memory_max", "query"],
          rows: await rows(
            `SELECT count() AS calls, sum(query_duration_ms) AS total_ms, round(avg(query_duration_ms), 1) AS mean_ms, sum(read_rows) AS read_rows,
                    formatReadableSize(sum(read_bytes)) AS read_bytes, formatReadableSize(max(memory_usage)) AS memory_max, left(any(normalizeQuery(query)), 300) AS query
               FROM system.query_log
              WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 1 DAY AND query NOT LIKE '%system.%'
              GROUP BY normalized_query_hash ORDER BY total_ms DESC LIMIT 20`,
          ),
          note: "Hors requêtes sur system.* ; la journalisation dépend de log_queries (1 par défaut) et de la rétention de query_log.",
        });
      } catch (err) {
        sections.push({ key: "queries", title: "Top 20 requêtes (system.query_log)", rows: [], unsupported: true, note: err instanceof Error ? err.message : String(err) });
      }
      sections.push({
        key: "skip-indexes",
        title: "Index de saut (data skipping)",
        columns: ["table", "index", "type", "expr", "granularity", "compressed", "marks"],
        rows: await rows(`SELECT concat(database, '.', table) AS "table", name AS index, type, expr, granularity, data_compressed_bytes AS compressed, marks FROM system.data_skipping_indices WHERE database = {db:String} ORDER BY data_compressed_bytes DESC LIMIT 50`, { db }).catch(() => []),
      });
      sections.push({
        key: "partitions",
        title: "Partitions les plus grosses",
        columns: ["table", "partition", "parts", "rows", "disk", "min_time", "max_time"],
        rows: await rows(
          `SELECT concat(database, '.', table) AS "table", partition, count() AS parts, sum(rows) AS rows, sum(bytes_on_disk) AS disk, min(min_time) AS min_time, max(max_time) AS max_time
             FROM system.parts WHERE active AND database = {db:String} GROUP BY database, table, partition ORDER BY disk DESC LIMIT 30`,
          { db },
        ),
      });
      return { container: db, sections, durationMs: Date.now() - t0 } satisfies ExploreStats;
    });
  },
};
