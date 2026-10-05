import { httpRequest } from "./http";
import { MAX_ROWS, PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS, errorMessage, withTimeout, type Conn, type Probe, type QueryResult, type Row } from "./types";

// InfluxDB 2.x over the HTTP API (8086), token in the instance password, org name in "database".
// Tested against influxdb:2.7 (tests/integration/influxdb.test.ts).

type Json = Record<string, unknown>;
export const CONSOLE_LIMIT = 200;

export async function api<T = Json>(c: Conn, path: string, init: { method?: string; body?: unknown; accept?: string; timeoutMs?: number; raw?: boolean } = {}): Promise<T> {
  const url = new URL(`${c.tls ? "https" : "http"}://${c.host}:${c.port}${path}`);
  const res = await httpRequest({
    url,
    method: init.method ?? "GET",
    headers: { Accept: init.accept ?? "application/json", "Content-Type": "application/json", ...(c.password ? { Authorization: `Token ${c.password}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    timeoutMs: init.timeoutMs ?? PROBE_TIMEOUT_MS,
    insecureTls: c.tls,
  });
  if (res.status >= 400) {
    let reason = res.text.slice(0, 400);
    try {
      const j = JSON.parse(res.text) as { message?: string; code?: string };
      reason = j.message ?? j.code ?? reason;
    } catch {
      // keep raw text
    }
    throw new Error(`HTTP ${res.status}: ${reason}`);
  }
  if (init.raw) return res.text as unknown as T;
  return (res.text ? JSON.parse(res.text) : {}) as T;
}

// "14m15.114803232s", "2h3m4.5s", "1h", "26.3s" (Go duration from /ready) -> seconds.
export function parseGoDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  let total = 0;
  let any = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(h|m|s|ms|µs|us|ns)/g)) {
    any = true;
    const n = Number(m[1]);
    total += { h: 3600, m: 60, s: 1, ms: 1e-3, "µs": 1e-6, us: 1e-6, ns: 1e-9 }[m[2]]! * n;
  }
  return any ? Math.round(total) : undefined;
}

// Pure: /health + /ready + orgs + buckets -> probe fields (unit-tested on fixtures).
export function fromHealth(health: Json, ready: Json, orgs: Json[], buckets: Json[]): Omit<Probe, "up" | "latencyMs"> {
  const userBuckets = buckets.filter((b) => b.type !== "system");
  return {
    version: String(health.version ?? "?").replace(/^v/, ""),
    uptimeSec: parseGoDuration(typeof ready.up === "string" ? ready.up : undefined),
    role: `${health.status ?? "?"} · ${orgs.length} org${orgs.length > 1 ? "s" : ""} · ${userBuckets.length} bucket${userBuckets.length > 1 ? "s" : ""}`,
  };
}

export function retentionLabel(rules: unknown): string {
  const r = Array.isArray(rules) ? (rules[0] as Json | undefined) : undefined;
  const s = Number(r?.everySeconds ?? 0);
  if (!s) return "infini";
  if (s % 86400 === 0) return `${s / 86400} j`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  return `${s} s`;
}

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      (async () => {
        const health = await api(c, "/health");
        const latencyMs = Date.now() - t0;
        const [ready, orgs, buckets] = await Promise.all([api(c, "/ready"), api<{ orgs?: Json[] }>(c, "/api/v2/orgs?limit=100"), api<{ buckets?: Json[] }>(c, "/api/v2/buckets?limit=100")]);
        if (health.status !== "pass") throw new Error(`health: ${health.status} ${health.message ?? ""}`);
        return { up: true, latencyMs, ...fromHealth(health, ready, orgs.orgs ?? [], buckets.buckets ?? []) } satisfies Probe;
      })(),
      PROBE_TIMEOUT_MS + 1000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

// --- Flux ---------------------------------------------------------------------

// Annotated CSV (dialect: datatype annotation, header) -> rows; the leading empty column and
// `result` are dropped, `table` is kept so multi-table outputs stay readable.
export function parseAnnotatedCsv(text: string): { columns: string[]; rows: Row[] } {
  const columns: string[] = [];
  const rows: Row[] = [];
  let header: string[] | null = null;
  let types: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      header = null;
      types = null;
      continue;
    }
    const cells = splitCsv(line);
    if (line.startsWith("#")) {
      if (cells[0] === "#datatype") types = cells;
      continue;
    }
    if (!header) {
      header = cells;
      for (const h of header) if (h && h !== "result" && !columns.includes(h)) columns.push(h);
      continue;
    }
    const o: Row = {};
    header.forEach((h, i) => {
      if (!h || h === "result") return;
      const v = cells[i] ?? "";
      const t = types?.[i] ?? "";
      o[h] = v === "" ? null : /^(long|unsignedLong|double)$/.test(t) ? Number(v) : t === "boolean" ? v === "true" : v;
    });
    rows.push(o);
  }
  return { columns, rows };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export async function flux(c: Conn, org: string, query: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ columns: string[]; rows: Row[] }> {
  const text = await api<string>(c, `/api/v2/query?org=${encodeURIComponent(org)}`, {
    method: "POST",
    accept: "application/csv",
    body: { query, type: "flux", dialect: { annotations: ["datatype"], header: true, delimiter: "," } },
    timeoutMs,
    raw: true,
  });
  return parseAnnotatedCsv(text);
}

export type InfluxDetail = { health: Row; ready: Row; orgs: Row[]; buckets: Row[]; tasks: Row[]; cardinalityNote?: string };

export async function detail(c: Conn): Promise<InfluxDetail> {
  const [health, ready, orgsRes, bucketsRes, tasksRes] = await Promise.all([api(c, "/health"), api(c, "/ready"), api<{ orgs?: Json[] }>(c, "/api/v2/orgs?limit=100"), api<{ buckets?: Json[] }>(c, "/api/v2/buckets?limit=100"), api<{ tasks?: Json[] }>(c, "/api/v2/tasks?limit=100")]);
  const orgById = new Map((orgsRes.orgs ?? []).map((o) => [String(o.id), String(o.name)]));
  const orgs = (orgsRes.orgs ?? []).map((o) => ({ id: o.id, name: o.name, description: o.description ?? "", created: o.createdAt, buckets: (bucketsRes.buckets ?? []).filter((b) => b.orgID === o.id && b.type !== "system").length }));
  // Series cardinality per bucket over the last 30 days (influxdb.cardinality); one Flux call per bucket.
  let cardinalityNote: string | undefined;
  const buckets = await Promise.all(
    (bucketsRes.buckets ?? []).map(async (b) => {
      const org = orgById.get(String(b.orgID)) ?? "";
      let cardinality: number | null = null;
      if (b.type !== "system" && org) {
        try {
          const r = await flux(c, org, `import "influxdata/influxdb"\ninfluxdb.cardinality(bucket: "${String(b.name).replace(/"/g, '\\"')}", start: -30d)`);
          cardinality = Number(r.rows[0]?._value ?? 0);
        } catch (err) {
          cardinalityNote = errorMessage(err);
        }
      }
      return { name: b.name, org, type: b.type, retention: retentionLabel(b.retentionRules), shard_group: (Array.isArray(b.retentionRules) && (b.retentionRules[0] as Json | undefined)?.shardGroupDurationSeconds) || null, cardinality_30d: cardinality, created: b.createdAt, id: b.id };
    }),
  );
  const tasks = await Promise.all(
    (tasksRes.tasks ?? []).map(async (t) => {
      let last: Json | undefined;
      try {
        const runs = await api<{ runs?: Json[] }>(c, `/api/v2/tasks/${t.id}/runs?limit=1`);
        last = runs.runs?.[0];
      } catch {
        // runs may be unavailable
      }
      return { name: t.name, org: t.org, status: t.status, every: t.every ?? null, cron: t.cron ?? null, latest_completed: t.latestCompleted ?? null, last_run_status: last?.status ?? null, last_run_started: last?.startedAt ?? null, last_run_finished: last?.finishedAt ?? null, last_error: Array.isArray(last?.log) ? (last!.log as Json[]).filter((l) => /error|fail/i.test(String(l.message))).map((l) => l.message).slice(-1)[0] ?? null : null, id: t.id };
    }),
  );
  return { health: health as Row, ready: ready as Row, orgs, buckets, tasks, cardinalityNote };
}

