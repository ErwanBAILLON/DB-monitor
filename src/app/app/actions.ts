"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";
import { audited } from "@/lib/audit";
import { connOf, createInstance, parseInstanceForm, probe, updateInstance } from "@/lib/instances";
import { checkInstance } from "@/lib/checker";
import { thresholdsOf } from "@/lib/alerts";
import { generatePassword } from "@/lib/crypto";
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
import type { QueryResult } from "@/lib/drivers/types";
import type { Prisma } from "@prisma/client";

type Result = { ok: boolean; message: string };
const fail = (err: unknown): Result => ({ ok: false, message: err instanceof Error ? err.message : String(err) });

async function instanceOr404(id: string) {
  const inst = await prisma.instance.findUnique({ where: { id } });
  if (!inst) throw new Error("Instance introuvable.");
  return inst;
}

const safe = (i: { name: string; type: string; host: string; port: number; username?: string | null }) => ({ name: i.name, type: i.type, host: i.host, port: i.port, username: i.username ?? null });

// --- registry ---------------------------------------------------------------

// Form validation errors (incl. the egress allowlist) are shown on the form page:
// a thrown error would only produce Next's generic error page in production.
function parseOrRedirect(fd: FormData, back: string) {
  try {
    return parseInstanceForm(fd);
  } catch (err) {
    redirect(`${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`);
  }
}

export async function addInstance(fd: FormData): Promise<void> {
  const actor = await requireAdmin();
  const input = parseOrRedirect(fd, "/app/instances/new");
  const inst = await audited({ actor, action: "instance.create", params: safe(input) }, () => createInstance(input));
  await checkInstance(inst.id).catch(() => undefined);
  revalidatePath("/app");
  redirect(`/app/instances/${inst.id}`);
}

export async function editInstance(id: string, fd: FormData): Promise<void> {
  const actor = await requireAdmin();
  const inst = await instanceOr404(id);
  const input = parseOrRedirect(fd, `/app/instances/${id}?tab=settings`);
  await audited({ actor, instance: inst, action: "instance.update", params: { ...safe(input), passwordChanged: input.password !== undefined } }, () => updateInstance(id, input));
  await checkInstance(id).catch(() => undefined);
  revalidatePath("/app");
  redirect(`/app/instances/${id}`);
}

export async function removeInstance(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    await audited({ actor, instance: inst, action: "instance.delete", params: safe(inst) }, () => prisma.instance.delete({ where: { id: inst.id } }));
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/app");
  redirect("/app");
}

export async function testConnection(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const id = String(fd.get("id") ?? "");
    if (id) {
      const inst = await instanceOr404(id);
      const p = await audited({ actor, instance: inst, action: "instance.test" }, () => probe(connOf(inst)), (p) => (p.up ? `up ${p.latencyMs} ms v${p.version}` : `down: ${p.error}`));
      await checkInstance(id).catch(() => undefined);
      revalidatePath(`/app/instances/${id}`);
      return p.up ? { ok: true, message: `Connexion OK en ${p.latencyMs} ms, version ${p.version ?? "?"}` } : { ok: false, message: `Échec : ${p.error}` };
    }
    // Unsaved form: probe the submitted parameters.
    const input = parseInstanceForm(fd);
    const p = await probe({ type: input.type, host: input.host, port: input.port, username: input.username, password: input.password ?? "", database: input.database, tls: input.tls });
    return p.up ? { ok: true, message: `Connexion OK en ${p.latencyMs} ms, version ${p.version ?? "?"}` } : { ok: false, message: `Échec : ${p.error}` };
  } catch (err) {
    return fail(err);
  }
}

export async function saveThresholds(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const t = thresholdsOf({ connectionsPct: Number(fd.get("connectionsPct")), downChecks: Number(fd.get("downChecks")), memoryPct: Number(fd.get("memoryPct")) });
    await audited({ actor, instance: inst, action: "instance.thresholds", params: t }, () => prisma.instance.update({ where: { id: inst.id }, data: { thresholds: t as unknown as Prisma.InputJsonValue } }));
    revalidatePath(`/app/instances/${inst.id}`);
    return { ok: true, message: "Seuils enregistrés." };
  } catch (err) {
    return fail(err);
  }
}

