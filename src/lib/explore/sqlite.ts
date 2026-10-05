import { statSync } from "node:fs";
import { withDb } from "@/lib/drivers/sqlite";
import { plainRow, type Row } from "@/lib/drivers/types";
import { assertExploreIdent, composeBrowse, placeholderQuestion, quoteDouble } from "./sql";
import { PROFILE_SAMPLE, truncateCell, type BrowseRequest, type BrowseResult, type ColumnProfile, type ExploreColumn, type ExploreConstraint, type ExploreContainer, type ExploreDescription, type ExploreIndex, type ExploreObject, type ExploreStats, type Explorer, type StatSection } from "./types";

// SQLite explorer. A file has a single container ("main": attached databases are not
// supported on the read-only handle opened by the driver). Objects = tables and views of
// sqlite_master. Every call runs inside withDb (file opened SQLITE_OPEN_READONLY, enforced
// by the library) and binds values as `?` parameters through node-sqlite3-wasm.

type Db = import("node-sqlite3-wasm").Database;
type Bind = (number | bigint | string | Uint8Array | null)[];

const q = quoteDouble;
export const MAIN = "main";
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const WITHOUT_ROWID = /WITHOUT\s+ROWID/i;
const STRICT = /\bSTRICT\b\s*;?\s*$/i;

function all(db: Db, sql: string, params: unknown[] = []): Row[] {
  return (db.all(sql, params as Bind) as Row[]).map(plainRow);
}
function one(db: Db, sql: string, params: unknown[] = []): unknown {
  return Object.values(db.get(sql, params as Bind) ?? {})[0];
}
function truncRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) out[k] = truncateCell(v);
  return out;
}

export function containerOf(container: string): string {
  if (container !== MAIN) throw new Error(`Conteneur inconnu : « ${String(container).slice(0, 40)} » (seul « main » est exploré).`);
  return MAIN;
}
const tableOf = (s: string) => assertExploreIdent(s, "Table");

// dbstat is a compile-time virtual table (SQLITE_ENABLE_DBSTAT_VTAB); node-sqlite3-wasm may lack it.
function dbstatSize(db: Db, name: string): number | null {
  try {
    return num(one(db, "SELECT sum(pgsize) FROM dbstat WHERE name = ?", [name]));
  } catch {
    return null;
  }
}

type Master = { name: string; type: string; sql: string | null };
function master(db: Db, name: string): Master {
  const m = all(db, "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?", [name])[0];
  if (!m) throw new Error(`Objet introuvable : ${name}.`);
  return { name: String(m.name), type: String(m.type), sql: m.sql === null ? null : String(m.sql) };
}

export function columnsOf(db: Db, name: string): ExploreColumn[] {
  // table_xinfo also lists hidden / generated columns.
  const cols = all(db, `PRAGMA table_xinfo(${q(name)})`);
  if (!cols.length) throw new Error(`Objet introuvable : ${name}.`);
  return cols.map((x) => {
    const extra: Record<string, unknown> = {};
    const hidden = num(x.hidden) ?? 0;
    if (hidden === 1) extra.hidden = true;
    if (hidden === 2) extra.generated = "virtual";
    if (hidden === 3) extra.generated = "stored";
    const pk = (num(x.pk) ?? 0) > 0;
    // "INTEGER PRIMARY KEY" aliases the rowid: never NULL even without NOT NULL (other PK
    // columns may hold NULL in SQLite unless declared NOT NULL: legacy behaviour, kept as-is).
    const rowidAlias = pk && /^integer$/i.test(String(x.type || ""));
    return {
      name: String(x.name),
      type: String(x.type || "") || "(sans affinité)",
      nullable: num(x.notnull) === 0 && !rowidAlias,
      default: x.dflt_value === null || x.dflt_value === undefined ? null : String(x.dflt_value),
      pk,
      ...(Object.keys(extra).length ? { extra } : {}),
    };
  });
}

function countRows(db: Db, name: string): number | null {
  try {
    return num(one(db, `SELECT count(*) FROM ${q(name)}`));
  } catch {
    return null; // virtual table without its module, broken view...
  }
}

function indexColumns(db: Db, index: string): string[] {
  return all(db, `PRAGMA index_xinfo(${q(index)})`)
    .filter((k) => num(k.cid) !== -1 && (num(k.key) ?? 1) === 1)
    .map((k) => (k.name === null ? "(expression)" : String(k.name)));
}

