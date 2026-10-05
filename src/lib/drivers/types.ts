export type EngineType = "postgres" | "cockroach" | "mysql" | "redis" | "mongodb" | "clickhouse" | "opensearch" | "mssql" | "sqlite" | "cassandra" | "influxdb" | "neo4j" | "etcd";
export const ENGINES: EngineType[] = ["postgres", "cockroach", "mysql", "redis", "mongodb", "clickhouse", "opensearch", "mssql", "sqlite", "cassandra", "influxdb", "neo4j", "etcd"];
// Fleet grouping: databases, caches, message brokers, object stores.
export type EngineCategory = "database" | "cache" | "broker" | "object-store";
export const CATEGORY_LABEL: Record<EngineCategory, string> = { database: "Bases de données", cache: "Caches", broker: "Brokers", "object-store": "Stockage objet" };
export const CATEGORY_ORDER: EngineCategory[] = ["database", "cache", "broker", "object-store"];
export const ENGINE_CATEGORY: Record<EngineType, EngineCategory> = {
  postgres: "database",
  cockroach: "database",
  mysql: "database",
  redis: "cache",
  mongodb: "database",
  clickhouse: "database",
  opensearch: "database",
  mssql: "database",
  sqlite: "database",
  cassandra: "database",
  influxdb: "database",
  neo4j: "database",
  etcd: "database",
};
export const ENGINE_LABEL: Record<EngineType, string> = {
  postgres: "PostgreSQL",
  cockroach: "CockroachDB",
  mysql: "MySQL / MariaDB",
  redis: "Redis-compatible (Redis, Valkey, KeyDB, Dragonfly)",
  mongodb: "MongoDB",
  clickhouse: "ClickHouse",
  opensearch: "OpenSearch / Elasticsearch",
  mssql: "SQL Server",
  sqlite: "SQLite (fichier monté)",
  cassandra: "Cassandra / ScyllaDB",
  influxdb: "InfluxDB 2.x",
  neo4j: "Neo4j 5",
  etcd: "etcd v3 (lecture seule)",
};
export const DEFAULT_PORT: Record<EngineType, number> = {
  postgres: 5432,
  cockroach: 26257,
  mysql: 3306,
  redis: 6379,
  mongodb: 27017,
  clickhouse: 8123,
  opensearch: 9200,
  mssql: 1433,
  sqlite: 0,
  cassandra: 9042,
  influxdb: 8086,
  neo4j: 7687,
  etcd: 2379,
};
// Short badge shown on fleet cards and instance headers.
export const ENGINE_BADGE: Record<EngineType, string> = { postgres: "PG", cockroach: "CR", mysql: "MY", redis: "RD", mongodb: "MG", clickhouse: "CH", opensearch: "OS", mssql: "MS", sqlite: "SQ", cassandra: "CS", influxdb: "IX", neo4j: "NJ", etcd: "ET" };
// Which engines offer a read-only SQL/query console (`query` tab).
export const HAS_CONSOLE: Record<EngineType, boolean> = { postgres: true, cockroach: true, mysql: true, redis: false, mongodb: true, clickhouse: true, opensearch: true, mssql: true, sqlite: true, cassandra: true, influxdb: true, neo4j: true, etcd: false };
// Hint for the "database / path" field of the instance form.
export const DATABASE_HINT: Record<EngineType, string> = {
  postgres: "Base de maintenance (postgres)",
  cockroach: "Base de maintenance (defaultdb)",
  mysql: "Base par défaut (optionnel)",
  redis: "N° de db (0)",
  mongodb: "Base d'authentification (admin)",
  clickhouse: "Base par défaut (default)",
  opensearch: "Préfixe d'URL (optionnel, ex. /es)",
  mssql: "Base par défaut (master)",
  sqlite: "Chemin du fichier .db dans le pod",
  cassandra: "Keyspace par défaut (optionnel)",
  influxdb: "Organisation (nom)",
  neo4j: "Base par défaut (neo4j)",
  etcd: "Quota en octets (--quota-backend-bytes, défaut 2 Gio)",
};
// Label of the size cell: Redis reports used memory, the others a total data size.
export const SIZE_LABEL: Record<EngineType, string> = { postgres: "Taille", cockroach: "Taille", mysql: "Taille", redis: "Mémoire", mongodb: "Taille", clickhouse: "Taille", opensearch: "Taille", mssql: "Taille", sqlite: "Fichier", cassandra: "Taille (estimée)", influxdb: "Taille", neo4j: "Store", etcd: "dbSize" };

// Decrypted connection parameters, built from an Instance row (never persisted).
export type Conn = {
  type: EngineType;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  database?: string | null;
  tls: boolean;
};

// What a probe returns; stored as a Check row.
export type Probe = {
  up: boolean;
  latencyMs: number;
  version?: string;
  uptimeSec?: number;
  connUsed?: number;
  connMax?: number;
  sizeBytes?: bigint;
  memMax?: bigint;
  role?: string;
  error?: string;
};

export type Row = Record<string, unknown>;
export type QueryResult = { columns: string[]; rows: Row[]; rowCount: number; durationMs: number; truncated: boolean };

export const PROBE_TIMEOUT_MS = 5000;
export const QUERY_TIMEOUT_MS = 5000;
export const MAX_ROWS = 500;

export function withTimeout<T>(p: Promise<T>, ms: number, what = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Serialisable rows: bigint and Date to string.
export function plainRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === "bigint") out[k] = v.toString();
    else if (v instanceof Date) out[k] = v.toISOString();
    else if (v !== null && typeof v === "object") out[k] = JSON.stringify(v);
    else out[k] = v;
  }
  return out;
}

// Rows from a result set given as arrays + column names, capped at MAX_ROWS.
export function tabulate(columns: string[], all: unknown[][], t0: number): QueryResult {
  const rows = all.slice(0, MAX_ROWS).map((arr) => {
    const o: Row = {};
    columns.forEach((name, i) => (o[name] = arr[i]));
    return plainRow(o);
  });
  return { columns, rows, rowCount: all.length, durationMs: Date.now() - t0, truncated: all.length > MAX_ROWS };
}