export async function toggleEnabled(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    await audited({ actor, instance: inst, action: inst.enabled ? "instance.disable" : "instance.enable" }, () => prisma.instance.update({ where: { id: inst.id }, data: { enabled: !inst.enabled } }));
    revalidatePath(`/app/instances/${inst.id}`);
    return { ok: true, message: inst.enabled ? "Surveillance suspendue." : "Surveillance reprise." };
  } catch (err) {
    return fail(err);
  }
}

// --- postgres ----------------------------------------------------------------

export async function pgTerminate(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const pid = Number(fd.get("pid"));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("PID invalide.");
    const ok = await audited({ actor, instance: inst, action: "pg.terminate_backend", params: { pid } }, () => pg.terminateBackend(connOf(inst), pid), (ok) => (ok ? "terminated" : "no such backend"));
    revalidatePath(`/app/instances/${inst.id}`);
    return ok ? { ok: true, message: `Backend ${pid} terminé.` } : { ok: false, message: `Aucun backend ${pid}.` };
  } catch (err) {
    return fail(err);
  }
}

export async function pgCreateDatabase(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const name = String(fd.get("name") ?? "").trim();
    const owner = String(fd.get("owner") ?? "").trim() || undefined;
    const createOwner = fd.get("createOwner") === "on" && owner;
    const password = createOwner ? generatePassword() : undefined;
    await audited({ actor, instance: inst, action: "pg.create_database", params: { name, owner: owner ?? null, createOwner: !!createOwner } }, () => pg.createDatabase(connOf(inst), name, owner, password));
    revalidatePath(`/app/instances/${inst.id}`);
    const url = password ? `\nURL : postgresql://${owner}:${password}@${inst.host}:${inst.port}/${name}?sslmode=${inst.tls ? "require" : "prefer"}\n(Mot de passe affiché une seule fois, non journalisé.)` : "";
    return { ok: true, message: `Base ${name} créée${owner ? ` (propriétaire ${owner})` : ""}.${url}` };
  } catch (err) {
    return fail(err);
  }
}

export async function pgCreateRole(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const name = String(fd.get("name") ?? "").trim();
    const createdb = fd.get("createdb") === "on";
    const password = generatePassword();
    await audited({ actor, instance: inst, action: "pg.create_role", params: { name, createdb } }, () => pg.createRole(connOf(inst), name, password, { login: true, createdb }));
    revalidatePath(`/app/instances/${inst.id}`);
    return { ok: true, message: `Rôle ${name} créé.\nMot de passe : ${password}\n(Affiché une seule fois, non journalisé.)` };
  } catch (err) {
    return fail(err);
  }
}

export async function runReadOnlyQuery(id: string, fd: FormData): Promise<{ ok: true; result: QueryResult } | { ok: false; message: string }> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(id);
    const sql = String(fd.get("sql") ?? "");
    const database = String(fd.get("database") ?? "").trim() || undefined;
    const RUNNERS: Record<string, (c: ReturnType<typeof connOf>, q: string, db?: string) => Promise<QueryResult>> = {
      postgres: pg.readOnlyQuery,
      cockroach: crdb.readOnlyQuery,
      mysql: mysql.readOnlyQuery,
      mongodb: mongodb.readOnlyQuery,
      clickhouse: clickhouse.readOnlyQuery,
      mssql: mssql.readOnlyQuery,
      sqlite: (c, q) => sqlite.readOnlyQuery(c, q),
      opensearch: (c, q, db) => opensearch.search(c, db ?? "", q),
      cassandra: cassandra.readOnlyQuery,
      influxdb: influxdb.readOnlyQuery,
      neo4j: neo4j.readOnlyQuery,
    };
    const run = RUNNERS[inst.type];
    if (!run) throw new Error("Pas de console de requête sur ce moteur.");
    const result = await audited({ actor, instance: inst, action: "query.readonly", params: { database: database ?? null, sql: sql.slice(0, 2000) } }, () => run(connOf(inst), sql, database), (r) => `${r.rowCount} rows in ${r.durationMs} ms`);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// --- mysql ---------------------------------------------------------------------

