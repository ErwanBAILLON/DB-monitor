import type { Instance } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";
import * as pg from "@/lib/drivers/postgres";
import * as redis from "@/lib/drivers/redis";
import * as mysql from "@/lib/drivers/mysql";
import * as mongodb from "@/lib/drivers/mongodb";
import * as clickhouse from "@/lib/drivers/clickhouse";
import * as crdb from "@/lib/drivers/cockroach";
import * as opensearch from "@/lib/drivers/opensearch";
import * as mssql from "@/lib/drivers/mssql";
import * as sqlite from "@/lib/drivers/sqlite";
import * as cassandra from "@/lib/drivers/cassandra";
import * as influxdb from "@/lib/drivers/influxdb";
import * as neo4j from "@/lib/drivers/neo4j";
import * as etcd from "@/lib/drivers/etcd";
import * as rabbitmq from "@/lib/drivers/rabbitmq";
import * as s3 from "@/lib/drivers/s3";
import * as oracle from "@/lib/drivers/oracle";
import { DEFAULT_PORT, ENGINES, type Conn, type EngineType, type Probe } from "@/lib/drivers/types";
import { assertAllowedTarget } from "@/lib/targets";

export function isEngine(s: unknown): s is EngineType {
  return typeof s === "string" && (ENGINES as string[]).includes(s);
}

// Decrypts the stored password for one connection. Never log the result.
export function connOf(i: Instance): Conn {
  return {
    type: i.type as EngineType,
    host: i.host,
    port: i.port,
    username: i.username,
    password: i.secret ? decrypt(i.secret) : "",
    database: i.database,
    tls: i.tls,
  };
}

export function probe(c: Conn): Promise<Probe> {
  switch (c.type) {
    case "postgres":
      return pg.probe(c);
    case "cockroach":
      return crdb.probe(c);
    case "redis":
      return redis.probe(c);
    case "mysql":
      return mysql.probe(c);
    case "mongodb":
      return mongodb.probe(c);
    case "clickhouse":
      return clickhouse.probe(c);
    case "opensearch":
      return opensearch.probe(c);
    case "mssql":
      return mssql.probe(c);
    case "sqlite":
      return sqlite.probe(c);
    case "cassandra":
      return cassandra.probe(c);
    case "influxdb":
      return influxdb.probe(c);
    case "neo4j":
      return neo4j.probe(c);
    case "etcd":
      return etcd.probe(c);
    case "rabbitmq":
      return rabbitmq.probe(c);
    case "s3":
      return s3.probe(c);
    case "oracle":
      return oracle.probe(c);
  }
}

export const defaultPort = (type: EngineType) => DEFAULT_PORT[type];

export type InstanceInput = {
  name: string;
  type: EngineType;
  host: string;
  port: number;
  username?: string;
  password?: string; // undefined = keep current on edit
  database?: string;
  tls: boolean;
  environment: string;
  tags: string[];
};

export function parseInstanceForm(fd: FormData): InstanceInput {
  const str = (k: string) => String(fd.get(k) ?? "").trim();
  const type = str("type");
  if (!isEngine(type)) throw new Error("Type de moteur inconnu.");
  const name = str("name");
  if (!/^[\w.-]{2,64}$/.test(name)) throw new Error("Nom : 2 à 64 caractères (lettres, chiffres, . _ -).");
  let host = str("host");
  let port = Number(str("port"));
  if (type === "sqlite") {
    // A local file: no network target. The path is checked against DBMON_SQLITE_ROOTS.
    host = "localhost";
    port = 0;
    sqlite.resolvePath(str("database"));
  } else {
    if (!/^[\w.-]{1,253}$/.test(host)) throw new Error("Hôte invalide.");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port invalide.");
    assertAllowedTarget(host, port);
  }
  const password = fd.get("password");
  return {
    name,
    type,
    host,
    port,
    username: str("username") || undefined,
    password: typeof password === "string" && password !== "" ? password : undefined,
    database: str("database") || undefined,
    tls: fd.get("tls") === "on",
    environment: str("environment") || "prod",
    tags: str("tags")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 10),
  };
}

export async function createInstance(input: InstanceInput): Promise<Instance> {
  return prisma.instance.create({
    data: {
      name: input.name,
      type: input.type,
      host: input.host,
      port: input.port,
      username: input.username ?? null,
      database: input.database ?? null,
      secret: encrypt(input.password ?? ""),
      tls: input.tls,
      environment: input.environment,
      tags: input.tags,
    },
  });
}

export async function updateInstance(id: string, input: InstanceInput): Promise<Instance> {
  return prisma.instance.update({
    where: { id },
    data: {
      name: input.name,
      type: input.type,
      host: input.host,
      port: input.port,
      username: input.username ?? null,
      database: input.database ?? null,
      ...(input.password !== undefined ? { secret: encrypt(input.password) } : {}),
      tls: input.tls,
      environment: input.environment,
      tags: input.tags,
    },
  });
}

// Fleet view: each enabled instance with its latest check and 7-day sparkline data.
export async function fleet() {
  const instances = await prisma.instance.findMany({ orderBy: [{ type: "asc" }, { name: "asc" }] });
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const checks = await prisma.check.findMany({
    where: { at: { gte: since } },
    orderBy: { at: "asc" },
    select: { instanceId: true, at: true, up: true, latencyMs: true, version: true, uptimeSec: true, connUsed: true, connMax: true, sizeBytes: true, memMax: true, role: true, error: true },
  });
  const byInstance = new Map<string, typeof checks>();
  for (const c of checks) {
    const arr = byInstance.get(c.instanceId) ?? [];
    arr.push(c);
    byInstance.set(c.instanceId, arr);
  }
  const activeAlerts = await prisma.alertEvent.groupBy({ by: ["instanceId"], where: { resolvedAt: null }, _count: true });
  const alertCount = new Map(activeAlerts.map((a) => [a.instanceId, a._count]));
  return instances.map((i) => {
    const history = byInstance.get(i.id) ?? [];
    const last = history[history.length - 1];
    // Sparkline: last 48 points (~24 min at 30 s), latency, null when down.
    const spark = history.slice(-48).map((c) => (c.up ? c.latencyMs : null));
    const upRatio24h = history.length ? history.filter((c) => c.up).length / history.length : null;
    return { instance: i, last, spark, upRatio24h, alerts: alertCount.get(i.id) ?? 0 };
  });
}
