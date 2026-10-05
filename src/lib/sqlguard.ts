// Read-only query guard for the ad-hoc query action.
// Defense in depth: this parser rejects anything that is not a single
// SELECT/WITH/EXPLAIN/SHOW/VALUES statement, and the executor additionally runs
// it inside `SET TRANSACTION READ ONLY` with statement_timeout (postgres).

const ALLOWED_FIRST = new Set(["select", "with", "explain", "show", "values", "table"]);
// DML/DDL keywords that must not appear anywhere (data-modifying CTEs, EXPLAIN ANALYZE DELETE...).
// Statement starters that cannot legally appear mid-statement (BEGIN, SET...) are not listed:
// they would be a syntax error, and CASE ... END must stay allowed.
const FORBIDDEN = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|call|vacuum|reindex|merge|refresh|listen|notify|discard|prepare|execute|deallocate|import)\b/i;
// Functions with side effects that a READ ONLY transaction does not stop.
const FORBIDDEN_FUNCS = /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_sleep|pg_sleep_for|pg_sleep_until|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|lo_unlink|setval|nextval|dblink\w*|pg_switch_wal|pg_create_restore_point|pg_promote|pg_rotate_logfile|set_config|pg_advisory_\w+|pg_try_advisory_\w+|pg_logical_\w+|pg_create_\w+|pg_drop_\w+|pg_replication_\w+|pg_backup_\w+|sleep|benchmark|load_file)\s*\(/i;

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

function stripLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " '' ") // dollar quotes
    .replace(/'(?:[^']|'')*'/g, " '' ") // strings
    .replace(/"(?:[^"]|"")*"/g, ' "" ') // quoted identifiers
    .replace(/`[^`]*`/g, " `` "); // mysql identifiers
}

export function guardReadOnly(input: string): GuardResult {
  const raw = input.trim().replace(/;\s*$/, "");
  if (!raw) return { ok: false, reason: "Requête vide." };
  if (raw.length > 20_000) return { ok: false, reason: "Requête trop longue." };
  const stripped = stripLiterals(raw);
  if (stripped.includes("/*") || /'(?!')/.test(stripped.replace(/''/g, ""))) return { ok: false, reason: "Littéral non terminé." };
  if (stripped.includes(";")) return { ok: false, reason: "Une seule instruction autorisée." };
  const first = stripped.match(/^\s*\(*\s*([A-Za-z]+)/)?.[1]?.toLowerCase();
  if (!first || !ALLOWED_FIRST.has(first)) return { ok: false, reason: "Seules les requêtes SELECT / WITH / EXPLAIN / SHOW sont autorisées." };
  // Everything after the first keyword: no DML/DDL anywhere (covers data-modifying CTEs,
  // `EXPLAIN ANALYZE DELETE`, `SELECT ... INTO`, `FOR UPDATE`).
  const body = stripped.replace(/^\s*\(*\s*[A-Za-z]+/, "");
  const hit = body.match(FORBIDDEN);
  if (hit) return { ok: false, reason: `Mot-clé interdit : ${hit[1].toUpperCase()}.` };
  const fn = stripped.match(FORBIDDEN_FUNCS);
  if (fn) return { ok: false, reason: `Fonction interdite : ${fn[1]}().` };
  // SELECT ... INTO creates a table (also under EXPLAIN ANALYZE).
  if (/\binto\b/i.test(body)) return { ok: false, reason: "SELECT INTO est interdit." };
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(body)) return { ok: false, reason: "Verrous de lignes interdits." };
  if (first === "explain") {
    // EXPLAIN [( options )] [ANALYZE] [VERBOSE] <statement>: the inner statement must be a read too
    // (ANALYZE executes it).
    const rest = body
      .replace(/^\s*\([^)]*\)/, "")
      .replace(/^(\s*(analyze|analyse|verbose)\b)+/i, "");
    const innerFirst = rest.match(/^\s*\(*\s*([A-Za-z]+)/)?.[1]?.toLowerCase();
    if (!innerFirst || !["select", "with", "values", "table"].includes(innerFirst)) return { ok: false, reason: "EXPLAIN n'est permis que sur un SELECT." };
  }
  return { ok: true, sql: raw };
}