export async function myKill(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const pid = Number(fd.get("pid"));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("ID invalide.");
    await audited({ actor, instance: inst, action: "mysql.kill", params: { id: pid } }, () => mysql.killProcess(connOf(inst), pid));
    revalidatePath(`/app/instances/${inst.id}`);
    return { ok: true, message: `Processus ${pid} tué.` };
  } catch (err) {
    return fail(err);
  }
}

export async function myCreateDatabase(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const name = String(fd.get("name") ?? "").trim();
    const user = String(fd.get("user") ?? "").trim() || undefined;
    const password = user ? generatePassword() : undefined;
    await audited({ actor, instance: inst, action: "mysql.create_database", params: { name, user: user ?? null } }, () => mysql.createDatabase(connOf(inst), name, user, password));
    revalidatePath(`/app/instances/${inst.id}`);
    const url = password ? `\nURL : mysql://${user}:${password}@${inst.host}:${inst.port}/${name}\n(Mot de passe affiché une seule fois, non journalisé.)` : "";
    return { ok: true, message: `Base ${name} créée${user ? ` (utilisateur ${user}, ALL PRIVILEGES sur cette base)` : ""}.${url}` };
  } catch (err) {
    return fail(err);
  }
}

// --- mongodb -------------------------------------------------------------------

export async function mongoKillOp(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const opid = String(fd.get("opid") ?? "").trim();
    if (!/^[\w:-]{1,64}$/.test(opid)) throw new Error("opid invalide.");
    await audited({ actor, instance: inst, action: "mongodb.kill_op", params: { opid } }, () => mongodb.killOp(connOf(inst), opid));
    revalidatePath(`/app/instances/${inst.id}`);
    return { ok: true, message: `killOp ${opid} envoyé.` };
  } catch (err) {
    return fail(err);
  }
}

export async function mongoCreateDatabase(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const name = String(fd.get("name") ?? "").trim();
    const user = String(fd.get("user") ?? "").trim() || undefined;
    const password = user ? generatePassword() : undefined;
    await audited({ actor, instance: inst, action: "mongodb.create_database", params: { name, user: user ?? null } }, () => mongodb.createDatabase(connOf(inst), name, user, password));
    revalidatePath(`/app/instances/${inst.id}`);
    const url = password ? `\nURL : mongodb://${user}:${password}@${inst.host}:${inst.port}/${name}?authSource=${name}\n(Mot de passe affiché une seule fois, non journalisé.)` : "";
    return { ok: true, message: `Base ${name} créée${user ? ` (utilisateur ${user}, readWrite)` : ""}.${url}` };
  } catch (err) {
    return fail(err);
  }
}

// --- cockroach -----------------------------------------------------------------

export async function crdbCancelSession(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const sessionId = String(fd.get("sessionId") ?? "").trim();
    await audited({ actor, instance: inst, action: "cockroach.cancel_session", params: { sessionId } }, () => crdb.cancelSession(connOf(inst), sessionId));
    revalidatePath(`/app/instances/${inst.id}`);
    return { ok: true, message: `Session ${sessionId.slice(0, 8)}… annulée.` };
  } catch (err) {
    return fail(err);
  }
}

export async function crdbCreateDatabase(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const name = String(fd.get("name") ?? "").trim();
    const owner = String(fd.get("owner") ?? "").trim() || undefined;
    await audited({ actor, instance: inst, action: "cockroach.create_database", params: { name, owner: owner ?? null } }, () => crdb.createDatabase(connOf(inst), name, owner));
    revalidatePath(`/app/instances/${inst.id}`);
    return { ok: true, message: `Base ${name} créée${owner ? ` (propriétaire ${owner})` : ""}.` };
  } catch (err) {
    return fail(err);
  }
}

export async function crdbCreateRole(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const name = String(fd.get("name") ?? "").trim();
    const withPassword = fd.get("withPassword") === "on";
    const password = withPassword ? generatePassword() : undefined;
    await audited({ actor, instance: inst, action: "cockroach.create_role", params: { name, withPassword } }, () => crdb.createRole(connOf(inst), name, password));
    revalidatePath(`/app/instances/${inst.id}`);
    return { ok: true, message: `Rôle ${name} créé.${password ? `\nMot de passe : ${password}\n(Affiché une seule fois, non journalisé.)` : " Sans mot de passe (nœud insecure ou authentification par certificat)."}` };
  } catch (err) {
    return fail(err);
  }
}

