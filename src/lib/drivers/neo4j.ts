import neo4j, { type Driver, type Record as NeoRecord } from "neo4j-driver";
import { PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS, errorMessage, withTimeout, type Conn, type Probe, type QueryResult, type Row } from "./types";

// Neo4j 5 over Bolt (7687) with the official driver.
// Tested against neo4j:5 community (tests/integration/neo4j.test.ts).
// One short-lived driver per call (the checker probes every 30 s; a kept pool would hold a
// Bolt connection + routing table per instance).

export const CONSOLE_LIMIT = 200;

export async function withDriver<T>(c: Conn, fn: (d: Driver) => Promise<T>): Promise<T> {
  const scheme = c.tls ? "bolt+ssc" : "bolt";
  const d = neo4j.driver(`${scheme}://${c.host}:${c.port}`, c.username ? neo4j.auth.basic(c.username, c.password ?? "") : undefined, {
    connectionTimeout: PROBE_TIMEOUT_MS,
    connectionAcquisitionTimeout: PROBE_TIMEOUT_MS,
    maxConnectionPoolSize: 8,
    disableLosslessIntegers: true,
    userAgent: "db-monitor",
  });
  try {
    return await fn(d);
  } finally {
    await d.close().catch(() => undefined);
  }
}

export function recordRow(r: NeoRecord): Row {
  const o: Row = {};
  for (const k of r.keys) o[String(k)] = neoValue(r.get(k));
  return o;
}

export function neoValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (neo4j.isInt(v)) return (v as { toNumber: () => number }).toNumber();
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(neoValue);
  if (neo4j.isNode(v)) {
    const n = v as { labels: string[]; properties: Record<string, unknown>; elementId: string };
    return `(${n.labels.map((l) => `:${l}`).join("")} ${JSON.stringify(n.properties)})`;
  }
  if (neo4j.isRelationship(v)) {
    const r = v as { type: string; properties: Record<string, unknown> };
    return `[:${r.type} ${JSON.stringify(r.properties)}]`;
  }
  if (neo4j.isPath(v)) return "<path>";
  if (neo4j.isDuration(v) || neo4j.isDate(v) || neo4j.isDateTime(v) || neo4j.isLocalDateTime(v) || neo4j.isLocalTime(v) || neo4j.isTime(v) || neo4j.isPoint(v)) return String(v);
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

// One read query on a database, in an explicit READ transaction with a server-side timeout.
export async function readQuery(d: Driver, cypher: string, params: Record<string, unknown> = {}, opts: { database?: string; timeoutMs?: number; max?: number } = {}): Promise<Row[]> {
  const session = d.session({ defaultAccessMode: neo4j.session.READ, database: opts.database || "neo4j" });
  try {
    // Tagged so that the transactions tab can hide the console's own parallel reads.
    const tx = await session.beginTransaction({ timeout: opts.timeoutMs ?? PROBE_TIMEOUT_MS, metadata: { app: "db-monitor" } });
    try {
      const res = await tx.run(cypher, params);
      const rows = res.records.slice(0, opts.max ?? Infinity).map(recordRow);
      await tx.commit();
      return rows;
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }
  } finally {
    await session.close();
  }
}

// `system` database commands (SHOW DATABASES, SHOW TRANSACTIONS...) also run in READ mode.
const sys = (d: Driver, cypher: string, params: Record<string, unknown> = {}) => readQuery(d, cypher, params, { database: "system" });

async function tryRows(p: Promise<Row[]>): Promise<Row[] | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

// Pure: dbms.components + SHOW DATABASES + JMX runtime + connections -> probe (unit-tested on fixtures).
export function fromComponents(components: Row[], databases: Row[], jvmUptimeMs: number | undefined, connections: number | undefined, maxThreads: number | undefined): Omit<Probe, "up" | "latencyMs"> {
  const kernel = components.find((c) => c.name === "Neo4j Kernel") ?? components[0] ?? {};
  const versions = Array.isArray(kernel.versions) ? (kernel.versions as unknown[]) : [];
  const user = databases.filter((db) => db.name !== "system");
  const offline = user.filter((db) => db.currentStatus && db.currentStatus !== "online");
  return {
    version: `${versions[0] ?? "?"} ${String(kernel.edition ?? "").toLowerCase()}`.trim(),
    uptimeSec: jvmUptimeMs !== undefined && Number.isFinite(jvmUptimeMs) ? Math.round(jvmUptimeMs / 1000) : undefined,
    connUsed: connections,
    connMax: maxThreads,
    role: `${user.length} base${user.length > 1 ? "s" : ""}${offline.length ? ` · ${offline.length} hors ligne` : ""}${user.some((db) => db.role && db.role !== "primary") ? " · " + [...new Set(user.map((db) => String(db.role)))].join("/") : ""}`,
  };
}

