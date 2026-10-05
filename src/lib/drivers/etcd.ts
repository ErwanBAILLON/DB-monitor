import { basicAuth, httpRequest } from "./http";
import { PROBE_TIMEOUT_MS, errorMessage, withTimeout, type Conn, type Probe, type Row } from "./types";

// etcd v3 through the gRPC-gateway (HTTP /v3/*, port 2379), read-only: status, members,
// alarms, key counts. Values are never requested (count_only / keys_only ranges).
// Tested against quay.io/coreos/etcd:v3.5.17 (tests/integration/etcd.test.ts).
// The Kubernetes etcd (client certificates, ns kube-system) is NOT a target: see docs/engines.md.

type Json = Record<string, unknown>;
export const PREFIX_SCAN_CAP = 5000;

export async function call<T = Json>(c: Conn, path: string, body: unknown = {}, timeoutMs = PROBE_TIMEOUT_MS): Promise<T> {
  const url = new URL(`${c.tls ? "https" : "http"}://${c.host}:${c.port}${path}`);
  const res = await httpRequest({ url, method: "POST", headers: { "Content-Type": "application/json", ...basicAuth(c.username, c.password), ...(await authHeader(c, path)) }, body: JSON.stringify(body), timeoutMs, insecureTls: c.tls });
  if (res.status >= 400) {
    let reason = res.text.slice(0, 400);
    try {
      const j = JSON.parse(res.text) as { message?: string; error?: string };
      reason = j.message ?? j.error ?? reason;
    } catch {
      // keep raw text
    }
    throw new Error(`HTTP ${res.status}: ${reason}`);
  }
  return JSON.parse(res.text || "{}") as T;
}