function hasStat1(db: Db): boolean {
  return Boolean(all(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'")[0]);
}

export const explorer: Explorer = {
  caveats: ["Un fichier = un conteneur « main » ; les bases attachées ne sont pas explorées.", "Nombres de lignes : count(*) exact (lecture complète : lent sur de très gros fichiers).", "Pas de timeout serveur : la lecture se fait dans le pod ; les pages sont limitées à 100 lignes.", "Identifiants hors [A-Za-z0-9_$] non explorables."],

  async listContainers(c) {
    return withDb(c, (db, file) => {
      const st = statSync(file);
      const objects = num(one(db, "SELECT count(*) FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'"));
      return [{ name: MAIN, kind: "file", sizeBytes: st.size, objectCount: objects, extra: { fichier: file, journal_mode: one(db, "PRAGMA journal_mode"), encodage: one(db, "PRAGMA encoding"), page_size: one(db, "PRAGMA page_size") } }] satisfies ExploreContainer[];
    });
  },

  async listObjects(c, container) {
    containerOf(container);
    return withDb(c, (db, file) => {
      const st = statSync(file);
      const ms = all(db, "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
      return ms.map((m): ExploreObject => {
        const name = String(m.name);
        const sql = String(m.sql ?? "");
        const virtual = /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql);
        const kind = m.type === "view" ? "view" : virtual ? "virtual" : "table";
        const extra: Record<string, unknown> = {};
        if (WITHOUT_ROWID.test(sql)) extra.without_rowid = true;
        if (STRICT.test(sql)) extra.strict = true;
        if (virtual) extra.module = (sql.match(/USING\s+(\w+)/i) ?? [])[1] ?? null;
        return { name, kind, estRows: countRows(db, name), sizeBytes: kind === "view" ? null : dbstatSize(db, name), lastModified: st.mtime.toISOString(), ...(Object.keys(extra).length ? { extra } : {}) };
      });
    });
  },

  async describeObject(c, container, object) {
    containerOf(container);
    const table = tableOf(object);
    return withDb(c, (db, file) => {
      const m = master(db, table);
      const columns = columnsOf(db, table);
      const isView = m.type === "view";
      const indexes: ExploreIndex[] = [];
      const constraints: ExploreConstraint[] = [];
      const pkCols = columns.filter((x) => x.pk).map((x) => x.name);
      if (pkCols.length) constraints.push({ name: "PRIMARY KEY", kind: "pk", columns: pkCols });
      if (!isView) {
        const stat1 = hasStat1(db);
        for (const ix of all(db, `PRAGMA index_list(${q(table)})`)) {
          const name = String(ix.name);
          const cols = indexColumns(db, name);
          const origin = String(ix.origin); // c = CREATE INDEX, u = UNIQUE constraint, pk = PRIMARY KEY
          const def = all(db, "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", [name])[0]?.sql;
          const stat = stat1 ? all(db, "SELECT stat FROM sqlite_stat1 WHERE idx = ?", [name])[0]?.stat ?? null : null;
          indexes.push({
            name,
            columns: cols,
            unique: num(ix.unique) === 1,
            primary: origin === "pk",
            sizeBytes: dbstatSize(db, name),
            ...(def ? { definition: String(def) } : {}),
            extra: { origine: origin === "c" ? "CREATE INDEX" : origin === "u" ? "UNIQUE" : "PRIMARY KEY", ...(num(ix.partial) === 1 ? { partiel: true } : {}), ...(stat !== null ? { stat1: stat } : {}) },
          });
          if (origin === "u") constraints.push({ name, kind: "unique", columns: cols });
        }
        const byId = new Map<number, ExploreConstraint>();
        for (const f of all(db, `PRAGMA foreign_key_list(${q(table)})`)) {
          const id = num(f.id) ?? 0;
          const cur = byId.get(id) ?? { name: `fk_${id}`, kind: "fk", columns: [], refObject: String(f.table), refColumns: [], definition: `ON UPDATE ${f.on_update} ON DELETE ${f.on_delete}` };
          cur.columns.push(String(f.from));
          cur.refColumns!.push(f.to === null ? "(rowid)" : String(f.to));
          byId.set(id, cur);
        }
        constraints.push(...byId.values());
        let k = 0;
        for (const chk of (m.sql ?? "").matchAll(/CHECK\s*\(((?:[^()]|\([^()]*\))*)\)/gi)) constraints.push({ name: `check_${k++}`, kind: "check", columns: [], definition: chk[1].trim() });
      }
      const rows = countRows(db, table);
      const st = statSync(file);
      const indexBytes = indexes.reduce<number | null>((acc, i) => (i.sizeBytes === null || i.sizeBytes === undefined ? acc : (acc ?? 0) + i.sizeBytes), null);
      const storage: Record<string, unknown> = {
        lignes: rows,
        taille_octets: isView ? null : dbstatSize(db, table),
        taille_index_octets: isView ? null : indexBytes,
        without_rowid: WITHOUT_ROWID.test(m.sql ?? ""),
        strict: STRICT.test(m.sql ?? ""),
        fichier_octets: st.size,
        fichier_modifie_le: st.mtime.toISOString(),
        analyze_execute: hasStat1(db),
      };
      let sample: Row | null = null;
      try {
        const sr = all(db, `SELECT ${columns.map((x) => q(x.name)).join(", ")} FROM ${q(table)} LIMIT 1`)[0];
        if (sr) sample = truncRow(sr);
      } catch {
        // virtual table without module
      }
      const notes = ["Types = déclarations (affinité SQLite) ; lignes = count(*) exact ; tailles via dbstat quand la compilation l'inclut (sinon null)."];
      if (m.sql) notes.push(`Définition : ${truncateCell(m.sql, 1000)}`);
      return { object: { name: table, kind: isView ? "view" : "table", estRows: rows, sizeBytes: storage.taille_octets as number | null }, columns, indexes, constraints, partitioning: null, storage, sample, notes } satisfies ExploreDescription;
    });
  },

  async browseRows(c, container, object, req) {
    containerOf(container);
    const table = tableOf(object);
    return withDb(c, (db) => browse(db, table, req));
  },

  async columnProfile(c, container, object, column) {
    containerOf(container);
    const table = tableOf(object);
    return withDb(c, (db) => {
      const cols = columnsOf(db, table);
      const col = cols.find((x) => x.name === assertExploreIdent(column, "Colonne"));
      if (!col) throw new Error(`Colonne inconnue : ${column}.`);
      const from = `(SELECT ${q(col.name)} AS v FROM ${q(table)} LIMIT ?) s`;
      const a = all(db, `SELECT count(*) AS n, count(v) AS nn, count(DISTINCT v) AS d, min(v) AS mn, max(v) AS mx FROM ${from}`, [PROFILE_SAMPLE])[0];
      const top = all(db, `SELECT v AS value, count(*) AS n FROM ${from} WHERE v IS NOT NULL GROUP BY v ORDER BY n DESC, v LIMIT 10`, [PROFILE_SAMPLE]);
      const size = Number(a.n);
      return {
        column: col.name,
        sampleSize: size,
        nullPct: size ? Math.round((1000 * (size - Number(a.nn))) / size) / 10 : 0,
        distinct: Number(a.d),
        min: truncateCell(a.mn),
        max: truncateCell(a.mx),
        top: top.map((t) => ({ value: truncateCell(t.value), count: Number(t.n) })),
        notes: [`Type déclaré ${col.type} ; échantillon = premières lignes en ordre de stockage (rowid).`],
      } satisfies ColumnProfile;
    });
  },

  async stats(c) {
    const t0 = Date.now();
    return withDb(c, (db, file) => {
      const sections: StatSection[] = [];
      const safe = (key: string, title: string, fn: () => Row[], extra: Partial<StatSection> = {}) => {
        try {
          sections.push({ key, title, rows: fn(), ...extra });
        } catch (err) {
          sections.push({ key, title, rows: [], unsupported: true, note: err instanceof Error ? err.message : String(err) });
        }
      };
      safe(
        "file",
        "Fichier et pragmas",
        () => {
          const st = statSync(file);
          const pageSize = Number(one(db, "PRAGMA page_size"));
          const pageCount = Number(one(db, "PRAGMA page_count"));
          const freelist = Number(one(db, "PRAGMA freelist_count"));
          const names = ["journal_mode", "auto_vacuum", "encoding", "user_version", "schema_version", "application_id", "cache_size", "mmap_size", "max_page_count"];
          return [
            { metrique: "fichier", valeur: file },
            { metrique: "taille (octets)", valeur: st.size },
            { metrique: "modifié le", valeur: st.mtime.toISOString() },
            { metrique: "page_size × page_count", valeur: `${pageSize} × ${pageCount} = ${pageSize * pageCount}` },
            { metrique: "pages libres (freelist)", valeur: `${freelist} (${pageCount ? Math.round((1000 * freelist) / pageCount) / 10 : 0} %)` },
            ...names.map((n) => ({ metrique: n, valeur: one(db, `PRAGMA ${n}`) as string | number | null })),
            { metrique: "quick_check", valeur: String(one(db, "PRAGMA quick_check")) },
          ];
        },
        { columns: ["metrique", "valeur"], note: "freelist > 10 % : VACUUM récupère l'espace (hors de l'outil, fichier monté en lecture seule)." },
      );
      safe(
        "tables",
        "Tables : lignes, colonnes, index, taille",
        () =>
          all(db, "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => {
            const name = String(t.name);
            const sql = String(t.sql ?? "");
            return { table: name, lignes: countRows(db, name), colonnes: all(db, `PRAGMA table_xinfo(${q(name)})`).length, index: all(db, `PRAGMA index_list(${q(name)})`).length, taille_octets: dbstatSize(db, name), without_rowid: WITHOUT_ROWID.test(sql), strict: STRICT.test(sql) };
          }),
        { columns: ["table", "lignes", "colonnes", "index", "taille_octets", "without_rowid", "strict"], note: "lignes = count(*) exact ; taille via dbstat si disponible." },
      );
      safe(
        "indexes",
        "Index et statistiques ANALYZE (sqlite_stat1)",
        () => {
          const stat1 = hasStat1(db);
          return all(db, "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' ORDER BY tbl_name, name").map((i) => {
            const name = String(i.name);
            return { index: name, table: i.tbl_name, colonnes: indexColumns(db, name).join(", "), auto: i.sql === null, taille_octets: dbstatSize(db, name), stat1: stat1 ? (all(db, "SELECT stat FROM sqlite_stat1 WHERE idx = ?", [name])[0]?.stat ?? null) : null };
          });
        },
        { columns: ["index", "table", "colonnes", "auto", "taille_octets", "stat1"], note: "stat1 vide = ANALYZE jamais exécuté : le planificateur devine. auto = index implicite (PRIMARY KEY / UNIQUE)." },
      );
      safe(
        "no-pk",
        "Tables sans clé primaire déclarée",
        () =>
          all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .filter((t) => !all(db, `PRAGMA table_xinfo(${q(String(t.name))})`).some((x) => (num(x.pk) ?? 0) > 0))
            .map((t) => ({ table: t.name, lignes: countRows(db, String(t.name)) })),
        { columns: ["table", "lignes"], note: "Sans PK, la table repose sur le rowid implicite (renuméroté par VACUUM)." },
      );
      safe(
        "fk-check",
        "Clés étrangères : violations (PRAGMA foreign_key_check)",
        () => all(db, "PRAGMA foreign_key_check").slice(0, 50).map((r) => ({ table: r.table, rowid: r.rowid, parent: r.parent, fkid: r.fkid })),
        { columns: ["table", "rowid", "parent", "fkid"], note: "foreign_keys est OFF par défaut dans SQLite : les violations passent inaperçues à l'écriture. 50 premières." },
      );
      safe(
        "compile",
        "Version et options de compilation (extrait)",
        () => {
          const opts = all(db, "PRAGMA compile_options").map((o) => String(Object.values(o)[0]));
          const keep = opts.filter((o) => /THREADSAFE|ENABLE_(FTS|JSON|RTREE|DBSTAT|MATH)|MAX_|OMIT_|DEFAULT_(WAL|CACHE|PAGE)|TEMP_STORE|COMPILER/.test(o));
          return [{ metrique: "sqlite_version", valeur: String(one(db, "SELECT sqlite_version()")) }, ...keep.map((o) => ({ metrique: o.split("=")[0], valeur: o.includes("=") ? o.split("=").slice(1).join("=") : "oui" }))];
        },
        { columns: ["metrique", "valeur"] },
      );
      return { container: MAIN, sections, durationMs: Date.now() - t0 } satisfies ExploreStats;
    });
  },
};

// Exported for unit tests: composes the browse SQL from the real column list.
export function composeSqliteBrowse(table: string, columns: string[], req: BrowseRequest) {
  return composeBrowse({ quote: q, placeholder: placeholderQuestion, table: q(tableOf(table)), columns, req });
}

function browse(db: Db, table: string, req: BrowseRequest): BrowseResult {
  const t0 = Date.now();
  const cols = columnsOf(db, table);
  const composed = composeSqliteBrowse(table, cols.map((x) => x.name), req);
  const out = all(db, composed.select, composed.params).map(truncRow);
  const total = Number(one(db, composed.count, composed.whereParams) ?? 0);
  return { columns: cols.map((x) => x.name), rows: out, page: req.page, pageSize: req.pageSize, total, totalIsEstimate: false, durationMs: Date.now() - t0 };
}
