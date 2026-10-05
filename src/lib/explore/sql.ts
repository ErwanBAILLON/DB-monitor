import { FILTER_OPS, type BrowseRequest, type ExploreFilter, type FilterOp } from "./types";

// Shared SQL composition for relational explorers (Postgres, MySQL, MSSQL, SQLite,
// ClickHouse, Oracle, CockroachDB...). Identifiers are validated against a strict
// pattern AND, when the caller passes the real column list, against it; values are
// never interpolated: they become positional parameters in the engine's placeholder style.

// Letters, digits, _ and $ (PG allows $), max 63/128 chars, must start with a letter or _.
// Dots, quotes, spaces, semicolons, dashes are refused: "id; DROP", "1=1", `a"b` never reach SQL.
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/;

export function assertExploreIdent(s: unknown, what: string): string {
  if (typeof s !== "string" || !IDENT.test(s)) throw new Error(`${what} invalide : « ${String(s).slice(0, 40)} » (lettres, chiffres, _ et $, 128 max, sans point ni espace).`);
  return s;
}

// "schema.table" -> [schema, table]; "table" -> [defaultSchema, table]. Both parts validated.
export function splitQualified(object: string, defaultSchema: string): [string, string] {
  const parts = String(object).split(".");
  if (parts.length === 1) return [assertExploreIdent(defaultSchema, "Schéma"), assertExploreIdent(parts[0], "Objet")];
  if (parts.length === 2) return [assertExploreIdent(parts[0], "Schéma"), assertExploreIdent(parts[1], "Objet")];
  throw new Error(`Objet invalide : « ${object.slice(0, 60)} ».`);
}

export type Quote = (ident: string) => string;
export const quoteDouble: Quote = (s) => `"${s.replace(/"/g, '""')}"`;
export const quoteBacktick: Quote = (s) => `\`${s.replace(/`/g, "``")}\``;
export const quoteBracket: Quote = (s) => `[${s.replace(/]/g, "]]")}]`;

export type Placeholder = (index: number) => string; // 1-based
export const placeholderDollar: Placeholder = (i) => `$${i}`;
export const placeholderQuestion: Placeholder = () => "?";
export const placeholderColon: Placeholder = (i) => `:${i}`; // oracle
export const placeholderAt: Placeholder = (i) => `@p${i}`; // mssql

const SQL_OP: Record<FilterOp, string> = { "=": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=", like: "LIKE", "is null": "IS NULL", "is not null": "IS NOT NULL" };

export type ComposeOptions = {
  quote: Quote;
  placeholder: Placeholder;
  table: string; // already quoted/qualified by the caller, e.g. "public"."users"
  columns: string[]; // real column names: sort/filter columns must be among them
  req: BrowseRequest;
  // How to express a filter column in a comparison: default = quoted identifier. Postgres
  // passes `col::text` for LIKE on non-text types, for instance.
  castForOp?: (quotedColumn: string, op: FilterOp, type: string | undefined) => string;
  columnTypes?: Record<string, string>;
  // LIMIT/OFFSET syntax: default "LIMIT n OFFSET m" as parameters.
  paging?: "limit-offset" | "offset-fetch" | "top";
  // Stable secondary order when no sort column is given (first column by default).
  defaultOrder?: string[];
};

export type Composed = { select: string; count: string; params: unknown[]; where: string; whereParams: unknown[]; offset: number; limit: number };

export function composeBrowse(o: ComposeOptions): Composed {
  const { quote, placeholder, table, columns, req } = o;
  if (!Array.isArray(columns) || columns.length === 0) throw new Error("Objet sans colonnes connues.");
  const known = new Set(columns);
  const whereParts: string[] = [];
  const whereParams: unknown[] = [];
  let i = 0;
  for (const f of req.filters) {
    const col = assertExploreIdent(f.column, "Colonne de filtre");
    if (!known.has(col)) throw new Error(`Colonne de filtre inconnue : ${col}.`);
    if (!(FILTER_OPS as readonly string[]).includes(f.op)) throw new Error(`Opérateur inconnu : ${f.op}.`);
    const q = quote(col);
    const lhs = o.castForOp ? o.castForOp(q, f.op, o.columnTypes?.[col]) : q;
    if (f.op === "is null" || f.op === "is not null") {
      whereParts.push(`${lhs} ${SQL_OP[f.op]}`);
    } else {
      i += 1;
      whereParts.push(`${lhs} ${SQL_OP[f.op]} ${placeholder(i)}`);
      whereParams.push(f.value ?? "");
    }
  }
  const where = whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : "";
  let order: string;
  if (req.sortColumn) {
    const s = assertExploreIdent(req.sortColumn, "Colonne de tri");
    if (!known.has(s)) throw new Error(`Colonne de tri inconnue : ${s}.`);
    order = `${quote(s)} ${req.sortDir === "desc" ? "DESC" : "ASC"}`;
  } else {
    const def = (o.defaultOrder ?? [columns[0]]).map((c) => quote(assertExploreIdent(c, "Colonne de tri")));
    order = def.join(", ");
  }
  const limit = req.pageSize;
  const offset = (req.page - 1) * req.pageSize;
  const cols = columns.map(quote).join(", ");
  const params = [...whereParams];
  let select: string;
  const paging = o.paging ?? "limit-offset";
  if (paging === "limit-offset") {
    params.push(limit, offset);
    select = `SELECT ${cols} FROM ${table}${where} ORDER BY ${order} LIMIT ${placeholder(i + 1)} OFFSET ${placeholder(i + 2)}`;
  } else if (paging === "offset-fetch") {
    params.push(offset, limit);
    select = `SELECT ${cols} FROM ${table}${where} ORDER BY ${order} OFFSET ${placeholder(i + 1)} ROWS FETCH NEXT ${placeholder(i + 2)} ROWS ONLY`;
  } else {
    // "top": engines without OFFSET; the caller slices. limit/offset are plain integers (validated).
    select = `SELECT ${cols} FROM ${table}${where} ORDER BY ${order}`;
  }
  const count = `SELECT count(*) AS n FROM ${table}${where}`;
  return { select, count, params, where, whereParams, offset, limit };
}

// Helper for engines whose LIKE is case-sensitive or needs escaping of the value: none needed
// here because the value is a bound parameter; `%` and `_` are the user's business.
export function describeFilter(f: ExploreFilter): string {
  return f.op === "is null" || f.op === "is not null" ? `${f.column} ${f.op}` : `${f.column} ${f.op} ?`;
}

// Audit-safe summary of a browse request: columns, ops, sort, page; never the values.
export function auditParams(req: BrowseRequest): Record<string, unknown> {
  return { page: req.page, pageSize: req.pageSize, sort: req.sortColumn ? `${req.sortColumn} ${req.sortDir ?? "asc"}` : null, filters: req.filters.map(describeFilter) };
}