export async function probe(c: Conn): Promise<Probe> {
  const t0 = Date.now();
  try {
    return await withTimeout(
      withDriver(c, async (d) => {
        await d.verifyConnectivity();
        const latencyMs = Date.now() - t0;
        const [components, databases, jmx, conns, cfg] = await Promise.all([
          sys(d, "CALL dbms.components() YIELD name, versions, edition RETURN name, versions, edition"),
          sys(d, "SHOW DATABASES YIELD name, currentStatus, role, default, home RETURN name, currentStatus, role, default, home"),
          tryRows(sys(d, 'CALL dbms.queryJmx("java.lang:type=Runtime") YIELD attributes RETURN attributes.Uptime.value AS uptime')),
          tryRows(sys(d, "CALL dbms.listConnections() YIELD connectionId RETURN count(*) AS n")),
          tryRows(sys(d, 'SHOW SETTINGS YIELD name, value WHERE name = "server.bolt.thread_pool_max_size" RETURN value')),
        ]);
        const sizes = await storeSizes(d, databases.filter((db) => db.name !== "system").map((db) => String(db.name)));
        const sizeBytes = sizes.reduce((s, x) => s + BigInt(Math.round(Number(x.size_bytes ?? 0))), 0n);
        return {
          up: true,
          latencyMs,
          ...fromComponents(components, databases, jmx?.[0]?.uptime === undefined || jmx[0].uptime === null ? undefined : Number(jmx[0].uptime), conns ? Number(conns[0]?.n) : undefined, cfg?.[0]?.value ? Number(cfg[0].value) : undefined),
          ...(sizes.some((x) => x.size_bytes !== null) ? { sizeBytes } : {}),
        } satisfies Probe;
      }),
      PROBE_TIMEOUT_MS + 2000,
      "probe",
    );
  } catch (err) {
    return { up: false, latencyMs: Date.now() - t0, error: errorMessage(err) };
  }
}

// Store size per database: metrics beans are Enterprise-only (neo4j.metrics:name=neo4j.<db>.store.size.total);
// on Community the value stays null and the UI says so.
export async function storeSizes(d: Driver, names: string[]): Promise<{ name: string; size_bytes: number | null }[]> {
  return Promise.all(
    names.map(async (name) => {
      const r = await tryRows(sys(d, `CALL dbms.queryJmx("neo4j.metrics:name=neo4j.${name}.store.size.total") YIELD attributes RETURN attributes.Value.value AS v`));
      const v = r?.[0]?.v;
      return { name, size_bytes: v === undefined || v === null ? null : Number(v) };
    }),
  );
}

export type NeoDetail = { components: Row[]; databases: Row[]; transactions: Row[]; counts: { nodes: number; relationships: number; labels: Row[]; relTypes: Row[] }; indexes: Row[]; constraints: Row[]; connections: Row[]; sizesAvailable: boolean };