// --- clickhouse ----------------------------------------------------------------

export async function chKillQuery(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const queryId = String(fd.get("queryId") ?? "").trim();
    const r = await audited({ actor, instance: inst, action: "clickhouse.kill_query", params: { queryId } }, () => clickhouse.killQuery(connOf(inst), queryId), (r) => r);
    revalidatePath(`/app/instances/${inst.id}`);
    return { ok: true, message: `KILL QUERY ${queryId} : ${r}.` };
  } catch (err) {
    return fail(err);
  }
}

// --- mssql ---------------------------------------------------------------------

export async function msKill(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const sessionId = Number(fd.get("sessionId"));
    await audited({ actor, instance: inst, action: "mssql.kill", params: { sessionId } }, () => mssql.killSession(connOf(inst), sessionId));
    revalidatePath(`/app/instances/${inst.id}`);
    return { ok: true, message: `Session ${sessionId} tuée.` };
  } catch (err) {
    return fail(err);
  }
}

export async function msCreateDatabase(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const name = String(fd.get("name") ?? "").trim();
    const login = String(fd.get("login") ?? "").trim() || undefined;
    const password = login ? generatePassword() + "aA1!" : undefined;
    await audited({ actor, instance: inst, action: "mssql.create_database", params: { name, login: login ?? null } }, () => mssql.createDatabase(connOf(inst), name, login, password));
    revalidatePath(`/app/instances/${inst.id}`);
    const url = password ? `\nLogin : ${login}\nMot de passe : ${password}\n(Affiché une seule fois, non journalisé.)` : "";
    return { ok: true, message: `Base ${name} créée${login ? ` (login ${login}, db_owner)` : ""}.${url}` };
  } catch (err) {
    return fail(err);
  }
}

// --- neo4j ---------------------------------------------------------------------

export async function neoTerminate(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const transactionId = String(fd.get("transactionId") ?? "").trim();
    const r = await audited({ actor, instance: inst, action: "neo4j.terminate_transaction", params: { transactionId } }, () => neo4j.terminateTransaction(connOf(inst), transactionId), (r) => r);
    revalidatePath(`/app/instances/${inst.id}`);
    return { ok: true, message: `TERMINATE TRANSACTIONS ${transactionId} : ${r}.` };
  } catch (err) {
    return fail(err);
  }
}

// --- sqlite --------------------------------------------------------------------

export async function sqliteIntegrity(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const rows = await audited({ actor, instance: inst, action: "sqlite.integrity_check" }, () => sqlite.integrityCheck(connOf(inst)), (r) => r.map((x) => Object.values(x)[0]).join("; ").slice(0, 500));
    return { ok: true, message: rows.map((x) => String(Object.values(x)[0])).join("\n") };
  } catch (err) {
    return fail(err);
  }
}

// --- redis ---------------------------------------------------------------------

export async function redisScan(id: string, fd: FormData): Promise<{ ok: true; rows: Awaited<ReturnType<typeof redis.scanKeys>> } | { ok: false; message: string }> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(id);
    const pattern = String(fd.get("pattern") ?? "*").trim() || "*";
    const rows = await audited({ actor, instance: inst, action: "redis.scan", params: { pattern } }, () => redis.scanKeys(connOf(inst), pattern), (r) => `${r.length} keys`);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function redisDelete(fd: FormData): Promise<Result> {
  try {
    const actor = await requireAdmin();
    const inst = await instanceOr404(String(fd.get("id")));
    const key = String(fd.get("key") ?? "");
    const n = await audited({ actor, instance: inst, action: "redis.del", params: { key } }, () => redis.deleteKey(connOf(inst), key), (n) => `${n} deleted`);
    return n ? { ok: true, message: `Clé ${key} supprimée.` } : { ok: false, message: `Clé ${key} absente.` };
  } catch (err) {
    return fail(err);
  }
}
