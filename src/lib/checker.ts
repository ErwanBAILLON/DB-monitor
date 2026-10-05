import { prisma } from "@/lib/prisma";
import { connOf, probe } from "@/lib/instances";
import { evaluate, thresholdsOf, type AlertKind } from "@/lib/alerts";
import { sendMail } from "@/lib/mailer";

export const CHECK_INTERVAL_MS = 30_000;
const RETENTION_MS = 7 * 24 * 3600 * 1000;
const KINDS: AlertKind[] = ["down", "connections", "memory"];

// Probes one instance, stores the Check row, reconciles alert events.
export async function checkInstance(id: string): Promise<void> {
  const inst = await prisma.instance.findUnique({ where: { id } });
  if (!inst || !inst.enabled) return;
  let p;
  try {
    p = await probe(connOf(inst));
  } catch (err) {
    p = { up: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) };
  }
  await prisma.check.create({
    data: {
      instanceId: inst.id,
      up: p.up,
      latencyMs: Math.min(p.latencyMs, 2_000_000_000),
      version: p.version ?? null,
      uptimeSec: p.uptimeSec ?? null,
      connUsed: p.connUsed ?? null,
      connMax: p.connMax ?? null,
      sizeBytes: p.sizeBytes ?? null,
      memMax: p.memMax ?? null,
      role: p.role ?? null,
      error: p.error?.slice(0, 500) ?? null,
    },
  });

  let consecutiveDown = 0;
  if (!p.up) {
    const recent = await prisma.check.findMany({ where: { instanceId: inst.id }, orderBy: { at: "desc" }, take: 100, select: { up: true } });
    for (const c of recent) {
      if (c.up) break;
      consecutiveDown++;
    }
  }
  const firing = evaluate(p, consecutiveDown, thresholdsOf(inst.thresholds));
  const active = await prisma.alertEvent.findMany({ where: { instanceId: inst.id, resolvedAt: null } });
  const now = new Date();
  for (const kind of KINDS) {
    const f = firing.find((x) => x.kind === kind);
    const a = active.find((x) => x.kind === kind);
    if (f && !a) {
      const ev = await prisma.alertEvent.create({ data: { instanceId: inst.id, kind, message: f.message } });
      const sent = await sendMail({
        to: process.env.ALERT_EMAIL ?? process.env.NOTIFY_EMAIL ?? "",
        subject: `[db-monitor] ${inst.name} : ${kind}`,
        text: `${inst.name} (${inst.type} ${inst.host}:${inst.port})\n\n${f.message}\n\n${process.env.NEXTAUTH_URL ?? ""}/app/instances/${inst.id}`,
      }).catch(() => false);
      if (sent) await prisma.alertEvent.update({ where: { id: ev.id }, data: { notifiedAt: now } });
    } else if (!f && a) {
      await prisma.alertEvent.update({ where: { id: a.id }, data: { resolvedAt: now } });
      await sendMail({
        to: process.env.ALERT_EMAIL ?? process.env.NOTIFY_EMAIL ?? "",
        subject: `[db-monitor] ${inst.name} : ${kind} résolu`,
        text: `${inst.name} : la condition "${a.message}" n'est plus vraie.`,
      }).catch(() => false);
    }
  }
}

export async function checkAll(): Promise<number> {
  const ids = await prisma.instance.findMany({ where: { enabled: true }, select: { id: true } });
  // Sequential-ish with a small concurrency: a single pod, dozens of instances at most.
  const queue = ids.map((i) => i.id);
  const workers = Array.from({ length: 4 }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      await checkInstance(id).catch((err) => console.error(`[checker] ${id} failed`, err));
    }
  });
  await Promise.all(workers);
  return ids.length;
}

export async function prune(now = new Date()): Promise<number> {
  const r = await prisma.check.deleteMany({ where: { at: { lt: new Date(now.getTime() - RETENTION_MS) } } });
  return r.count;
}

let started = false;
export function startChecker(intervalMs = CHECK_INTERVAL_MS) {
  if (started) return;
  started = true;
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await checkAll();
      if (Math.random() < 0.02) await prune();
    } catch (err) {
      console.error("[checker] tick failed", err);
    } finally {
      busy = false;
    }
  };
  setTimeout(run, 5_000);
  setInterval(run, intervalMs).unref?.();
}
