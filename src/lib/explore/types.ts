import type { Conn, Row } from "@/lib/drivers/types";

// Explorer contract: "what is inside" an instance, read-only, engine-agnostic.
// One implementation per engine in src/lib/explore/<engine>.ts, registered in index.ts.
// Every call goes through the engine's existing read-only path (READ ONLY transaction,
// access mode READ, read-only token...) with the console timeouts; identifiers are
// validated and quoted, values are always bound parameters.

// A container is the first level of the tree: database, keyspace, bucket, org, vhost, redis db...
export type ExploreContainer = {
  name: string;
  kind?: string; // "database" | "keyspace" | "bucket" | "vhost" | "org" | "db" ...
  sizeBytes?: number | null;
  objectCount?: number | null;
  extra?: Record<string, unknown>; // engine-specific, shown as-is (owner, encoding, retention...)
};

// An object inside a container: table, view, collection, index, measurement, queue, key prefix, S3 prefix...
export type ExploreObject = {
  name: string; // the identifier sent back to describe/browse (e.g. "public.users"); unique within the container
  kind: string; // "table" | "view" | "matview" | "partitioned" | "collection" | "index" | "measurement" | "queue" | "prefix" ...
  estRows?: number | null; // rows / docs / messages / objects, estimated
  sizeBytes?: number | null;
  lastModified?: string | null; // ISO date when the engine knows it
  extra?: Record<string, unknown>;
};

export type ExploreColumn = {
  name: string;
  type: string;
  nullable?: boolean;
  default?: string | null;
  pk?: boolean;
  extra?: Record<string, unknown>; // collation, identity, comment...
};

export type ExploreIndex = {
  name: string;
  columns: string[];
  unique: boolean;
  primary?: boolean;
  sizeBytes?: number | null;
  definition?: string;
  extra?: Record<string, unknown>; // method, scans, valid, ...
};

export type ExploreConstraint = {
  name: string;
  kind: "pk" | "fk" | "unique" | "check" | "exclusion" | "other";
  columns: string[];
  refObject?: string; // "schema.table" for foreign keys
  refColumns?: string[];
  definition?: string;
};

export type ExploreDescription = {
  object: ExploreObject;
  columns: ExploreColumn[];
  indexes: ExploreIndex[];
  constraints: ExploreConstraint[];
  partitioning?: Record<string, unknown> | null; // strategy, key, partitions / shard key...
  storage?: Record<string, unknown>; // size, bloat, dead rows, last vacuum/analyze, compression ratio...
  sample?: Row | null; // one row / document / message, values truncated by the engine
  notes?: string[]; // French, shown under the structure (what is estimated, what is hidden)
};

export const FILTER_OPS = ["=", "!=", "<", "<=", ">", ">=", "like", "is null", "is not null"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export type ExploreFilter = { column: string; op: FilterOp; value?: string };

export type BrowseRequest = {
  page: number; // 1-based
  pageSize: number; // 1..MAX_PAGE_SIZE
  sortColumn?: string;
  sortDir?: "asc" | "desc";
  filters: ExploreFilter[];
};

export type BrowseResult = {
  columns: string[];
  rows: Row[]; // plainRow()-ed: bigint/Date/objects as strings
  page: number;
  pageSize: number;
  total: number | null; // null = unknown
  totalIsEstimate: boolean;
  durationMs: number;
  notes?: string[];
};

export type ColumnProfile =
  | { unsupported: true; reason?: string }
  | {
      unsupported?: false;
      column: string;
      sampleSize: number; // rows actually examined (<= PROFILE_SAMPLE)
      nullPct: number;
      distinct: number | null;
      distinctIsEstimate?: boolean;
      min?: unknown;
      max?: unknown;
      top: { value: unknown; count: number }[]; // up to 10
      notes?: string[];
    };

// Deep stats: a list of titled tables, so the generic UI renders anything.
export type StatSection = {
  key: string;
  title: string; // French
  description?: string;
  columns?: string[];
  rows: Row[];
  unsupported?: boolean; // e.g. pg_stat_statements not installed
  note?: string; // why unsupported, or caveats
};
export type ExploreStats = { container: string | null; sections: StatSection[]; durationMs: number };

export type Explorer = {
  listContainers(conn: Conn): Promise<ExploreContainer[]>;
  listObjects(conn: Conn, container: string): Promise<ExploreObject[]>;
  describeObject(conn: Conn, container: string, object: string): Promise<ExploreDescription>;
  browseRows(conn: Conn, container: string, object: string, req: BrowseRequest): Promise<BrowseResult>;
  columnProfile(conn: Conn, container: string, object: string, column: string): Promise<ColumnProfile>;
  // container optional: engine-wide stats when omitted (or when the engine has a single level).
  stats(conn: Conn, container?: string): Promise<ExploreStats>;
  // What the UI should say about this engine (French, one line each).
  caveats?: string[];
};

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;
export const PROFILE_SAMPLE = 10_000;
export const MAX_FILTERS = 10;
export const CELL_MAX_BYTES = 4096;

export function isFilterOp(s: unknown): s is FilterOp {
  return typeof s === "string" && (FILTER_OPS as readonly string[]).includes(s);
}

// Shape-checks and clamps a browse request coming from the client. Identifiers are NOT
// validated here (each engine has its own rules); only ops, pages and sizes.
export function normalizeBrowseRequest(input: unknown): BrowseRequest {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const int = (v: unknown, def: number) => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isInteger(n) ? n : def;
  };
  const page = Math.max(1, int(o.page, 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, int(o.pageSize, DEFAULT_PAGE_SIZE)));
  const sortColumn = typeof o.sortColumn === "string" && o.sortColumn ? o.sortColumn : undefined;
  const sortDir = o.sortDir === "desc" ? "desc" : "asc";
  const rawFilters = Array.isArray(o.filters) ? o.filters : [];
  if (rawFilters.length > MAX_FILTERS) throw new Error(`Au plus ${MAX_FILTERS} filtres.`);
  const filters: ExploreFilter[] = rawFilters.map((f) => {
    const x = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
    if (typeof x.column !== "string" || !x.column) throw new Error("Filtre : colonne manquante.");
    if (!isFilterOp(x.op)) throw new Error(`Filtre : opérateur inconnu (${String(x.op)}).`);
    const needsValue = x.op !== "is null" && x.op !== "is not null";
    if (needsValue && typeof x.value !== "string") throw new Error(`Filtre ${x.column} ${x.op} : valeur manquante.`);
    if (needsValue && (x.value as string).length > 4096) throw new Error("Filtre : valeur trop longue.");
    return { column: x.column, op: x.op, value: needsValue ? (x.value as string) : undefined };
  });
  return { page, pageSize, sortColumn, sortDir, filters };
}

// Truncates a cell value for transport (strings and serialised objects).
export function truncateCell(v: unknown, max = CELL_MAX_BYTES): unknown {
  if (typeof v === "string" && v.length > max) return v.slice(0, max) + `… [tronqué, ${v.length} caractères]`;
  return v;
}
