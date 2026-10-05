import Redis from "ioredis";
import { PROBE_TIMEOUT_MS, errorMessage, withTimeout, type Conn, type Probe, type Row } from "./types";

function clientFor(c: Conn): Redis {
  return new Redis({
    host: c.host,
    port: c.port,
    username: c.username || undefined,
    password: c.password || undefined,
    db: c.database ? Number(c.database) : 0,
    tls: c.tls ? { rejectUnauthorized: false } : undefined,
    connectTimeout: PROBE_TIMEOUT_MS,
    commandTimeout: PROBE_TIMEOUT_MS,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
}

export async function withRedis<T>(c: Conn, fn: (r: Redis) => Promise<T>): Promise<T> {
  const r = clientFor(c);
  // ioredis emits 'error' as an event as well as rejecting connect(); without a
  // listener Node logs "Unhandled error event" on every down instance.
  // The first error (e.g. WRONGPASS) is more telling than connect()'s "Connection is closed".
  let firstError: Error | undefined;
  r.on("error", (e: Error) => (firstError ??= e));
  try {
    await r.connect();
  } catch (err) {
    throw firstError ?? err;
  }
  try {
    return await fn(r);
  } finally {
    r.disconnect();
  }
}

export function parseInfo(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = "misc";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("#")) {
      section = line.slice(1).trim().toLowerCase();
      out[section] ??= {};
      continue;
    }
    const i = line.indexOf(":");
    if (i < 0) continue;
    (out[section] ??= {})[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

// Redis-compatible servers advertise themselves differently in INFO server:
// Valkey adds valkey_version (+ server_name), Dragonfly dragonfly_version, KeyDB
// keydb_version; redis_version stays as the compatibility level.
export function flavourOf(server: Record<string, string>): { flavour: string; version: string } {
  if (server.valkey_version) return { flavour: "valkey", version: server.valkey_version };
  if (server.dragonfly_version) return { flavour: "dragonfly", version: server.dragonfly_version.replace(/^df-/, "") };
  if (server.keydb_version) return { flavour: "keydb", version: server.keydb_version };
  if (server.server_name && server.server_name !== "redis") return { flavour: server.server_name, version: server.redis_version ?? "" };
  return { flavour: "redis", version: server.redis_version ?? "" };
}
export const versionLabel = (server: Record<string, string>) => {
  const f = flavourOf(server);
  return f.flavour === "redis" ? f.version : `${f.flavour} ${f.version}`;
};

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      withRedis(c, async (r) => {
        await r.ping();
        const latencyMs = Date.now() - t0;
        const info = parseInfo(await r.info());
        const server = info.server ?? {};
        const clients = info.clients ?? {};
        const memory = info.memory ?? {};
        const repl = info.replication ?? {};
        let connMax: number | undefined;
        try {
          const mc = (await r.config("GET", "maxclients")) as string[];
          connMax = mc?.[1] ? Number(mc[1]) : undefined;
        } catch {
          // CONFIG may be disabled (rename-command); maxclients unknown then.
        }
        return {
          up: true,
          latencyMs,
          version: versionLabel(server),
          uptimeSec: server.uptime_in_seconds ? Number(server.uptime_in_seconds) : undefined,
          connUsed: clients.connected_clients ? Number(clients.connected_clients) : undefined,
          connMax,
          sizeBytes: memory.used_memory ? BigInt(memory.used_memory) : undefined,
          memMax: memory.maxmemory ? BigInt(memory.maxmemory) : undefined,
          role: repl.role,
        } satisfies Probe;
      }),
      PROBE_TIMEOUT_MS + 1000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

export type RedisDetail = {
  info: Record<string, Record<string, string>>;
  keyspace: Row[];
  clients: Row[];
  slowlog: Row[];
};

export async function detail(c: Conn): Promise<RedisDetail> {
  return withRedis(c, async (r) => {
    const info = parseInfo(await r.info());
    const keyspace: Row[] = Object.entries(info.keyspace ?? {}).map(([db, v]) => {
      const o: Row = { db };
      for (const kv of v.split(",")) {
        const [k, val] = kv.split("=");
        o[k] = Number(val);
      }
      return o;
    });
    let clients: Row[] = [];
    try {
      const list = (await r.client("LIST")) as string;
      clients = list
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const o: Row = {};
          for (const kv of line.split(" ")) {
            const i = kv.indexOf("=");
            if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1);
          }
          return o;
        })
        .slice(0, 200);
    } catch {
      // CLIENT may be restricted.
    }
    let slowlog: Row[] = [];
    try {
      const raw = (await r.call("SLOWLOG", "GET", "50")) as unknown[];
      slowlog = raw.map((e) => {
        const [id, ts, micros, cmd, client, name] = e as [number, number, number, string[], string?, string?];
        return { id, at: new Date(ts * 1000).toISOString(), duration_us: micros, command: cmd.join(" ").slice(0, 300), client: client ?? "", name: name ?? "" };
      });
    } catch {
      // SLOWLOG may be restricted.
    }
    return { info, keyspace, clients, slowlog };
  });
}

// SCAN (never KEYS) with a hard cap; returns key, type, ttl.
export async function scanKeys(c: Conn, pattern: string, limit = 200): Promise<Row[]> {
  if (!pattern) pattern = "*";
  if (pattern.length > 200) throw new Error("Motif trop long.");
  return withRedis(c, async (r) => {
    const keys: string[] = [];
    let cursor = "0";
    let iterations = 0;
    do {
      const [next, batch] = await r.scan(cursor, "MATCH", pattern, "COUNT", 200);
      cursor = next;
      keys.push(...batch);
      iterations++;
    } while (cursor !== "0" && keys.length < limit && iterations < 500);
    const subset = keys.slice(0, limit);
    if (subset.length === 0) return [];
    const pipe = r.pipeline();
    for (const k of subset) {
      pipe.type(k);
      pipe.pttl(k);
    }
    const res = (await pipe.exec()) ?? [];
    return subset.map((key, i) => ({ key, type: res[i * 2]?.[1] as string, ttl_ms: res[i * 2 + 1]?.[1] as number }));
  });
}

export async function deleteKey(c: Conn, key: string): Promise<number> {
  if (!key) throw new Error("Clé vide.");
  return withRedis(c, (r) => r.del(key));
}