export async function detail(c: Conn): Promise<NeoDetail> {
  return withDriver(c, async (d) => {
    const db = c.database || "neo4j";
    const [components, databases, transactions, indexes, constraints, connections, labels, relTypes, nodes, rels] = await Promise.all([
      sys(d, "CALL dbms.components() YIELD name, versions, edition RETURN name, versions, edition"),
      sys(d, "SHOW DATABASES YIELD name, type, aliases, access, address, role, currentStatus, statusMessage, default, home RETURN *"),
      sys(d, "SHOW TRANSACTIONS YIELD transactionId, database, username, currentQuery, status, elapsedTime, startTime, clientAddress, currentQueryAllocatedBytes, pageHits, pageFaults, metaData WHERE metaData.app IS NULL OR metaData.app <> 'db-monitor' RETURN transactionId, database, username, currentQuery, status, elapsedTime, startTime, clientAddress, currentQueryAllocatedBytes, pageHits, pageFaults"),
      readQuery(d, "SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state, populationPercent, owningConstraint RETURN *", {}, { database: db }),
      readQuery(d, "SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties RETURN *", {}, { database: db }),
      tryRows(sys(d, "CALL dbms.listConnections() YIELD connectionId, connectTime, connector, username, userAgent, serverAddress, clientAddress RETURN *")),
      readQuery(d, "CALL db.labels() YIELD label CALL { WITH label MATCH (n) WHERE label IN labels(n) RETURN count(n) AS n } RETURN label, n ORDER BY n DESC LIMIT 100", {}, { database: db, timeoutMs: QUERY_TIMEOUT_MS }).catch(() => [] as Row[]),
      readQuery(d, "CALL db.relationshipTypes() YIELD relationshipType CALL { WITH relationshipType MATCH ()-[r]->() WHERE type(r) = relationshipType RETURN count(r) AS n } RETURN relationshipType, n ORDER BY n DESC LIMIT 100", {}, { database: db, timeoutMs: QUERY_TIMEOUT_MS }).catch(() => [] as Row[]),
      readQuery(d, "MATCH (n) RETURN count(n) AS n", {}, { database: db }),
      readQuery(d, "MATCH ()-[r]->() RETURN count(r) AS n", {}, { database: db }),
    ]);
    const sizes = await storeSizes(d, databases.filter((x) => x.name !== "system").map((x) => String(x.name)));
    const sizeBy = new Map(sizes.map((s) => [s.name, s.size_bytes]));
    return {
      components,
      databases: databases.map((x) => ({ ...x, store_size_bytes: sizeBy.get(String(x.name)) ?? null })),
      transactions: transactions.map((t) => ({ ...t, elapsedTime: typeof t.elapsedTime === "string" ? t.elapsedTime : String(t.elapsedTime ?? "") })),
      counts: { nodes: Number(nodes[0]?.n ?? 0), relationships: Number(rels[0]?.n ?? 0), labels, relTypes },
      indexes,
      constraints,
      connections: connections ?? [],
      sizesAvailable: sizes.some((s) => s.size_bytes !== null),
    };
  });
}

export async function terminateTransaction(c: Conn, transactionId: string): Promise<string> {
  if (!/^[\w-]{1,128}$/.test(transactionId)) throw new Error("transactionId invalide.");
  return withDriver(c, async (d) => {
    // TERMINATE TRANSACTIONS is an administration command on `system`; it needs a WRITE session.
    const session = d.session({ database: "system", defaultAccessMode: neo4j.session.WRITE });
    try {
      const res = await session.run("TERMINATE TRANSACTIONS $id YIELD transactionId, username, message RETURN *", { id: transactionId });
      const row = res.records[0] ? recordRow(res.records[0]) : undefined;
      return String(row?.message ?? "no such transaction");
    } finally {
      await session.close();
    }
  });
}

// --- read-only Cypher console ----------------------------------------------------

export type CypherGuard = { ok: true; cypher: string } | { ok: false; reason: string };

