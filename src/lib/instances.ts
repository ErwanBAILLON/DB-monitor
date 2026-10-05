import type { Instance } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";
import * as pg from "@/lib/drivers/postgres";
import * as redis from "@/lib/drivers/redis";
import * as mysql from "@/lib/drivers/mysql";
import { ENGINES, type Conn, type EngineType, type Probe } from "@/lib/drivers/types";

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
    case "redis":
      return redis.probe(c);
    case "mysql":
      return mysql.probe(c);
  }
}

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
  const host = str("host");
  if (!/^[\w.-]{1,253}$/.test(host)) throw new Error("Hôte invalide.");
  const port = Number(str("port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port invalide.");
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
