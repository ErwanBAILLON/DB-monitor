import { basicAuth, httpRequest } from "./http";
import { PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS, errorMessage, plainRow, withTimeout, type Conn, type Probe, type QueryResult, type Row } from "./types";

// OpenSearch / Elasticsearch over the REST API (9200), basic auth, no client library.
// Tested against opensearchproject/opensearch:2.17.0 single node (tests/integration/opensearch.test.ts).

type Json = Record<string, unknown>;

export async function api<T = Json>(c: Conn, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const prefix = (c.database ?? "").replace(/\/$/, "");
  const url = new URL(`${c.tls ? "https" : "http"}://${c.host}:${c.port}${prefix}${path}`);
  const res = await httpRequest({
    url,
    method: init.method ?? "GET",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...basicAuth(c.username, c.password) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    timeoutMs: init.timeoutMs ?? PROBE_TIMEOUT_MS,
    insecureTls: c.tls,
  });
  if (res.status >= 400) {
    let reason = res.text.slice(0, 400);
    try {
      const j = JSON.parse(res.text) as { error?: { reason?: string; type?: string } | string };
      reason = typeof j.error === "string" ? j.error : j.error?.reason ?? j.error?.type ?? reason;
    } catch {
      // keep raw text
    }
    throw new Error(`HTTP ${res.status}: ${reason}`);
  }
  return JSON.parse(res.text) as T;
}

// Pure: root + cluster health + nodes stats -> probe fields (unit-tested on fixtures).
export function fromCluster(root: Json, health: Json, nodesStats: Json): Omit<Probe, "up" | "latencyMs"> {
  const version = root.version as Json | undefined;
  const flavour = version?.distribution === "opensearch" ? "opensearch" : "elasticsearch";
  const nodes = Object.values((nodesStats.nodes as Record<string, Json>) ?? {});
  let uptime: number | undefined;
  let heapMax = 0n;
  let storeBytes = 0n;
  let httpOpen = 0;
  for (const nd of nodes) {
    const jvm = nd.jvm as Json | undefined;
    const mem = jvm?.mem as Json | undefined;
    const u = Number(jvm?.uptime_in_millis);
    if (Number.isFinite(u)) uptime = Math.max(uptime ?? 0, Math.round(u / 1000));
    heapMax += BigInt(Math.round(Number(mem?.heap_max_in_bytes ?? 0)));
    storeBytes += BigInt(Math.round(Number(((nd.indices as Json | undefined)?.store as Json | undefined)?.size_in_bytes ?? 0)));
    httpOpen += Number((nd.http as Json | undefined)?.current_open ?? 0);
  }
  return {
    version: `${flavour} ${version?.number ?? "?"}`,
    uptimeSec: uptime,
    connUsed: httpOpen,
    sizeBytes: storeBytes,
    memMax: heapMax > 0n ? heapMax : undefined,
    role: `${health.status ?? "?"} · ${health.number_of_nodes ?? nodes.length} nœud(s)`,
  };
}

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      (async () => {
        const root = await api(c, "/");
        const latencyMs = Date.now() - t0;
        const [health, stats] = await Promise.all([api(c, "/_cluster/health"), api(c, "/_nodes/stats/jvm,indices,http")]);
        return { up: true, latencyMs, ...fromCluster(root, health, stats) } satisfies Probe;
      })(),
      PROBE_TIMEOUT_MS + 1000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

export type OsDetail = { health: Row; indices: Row[]; nodes: Row[]; pendingTasks: Row[]; tasks: Row[]; shards: Row };