// etcd auth: when a user/password is set, a token is obtained from /v3/auth/authenticate and
// sent as `Authorization: <token>` (the gateway does not accept basic auth).
async function authHeader(c: Conn, path: string): Promise<Record<string, string>> {
  if (!c.username || path === "/v3/auth/authenticate") return {};
  const url = new URL(`${c.tls ? "https" : "http"}://${c.host}:${c.port}/v3/auth/authenticate`);
  const res = await httpRequest({ url, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: c.username, password: c.password ?? "" }), timeoutMs: PROBE_TIMEOUT_MS, insecureTls: c.tls });
  if (res.status >= 400) throw new Error(`etcd auth: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  const token = (JSON.parse(res.text) as { token?: string }).token;
  return token ? { Authorization: token } : {};
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");
// "\0" as key with range_end "\0" = the whole keyspace.
const ALL = { key: b64("\0"), range_end: b64("\0") };

// Pure: status + members + alarms + key count -> probe fields (unit-tested on fixtures).
export function fromStatus(status: Json, members: Json[], alarms: Json[], keyCount: number, quotaBytes?: number): Omit<Probe, "up" | "latencyMs"> {
  const leaderId = String(status.leader ?? "");
  const me = String((status.header as Json | undefined)?.member_id ?? "");
  const leader = members.find((m) => String(m.ID) === leaderId);
  const dbSize = BigInt(String(status.dbSize ?? 0));
  const errors = Array.isArray(status.errors) ? (status.errors as string[]) : [];
  return {
    version: String(status.version ?? "?"),
    sizeBytes: dbSize,
    memMax: quotaBytes ? BigInt(quotaBytes) : undefined,
    connUsed: keyCount,
    role: `${me === leaderId ? "leader" : "follower"} · ${members.length} membre${members.length > 1 ? "s" : ""}${leader ? ` · leader ${leader.name}` : ""}${alarms.length ? ` · ${alarms.length} alarme${alarms.length > 1 ? "s" : ""}` : ""}${errors.length ? ` · ${errors.length} erreur(s)` : ""}`,
  };
}

// Default quota when not configured: 2 GiB (etcd's DefaultQuotaBytes); the "database" field of
// the instance may hold the configured --quota-backend-bytes so that the gauge is right.
export const DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const quotaOf = (c: Conn) => (c.database && /^\d+$/.test(c.database) ? Number(c.database) : DEFAULT_QUOTA_BYTES);

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      (async () => {
        const status = await call(c, "/v3/maintenance/status");
        const latencyMs = Date.now() - t0;
        const [members, alarms, count] = await Promise.all([call<{ members?: Json[] }>(c, "/v3/cluster/member/list"), call<{ alarms?: Json[] }>(c, "/v3/maintenance/alarm", { action: "GET" }), call<{ count?: string }>(c, "/v3/kv/range", { ...ALL, count_only: true })]);
        return { up: true, latencyMs, ...fromStatus(status, members.members ?? [], alarms.alarms ?? [], Number(count.count ?? 0), quotaOf(c)) } satisfies Probe;
      })(),
      PROBE_TIMEOUT_MS + 1000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

// Top-level prefix of a key: "/registry/pods/x" -> "/registry", "foo/a" -> "foo", "bar" -> "bar".
export function topPrefix(key: string): string {
  const m = key.match(/^(\/?[^/]*)/);
  return m?.[1] || key;
}

// Keys only (never values), paginated by `key > last`, capped at PREFIX_SCAN_CAP keys, then
// one count_only range per discovered prefix so the counts are exact even past the cap.
export async function prefixCounts(c: Conn): Promise<{ prefixes: Row[]; scanned: number; capped: boolean }> {
  const prefixes = new Set<string>();
  let scanned = 0;
  let last: string | undefined;
  let capped = false;
  for (;;) {
    const page = await call<{ kvs?: { key: string }[]; more?: boolean }>(c, "/v3/kv/range", { key: last === undefined ? b64("\0") : b64(last + "\0"), range_end: b64("\0"), keys_only: true, limit: 1000 });
    const kvs = page.kvs ?? [];
    for (const kv of kvs) prefixes.add(topPrefix(unb64(kv.key)));
    scanned += kvs.length;
    if (kvs.length) last = unb64(kvs[kvs.length - 1].key);
    if (!page.more || kvs.length === 0) break;
    if (scanned >= PREFIX_SCAN_CAP) {
      capped = true;
      break;
    }
  }
  const rows = await Promise.all(
    [...prefixes].sort().map(async (p) => {
      const r = await call<{ count?: string }>(c, "/v3/kv/range", { key: b64(p), range_end: b64(nextPrefix(p)), count_only: true });
      return { prefix: p, keys: Number(r.count ?? 0) };
    }),
  );
  return { prefixes: rows.sort((a, b) => b.keys - a.keys), scanned, capped };
}

// range_end for "prefix": increment the last byte (etcd's prefix convention).
export function nextPrefix(p: string): string {
  const buf = Buffer.from(p, "utf8");
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] < 0xff) {
      buf[i]++;
      return buf.subarray(0, i + 1).toString("latin1");
    }
  }
  return "\0";
}

export type EtcdDetail = { status: Row; members: Row[]; alarms: Row[]; prefixes: Row[]; scanned: number; capped: boolean; quotaBytes: number; keyCount: number; endpointHealth: Row[] };

export async function detail(c: Conn): Promise<EtcdDetail> {
  const [status, membersRes, alarmsRes, count, scan] = await Promise.all([call(c, "/v3/maintenance/status"), call<{ members?: Json[] }>(c, "/v3/cluster/member/list"), call<{ alarms?: Json[] }>(c, "/v3/maintenance/alarm", { action: "GET" }), call<{ count?: string }>(c, "/v3/kv/range", { ...ALL, count_only: true }), prefixCounts(c)]);
  const leaderId = String(status.leader ?? "");
  const members = (membersRes.members ?? []).map((m) => ({ id: m.ID, name: m.name, leader: String(m.ID) === leaderId, learner: Boolean(m.isLearner), peer_urls: Array.isArray(m.peerURLs) ? (m.peerURLs as string[]).join(", ") : "", client_urls: Array.isArray(m.clientURLs) ? (m.clientURLs as string[]).join(", ") : "" }));
  const alarms = (alarmsRes.alarms ?? []).map((a) => ({ member_id: a.memberID, alarm: a.alarm }));
  const { header, ...rest } = status as Json & { header?: Json };
  const statusRow: Row = { ...rest, member_id: header?.member_id, cluster_id: header?.cluster_id, revision: header?.revision, raft_term_header: header?.raft_term };
  for (const k of Object.keys(statusRow)) if (Array.isArray(statusRow[k])) statusRow[k] = (statusRow[k] as unknown[]).join("; ");
  // Per-member /health is only reachable through each member's client URL: the probe
  // covers the one we talk to; the others are listed with their URLs.
  const endpointHealth: Row[] = [{ endpoint: `${c.host}:${c.port}`, health: "true", from: "/v3/maintenance/status" }];
  return { status: statusRow, members, alarms, prefixes: scan.prefixes, scanned: scan.scanned, capped: scan.capped, quotaBytes: quotaOf(c), keyCount: Number(count.count ?? 0), endpointHealth };
}
