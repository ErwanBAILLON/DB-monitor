// Writes the demo SQLite file used by the sqlite engine testbed (DBMON_SQLITE_SAMPLE).
// Standalone (no TS): node-sqlite3-wasm is resolved from the standalone node_modules.
const path = require("node:path");
const fs = require("node:fs");
const file = process.argv[2];
if (!file) {
  console.error("usage: sqlite-sample.cjs <file>");
  process.exit(2);
}
const { Database } = require("node-sqlite3-wasm");
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.exec(`CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, at TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS visits_at ON visits(at);
         CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
         INSERT OR REPLACE INTO settings VALUES ('created_by', 'db-monitor sample'), ('note', 'read-only demo file');`);
const n = Number(Object.values(db.get("SELECT count(*) AS n FROM visits"))[0]);
if (n === 0) {
  db.exec("BEGIN");
  const stmt = db.prepare("INSERT INTO visits (at, path, status) VALUES (?, ?, ?)");
  for (let i = 0; i < 500; i++) stmt.run([new Date(Date.now() - i * 60_000).toISOString(), ["/", "/app", "/login", "/api/health"][i % 4], i % 17 === 0 ? 500 : 200]);
  stmt.finalize();
  db.exec("COMMIT");
}
db.close();
console.log(`[sqlite-sample] ${file} ready`);
