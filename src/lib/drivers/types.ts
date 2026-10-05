export type EngineType = "postgres" | "mysql" | "redis";
export const ENGINES: EngineType[] = ["postgres", "mysql", "redis"];
export const ENGINE_LABEL: Record<EngineType, string> = { postgres: "PostgreSQL", mysql: "MySQL / MariaDB", redis: "Redis" };
export const DEFAULT_PORT: Record<EngineType, number> = { postgres: 5432, mysql: 3306, redis: 6379 };

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
