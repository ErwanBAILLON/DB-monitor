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
    const run = inst.type === "postgres" ? pg.readOnlyQuery : inst.type === "mysql" ? mysql.readOnlyQuery : null;
    if (!run) throw new Error("Pas de requête SQL sur ce moteur.");
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
