import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Active alerts (and the last 24 h of resolved ones), for scripts and Homer/Uptime Kuma style probes.
// Session required (middleware).
export const dynamic = "force-dynamic";

export async function GET() {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const events = await prisma.alertEvent.findMany({
    where: { OR: [{ resolvedAt: null }, { resolvedAt: { gte: since } }] },
    orderBy: { firedAt: "desc" },
    include: { instance: { select: { name: true, type: true, host: true, port: true } } },
  });
  const active = events.filter((e) => !e.resolvedAt);
  return NextResponse.json({
    status: active.length ? "alerting" : "ok",
    active: active.length,
    alerts: events.map((e) => ({
      id: e.id,
      instance: e.instance.name,
      type: e.instance.type,
      target: `${e.instance.host}:${e.instance.port}`,
      kind: e.kind,
      message: e.message,
      firedAt: e.firedAt,
      resolvedAt: e.resolvedAt,
      notified: !!e.notifiedAt,
    })),
  });
}
