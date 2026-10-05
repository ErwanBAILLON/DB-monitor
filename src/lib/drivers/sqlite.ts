import { statSync, existsSync } from "node:fs";
import path from "node:path";
import { guardReadOnly } from "@/lib/sqlguard";
import { MAX_ROWS, errorMessage, plainRow, type Conn, type Probe, type QueryResult, type Row } from "./types";

// SQLite files mounted into the pod, opened read-only through node-sqlite3-wasm
// (no native build). `Conn.database` is the file path; the file must live under
// one of DBMON_SQLITE_ROOTS (comma-separated directories, chart value sqlite.mounts).
// No write action exists for this engine.

type Db = import("node-sqlite3-wasm").Database;
let mod: typeof import("node-sqlite3-wasm") | undefined;
async function load() {
  // Dynamic require keeps the WASM module out of the Next bundle (serverComponentsExternalPackages).
  mod ??= (await import("node-sqlite3-wasm")) as typeof import("node-sqlite3-wasm");
  return mod;
}

export function roots(spec = process.env.DBMON_SQLITE_ROOTS): string[] {
  return (spec ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

export function resolvePath(file: string | null | undefined, allowed = roots()): string {
  if (!file) throw new Error("Chemin du fichier SQLite requis (champ base).");
  const p = path.resolve(file);
  if (allowed.length === 0) throw new Error("Aucun répertoire SQLite autorisé (DBMON_SQLITE_ROOTS vide : voir helm sqlite.mounts).");
  if (!allowed.some((r) => p === r || p.startsWith(r + path.sep))) throw new Error(`Fichier ${p} hors des répertoires autorisés (${allowed.join(", ")}).`);
  return p;
}

export async function withDb<T>(c: Conn, fn: (db: Db, file: string) => T | Promise<T>): Promise<T> {
  const file = resolvePath(c.database);
  if (!existsSync(file)) throw new Error(`Fichier introuvable : ${file}`);
  const { Database } = await load();
  const db = new Database(file, { readOnly: true, fileMustExist: true });
  try {
    return await fn(db, file);
  } finally {
    db.close();
  }
}

const one = (db: Db, sql: string) => Object.values(db.get(sql) ?? {})[0];

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withDb(c, (db, file) => {
      const latencyMs = Date.now() - t0;
      const pageCount = Number(one(db, "PRAGMA page_count"));
      const pageSize = Number(one(db, "PRAGMA page_size"));
      const quick = String(one(db, "PRAGMA quick_check"));
      const st = statSync(file);
      return {
        up: quick === "ok",
        latencyMs,
        version: `SQLite ${one(db, "SELECT sqlite_version()")}`,
        uptimeSec: Math.round((Date.now() - st.mtimeMs) / 1000),
        sizeBytes: BigInt(st.size),
        memMax: BigInt(pageCount * pageSize),
        role: String(one(db, "PRAGMA journal_mode")),
        error: quick === "ok" ? undefined : `quick_check: ${quick}`,
      } satisfies Probe;
    });
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

export type SqliteDetail = { file: Row; pragmas: Row[]; tables: Row[]; indexes: Row[] };

export async function detail(c: Conn): Promise<SqliteDetail> {
  return withDb(c, (db, file) => {
    const st = statSync(file);
    const names = ["page_size", "page_count", "freelist_count", "journal_mode", "auto_vacuum", "encoding", "user_version", "schema_version", "application_id", "foreign_keys", "synchronous"];
    const pragmas = names.map((name) => ({ name, value: one(db, `PRAGMA ${name}`) as unknown }));
    const tables = (db.all("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name") as Row[]).map((t) => {
      let rows: unknown = null;
      try {
        rows = one(db, `SELECT count(*) FROM "${String(t.name).replace(/"/g, '""')}"`);
      } catch {
        // virtual table without a module, etc.
      }
      const cols = db.all(`PRAGMA table_info("${String(t.name).replace(/"/g, '""')}")`) as Row[];
      return plainRow({ name: t.name, type: t.type, rows, columns: cols.length, column_list: cols.map((x) => `${x.name} ${x.type}`).join(", ").slice(0, 300) });
    });
    const indexes = (db.all("SELECT name, tbl_name AS [table], sql FROM sqlite_master WHERE type = 'index' ORDER BY tbl_name, name") as Row[]).map(plainRow);
    return {
      file: plainRow({ path: file, size_bytes: st.size, modified: st.mtime, readonly_mount: true, integrity: one(db, "PRAGMA quick_check") }),
      pragmas: pragmas.map(plainRow),
      tables,
      indexes,
    };
  });
}

export async function integrityCheck(c: Conn): Promise<Row[]> {
  return withDb(c, (db) => (db.all("PRAGMA integrity_check") as Row[]).map(plainRow));
}

// Read-only console: guard + file opened read-only (SQLITE_OPEN_READONLY, enforced by the library).
export async function readOnlyQuery(c: Conn, sql: string): Promise<QueryResult> {
  const g = guardReadOnly(sql, { allowFirst: ["pragma"] });
  if (!g.ok) throw new Error(g.reason);
  if (/^\s*pragma\s+\w+\s*=/i.test(g.sql)) throw new Error("PRAGMA en écriture interdit.");
  return withDb(c, (db) => {
    const t0 = Date.now();
    const all = db.all(g.sql) as Row[];
    const columns = all.length ? Object.keys(all[0]) : [];
    return { columns, rows: all.slice(0, MAX_ROWS).map(plainRow), rowCount: all.length, durationMs: Date.now() - t0, truncated: all.length > MAX_ROWS };
  });
}

// Sample database for the demo mount (scripts/sqlite-sample.cjs calls this on pod start).
export async function createSample(file: string): Promise<void> {
  const { Database } = await load();
  const db = new Database(file);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, at TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS visits_at ON visits(at);
             CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
             INSERT OR REPLACE INTO settings VALUES ('created_by', 'db-monitor sample'), ('note', 'read-only demo file');`);
    const n = Number(one(db, "SELECT count(*) FROM visits"));
    if (n === 0) {
      db.exec("BEGIN");
      const stmt = db.prepare("INSERT INTO visits (at, path, status) VALUES (?, ?, ?)");
      for (let i = 0; i < 500; i++) stmt.run([new Date(Date.now() - i * 60_000).toISOString(), ["/", "/app", "/login", "/api/health"][i % 4], i % 17 === 0 ? 500 : 200]);
      stmt.finalize();
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
}