// --- read-only Flux console ------------------------------------------------------

export type FluxGuard = { ok: true; flux: string } | { ok: false; reason: string };

// Writes and side effects in Flux are function calls, not statements: refuse `to()`, the
// experimental/http/sql/secrets packages, buckets()/tasks management helpers with side
// effects, and anything that could reach another system. `range()` is required so that an
// unbounded scan cannot be submitted; `limit(n: 200)` is appended.
// Functions are first-class values (`t = to` then `|> t(bucket: ...)`), so the writer
// functions are refused as bare identifiers in any position, not only in call shape. A record
// key (`{to: 1}`) or a field access (`r.to`) stays allowed.
const FLUX_FORBIDDEN = [
  [/(?<![.\w])(to|wideTo)\b(?!\s*:)/, "to()"],
  [/\bexperimental\b/, "experimental.*"],
  [/\bhttp\b/, "http.*"],
  [/\bsql\b/, "sql.*"],
  [/\bsecrets\b/, "secrets"],
  [/\bcontrib\b/, "contrib.*"],
  [/\bbuckets\s*\.\s*(create|delete|update)|\bcreateBucket|\bdeleteBucket/, "gestion des buckets"],
  [/\binfluxdb\s*\.\s*(api|wideTo)\b/, "influxdb.api / wideTo"],
  [/\bmonitor\s*\.\s*(notify|check)\b/, "monitor.notify / check"],
  [/\bslack\b|\bpagerduty\b|\bdiscord\b|\bopsgenie\b|\btelegram\b|\bteams\b|\bsensu\b|\bvictorops\b|\bbigpanda\b|\bzenoss\b|\bservicenow\b|\bmqtt\b|\bkafka\b|\bsmtp\b|\bsendgrid\b|\bmailgun\b|\bwebexteams\b|\bpushbullet\b/, "paquet de notification"],
  [/\bexec\b|\bsystem\s*\.\s*time\s*\(\s*\)\s*\(/, "exécution"],
] as const;

export function guardFlux(input: string): FluxGuard {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "Requête vide." };
  if (raw.length > 10_000) return { ok: false, reason: "Requête trop longue." };
  // Strings and comments in one pass: a "//" inside a string literal is not a comment.
  const stripped = raw.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? ' "" ' : " "));
  if (/"(?!")/.test(stripped.replace(/""/g, ""))) return { ok: false, reason: "Littéral non terminé." };
  for (const [re, label] of FLUX_FORBIDDEN) if (re.test(stripped)) return { ok: false, reason: `Interdit dans la console : ${label}.` };
  // `import "x"` only from the allowlist (strings were stripped: check the raw text).
  for (const m of raw.matchAll(/import\s+"([^"]+)"/g)) {
    if (!/^(strings|regexp|math|date|json|array|dict|types|influxdata\/influxdb(\/schema|\/v1)?|timezone|runtime|sampledata|generate|interpolate|join|profiler|table|timezone|internal\/[a-z]+)$/.test(m[1])) return { ok: false, reason: `Import interdit : ${m[1]}.` };
  }
  if (!/\brange\s*\(/.test(stripped) && !/\b(buckets|schema\.\w+|influxdb\.cardinality|sampledata\.\w+|generate\.from|array\.from|v1\.\w+)\s*\(/.test(stripped)) return { ok: false, reason: "range() est obligatoire (fenêtre temporelle bornée)." }
  return { ok: true, flux: `${raw}\n  |> limit(n: ${CONSOLE_LIMIT})` };
}

export async function readOnlyQuery(c: Conn, query: string, org?: string): Promise<QueryResult> {
  const g = guardFlux(query);
  if (!g.ok) throw new Error(g.reason);
  const o = org ?? c.database ?? "";
  if (!o) throw new Error("Organisation requise (champ base de l'instance ou sélecteur).");
  const t0 = Date.now();
  const { columns, rows } = await flux(c, o, g.flux, QUERY_TIMEOUT_MS);
  const capped = rows.slice(0, MAX_ROWS);
  return { columns, rows: capped, rowCount: rows.length, durationMs: Date.now() - t0, truncated: rows.length > MAX_ROWS };
}
