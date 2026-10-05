import { basicAuth, httpRequest } from "./http";
import { PROBE_TIMEOUT_MS, errorMessage, withTimeout, type Conn, type Probe, type Row } from "./types";

// RabbitMQ over the management HTTP API (15672), basic auth, read-only (GET only).
// Tested against rabbitmq:3.13-management-alpine (tests/integration/rabbitmq.test.ts).

type Json = Record<string, unknown>;

export async function api<T = Json>(c: Conn, path: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<T> {
  const prefix = (c.database ?? "").replace(/\/$/, "");
  const url = new URL(`${c.tls ? "https" : "http"}://${c.host}:${c.port}${prefix}${path}`);
  const res = await httpRequest({ url, method: "GET", headers: { Accept: "application/json", ...basicAuth(c.username, c.password) }, timeoutMs, insecureTls: c.tls });
  if (res.status >= 400) {
    let reason = res.text.slice(0, 300);
    try {
      const j = JSON.parse(res.text) as { error?: string; reason?: string };
      reason = [j.error, j.reason].filter(Boolean).join(": ") || reason;
    } catch {
      // keep raw text
    }
    throw new Error(`HTTP ${res.status}: ${reason}`);
  }
  return JSON.parse(res.text || "null") as T;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

// Pure: /api/overview + /api/nodes -> probe fields (unit-tested on fixtures).
export function fromOverview(overview: Json, nodes: Json[]): Omit<Probe, "up" | "latencyMs"> {
  const totals = (overview.object_totals as Json | undefined) ?? {};
  const uptimeMs = Math.max(0, ...nodes.map((n) => num(n.uptime)));
  const memUsed = nodes.reduce((s, n) => s + BigInt(Math.round(num(n.mem_used))), 0n);
  const memLimit = nodes.reduce((s, n) => s + BigInt(Math.round(num(n.mem_limit))), 0n);
  const alarms: string[] = [];
  for (const n of nodes) {
    if (n.mem_alarm) alarms.push(`mémoire ${n.name ?? ""}`.trim());
    if (n.disk_free_alarm) alarms.push(`disque ${n.name ?? ""}`.trim());
    if (n.running === false) alarms.push(`${n.name ?? "nœud"} arrêté`);
  }
  const socketsTotal = nodes.reduce((s, n) => s + num(n.sockets_total), 0);
  return {
    version: `${overview.rabbitmq_version ?? overview.product_version ?? "?"} · erlang ${String(overview.erlang_version ?? "?").split(" ")[0]}`,
    uptimeSec: nodes.length ? Math.round(uptimeMs / 1000) : undefined,
    connUsed: num(totals.connections),
    connMax: socketsTotal || undefined,
    sizeBytes: memUsed,
    memMax: memLimit > 0n ? memLimit : undefined,
    role: `${nodes.length} nœud${nodes.length > 1 ? "s" : ""} · ${num(totals.queues)} file${num(totals.queues) > 1 ? "s" : ""} · ${num(totals.consumers)} consommateur${num(totals.consumers) > 1 ? "s" : ""}${alarms.length ? ` · alarme ${alarms.join(", ")}` : ""}`,
  };
}

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      (async () => {
        const overview = await api(c, "/api/overview");
        const latencyMs = Date.now() - t0;
        const nodes = await api<Json[]>(c, "/api/nodes");
        return { up: true, latencyMs, ...fromOverview(overview, nodes) } satisfies Probe;
      })(),
      PROBE_TIMEOUT_MS + 1000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

export type RmqDetail = { overview: Row; totals: Row; nodes: Row[]; queues: Row[]; queuesTotal: number; connections: Row[]; channels: Row[]; vhosts: Row[]; exchanges: Row[] };

const QUEUE_COLUMNS = "name,vhost,type,state,durable,auto_delete,messages,messages_ready,messages_unacknowledged,consumers,memory,message_bytes,node,policy,idle_since";

export async function detail(c: Conn): Promise<RmqDetail> {
  const [overview, nodes, queuesPage, connections, channels, vhosts, exchanges] = await Promise.all([
    api(c, "/api/overview"),
    api<Json[]>(c, "/api/nodes"),
    api<{ items?: Json[]; total_count?: number }>(c, `/api/queues?page=1&page_size=200&sort=messages&sort_reverse=true&columns=${QUEUE_COLUMNS}`),
    api<Json[]>(c, "/api/connections?columns=name,user,vhost,state,protocol,channels,peer_host,peer_port,client_properties.connection_name,connected_at,recv_oct,send_oct,node"),
    api<Json[]>(c, "/api/channels?columns=name,user,vhost,state,number,consumer_count,messages_unacknowledged,messages_unconfirmed,prefetch_count,connection_details.name,node"),
    api<Json[]>(c, "/api/vhosts?columns=name,messages,messages_ready,messages_unacknowledged,description,tags"),
    api<Json[]>(c, "/api/exchanges?columns=name,vhost,type,durable,auto_delete,internal"),
  ]);
  const flat = (o: Json): Row => {
    const out: Row = {};
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v as Json)) out[`${k}.${k2}`] = Array.isArray(v2) || (v2 && typeof v2 === "object") ? JSON.stringify(v2) : (v2 as unknown);
      else out[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    return out;
  };
  const totals = { ...((overview.object_totals as Json | undefined) ?? {}), ...((overview.queue_totals as Json | undefined) ?? {}) };
  const ov: Row = { rabbitmq_version: overview.rabbitmq_version, erlang_version: overview.erlang_version, cluster_name: overview.cluster_name, node: overview.node, management_version: overview.management_version, rates_mode: overview.rates_mode, statistics_db_event_queue: overview.statistics_db_event_queue };
  const nodeRows = nodes.map((n) => ({ name: n.name, running: n.running, uptime_s: Math.round(num(n.uptime) / 1000), mem_used: n.mem_used, mem_limit: n.mem_limit, mem_alarm: n.mem_alarm, disk_free: n.disk_free, disk_free_limit: n.disk_free_limit, disk_free_alarm: n.disk_free_alarm, fd_used: n.fd_used, fd_total: n.fd_total, sockets_used: n.sockets_used, sockets_total: n.sockets_total, proc_used: n.proc_used, proc_total: n.proc_total, run_queue: n.run_queue, processors: n.processors, partitions: Array.isArray(n.partitions) ? (n.partitions as string[]).join(", ") : "" }));
  return {
    overview: ov,
    totals,
    nodes: nodeRows,
    queues: (queuesPage.items ?? []).map(flat),
    queuesTotal: num(queuesPage.total_count),
    connections: connections.map(flat),
    channels: channels.map(flat),
    vhosts: vhosts.map(flat),
    exchanges: exchanges.filter((e) => e.name !== "").map(flat),
  };
}