export async function detail(c: Conn): Promise<OsDetail> {
  const [health, indices, nodesStats, nodesInfo, pending, tasks] = await Promise.all([
    api(c, "/_cluster/health"),
    api<Json[]>(c, "/_cat/indices?format=json&bytes=b&h=index,health,status,pri,rep,docs.count,docs.deleted,store.size,pri.store.size,creation.date.string&s=store.size:desc"),
    api(c, "/_nodes/stats/jvm,fs,os,indices,http,thread_pool"),
    api(c, "/_nodes/_all/roles,version"),
    api(c, "/_cluster/pending_tasks"),
    api(c, "/_tasks?actions=*search*,*bulk*,*reindex*&detailed=true").catch(() => ({ nodes: {} }) as Json),
  ]);
  const info = (nodesInfo.nodes as Record<string, Json>) ?? {};
  const nodes = Object.entries((nodesStats.nodes as Record<string, Json>) ?? {}).map(([id, nd]) => {
    const jvm = nd.jvm as Json;
    const mem = jvm?.mem as Json;
    const fs = ((nd.fs as Json)?.total as Json) ?? {};
    const os = nd.os as Json;
    const search = ((nd.thread_pool as Json)?.search as Json) ?? {};
    const write = ((nd.thread_pool as Json)?.write as Json) ?? {};
    return plainRow({
      name: nd.name,
      roles: ((info[id]?.roles as string[]) ?? []).join(","),
      version: info[id]?.version,
      heap_used_bytes: mem?.heap_used_in_bytes,
      heap_max_bytes: mem?.heap_max_in_bytes,
      heap_pct: mem?.heap_used_percent,
      disk_total_bytes: fs.total_in_bytes,
      disk_free_bytes: fs.free_in_bytes,
      cpu_pct: (os?.cpu as Json)?.percent,
      load_1m: ((os?.cpu as Json)?.load_average as Json)?.["1m"],
      docs: ((nd.indices as Json)?.docs as Json)?.count,
      store_bytes: ((nd.indices as Json)?.store as Json)?.size_in_bytes,
      http_open: (nd.http as Json)?.current_open,
      search_queue: search.queue,
      search_rejected: search.rejected,
      write_rejected: write.rejected,
      uptime_s: Math.round(Number(jvm?.uptime_in_millis ?? 0) / 1000),
    });
  });
  const taskRows: Row[] = [];
  for (const nd of Object.values((tasks.nodes as Record<string, Json>) ?? {})) {
    for (const [id, t] of Object.entries((nd.tasks as Record<string, Json>) ?? {})) taskRows.push(plainRow({ id, node: nd.name, action: t.action, running_ms: Math.round(Number(t.running_time_in_nanos ?? 0) / 1e6), cancellable: t.cancellable, description: String(t.description ?? "").slice(0, 300) }));
  }
  return {
    health: plainRow({ status: health.status, cluster: health.cluster_name, nodes: health.number_of_nodes, data_nodes: health.number_of_data_nodes, active_shards: health.active_shards, primary_shards: health.active_primary_shards, relocating: health.relocating_shards, initializing: health.initializing_shards, unassigned: health.unassigned_shards, pending_tasks: health.number_of_pending_tasks, active_shards_pct: health.active_shards_percent_as_number }),
    shards: plainRow({ active: health.active_shards, unassigned: health.unassigned_shards, relocating: health.relocating_shards, initializing: health.initializing_shards }),
    indices: indices.map((i) => plainRow({ index: i.index, health: i.health, status: i.status, pri: i.pri, rep: i.rep, docs: i["docs.count"], deleted: i["docs.deleted"], size_bytes: i["store.size"], primary_size_bytes: i["pri.store.size"], created: i["creation.date.string"] })),
    nodes,
    pendingTasks: ((pending.tasks as Json[]) ?? []).map((t) => plainRow({ order: t.insert_order, priority: t.priority, source: t.source, in_queue: t.time_in_queue })),
    tasks: taskRows.sort((a, b) => Number(b.running_ms) - Number(a.running_ms)).slice(0, 100),
  };
}

// --- read-only console: a search body against one index --------------------------
const MAX_SIZE = 100;
const INDEX = /^[a-z0-9][a-z0-9_.*,-]{0,254}$/;

export function guardSearch(index: string, bodyText: string): { ok: true; index: string; body: Json } | { ok: false; reason: string } {
  if (!INDEX.test(index) || index.startsWith(".")) return { ok: false, reason: "Index invalide (minuscules, chiffres, _ . - *, pas d'index système)." };
  if (bodyText.length > 20_000) return { ok: false, reason: "Requête trop longue." };
  let body: Json;
  try {
    body = bodyText.trim() ? JSON.parse(bodyText) : {};
  } catch {
    return { ok: false, reason: "JSON invalide." };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "Un objet JSON est attendu." };
  const size = body.size === undefined ? 20 : Number(body.size);
  if (!Number.isInteger(size) || size < 0 || size > MAX_SIZE) return { ok: false, reason: `size : entier entre 0 et ${MAX_SIZE}.` };
  if ("script" in body || JSON.stringify(body).includes('"script"')) return { ok: false, reason: "Les scripts (script, script_fields, script_score) sont interdits." };
  return { ok: true, index, body: { ...body, size } };
}

export async function search(c: Conn, index: string, bodyText: string): Promise<QueryResult> {
  const g = guardSearch(index, bodyText);
  if (!g.ok) throw new Error(g.reason);
  const t0 = Date.now();
  const r = await api(c, `/${encodeURIComponent(g.index)}/_search?timeout=${QUERY_TIMEOUT_MS}ms&allow_partial_search_results=true`, { method: "POST", body: g.body, timeoutMs: QUERY_TIMEOUT_MS + 1000 });
  const hits = ((r.hits as Json)?.hits as Json[]) ?? [];
  const total = (r.hits as Json)?.total as Json | number | undefined;
  const cols = new Set<string>(["_index", "_id", "_score"]);
  for (const h of hits) for (const k of Object.keys((h._source as Json) ?? {})) cols.add(k);
  const columns = [...cols].slice(0, 60);
  const rows = hits.map((h) => {
    const o: Row = { _index: h._index, _id: h._id, _score: h._score };
    const src = (h._source as Json) ?? {};
    for (const k of columns) if (!(k in o)) o[k] = src[k] === undefined ? null : src[k];
    return plainRow(o);
  });
  const aggs = r.aggregations ? [plainRow({ _index: "aggregations", _id: "", _score: null, aggregations: r.aggregations })] : [];
  return { columns: aggs.length ? [...columns, "aggregations"] : columns, rows: [...rows, ...aggs], rowCount: typeof total === "number" ? total : Number((total as Json)?.value ?? hits.length), durationMs: Date.now() - t0, truncated: false };
}