// Writers refused anywhere (the READ access mode makes the server refuse them as well,
// this is the first barrier and gives a clear message). CALL is allowed only for `db.*`
// read procedures and `dbms.components/listConfig/queryJmx`; `dbms.*` administration and
// any `apoc.*` are refused (apoc.load/export/periodic/cypher.run* write or reach outside).
const CYPHER_FORBIDDEN = /\b(create|merge|delete|detach|set|remove|drop|foreach|load\s+csv|alter|grant|deny|revoke|start\s+database|stop\s+database|terminate|using\s+periodic\s+commit|call\s*\{[\s\S]*\bin\s+transactions)\b/i;
const CALL_ALLOWED = /^(db\.(labels|relationshipTypes|propertyKeys|schema\.\w+|info|ping|stats\.retrieve|index\.fulltext\.queryNodes|index\.fulltext\.queryRelationships|index\.vector\.queryNodes|index\.vector\.queryRelationships)|dbms\.(components|listConfig|queryJmx|showCurrentUser|info|listConnections)|tx\.getMetaData)$/i;

export function guardCypher(input: string): CypherGuard {
  const raw = input.trim().replace(/;\s*$/, "");
  if (!raw) return { ok: false, reason: "Requête vide." };
  if (raw.length > 10_000) return { ok: false, reason: "Requête trop longue." };
  const stripped = raw.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("/") ? " " : " '' "));
  if (/['"](?!['"])/.test(stripped.replace(/''/g, ""))) return { ok: false, reason: "Littéral non terminé." };
  if (stripped.includes(";")) return { ok: false, reason: "Une seule instruction autorisée." };
  const noIdent = stripped.replace(/`[^`]*`/g, " `` ");
  const hit = noIdent.match(CYPHER_FORBIDDEN);
  if (hit) return { ok: false, reason: `Mot-clé interdit : ${hit[1].toUpperCase().replace(/\s+/g, " ")}.` };
  for (const m of noIdent.matchAll(/\bcall\s+([\w.]+)\s*(\(|yield|$)/gi)) {
    if (!CALL_ALLOWED.test(m[1])) return { ok: false, reason: `Procédure interdite : ${m[1]} (seules les procédures de lecture db.* / dbms.components|listConfig|queryJmx sont admises).` };
  }
  if (/\bapoc\./i.test(noIdent)) return { ok: false, reason: "apoc.* n'est pas admis dans la console." };
  if (/^\s*(show|use)\b/i.test(noIdent)) return { ok: false, reason: "SHOW / USE : utilisez les onglets dédiés (SHOW TRANSACTIONS, SHOW INDEXES...)." };
  if (!/^\s*(match|optional|with|return|unwind|call|profile|explain)\b/i.test(noIdent)) return { ok: false, reason: "La requête doit commencer par MATCH / OPTIONAL MATCH / WITH / UNWIND / RETURN / CALL (lecture)." };
  // LIMIT: cap an existing trailing one (comments ignored), append after a final RETURN otherwise.
  let cypher = raw;
  const trailing = noIdent.match(/\blimit\s+(\d+)\s*$/i);
  const lastReturn = noIdent.search(/\breturn\b(?![\s\S]*\breturn\b)/i);
  if (trailing) {
    if (Number(trailing[1]) > CONSOLE_LIMIT) {
      const last = [...raw.matchAll(/\blimit\s+\d+/gi)].pop()!;
      cypher = `${raw.slice(0, last.index)}LIMIT ${CONSOLE_LIMIT}${raw.slice(last.index! + last[0].length)}`;
    }
  } else if (lastReturn >= 0 && !/\blimit\b/i.test(noIdent.slice(lastReturn))) {
    cypher = `${raw}\nLIMIT ${CONSOLE_LIMIT}`;
  }
  return { ok: true, cypher };
}

export async function readOnlyQuery(c: Conn, cypher: string, database?: string): Promise<QueryResult> {
  const g = guardCypher(cypher);
  if (!g.ok) throw new Error(g.reason);
  const db = database ?? c.database ?? "neo4j";
  if (!/^[\w.-]{1,63}$/.test(db)) throw new Error("Nom de base invalide.");
  if (db === "system") throw new Error("La base system n'est pas consultable depuis la console.");
  const t0 = Date.now();
  return withDriver(c, async (d) => {
    const session = d.session({ defaultAccessMode: neo4j.session.READ, database: db });
    try {
      // READ access mode is enforced by the server (a write fails with Neo.ClientError.Statement.AccessMode).
      const tx = await session.beginTransaction({ timeout: QUERY_TIMEOUT_MS });
      try {
        const res = await withTimeout(tx.run(g.cypher), QUERY_TIMEOUT_MS + 1000, "query");
        const all = res.records;
        const rows = all.slice(0, CONSOLE_LIMIT).map(recordRow);
        const columns = res.records[0] ? res.records[0].keys.map(String) : (res.summary.query ? [] : []);
        await tx.commit();
        return { columns, rows, rowCount: all.length, durationMs: Date.now() - t0, truncated: all.length > CONSOLE_LIMIT };
      } catch (err) {
        await tx.rollback().catch(() => undefined);
        throw err;
      }
    } finally {
      await session.close();
    }
  });
}
