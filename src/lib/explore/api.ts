import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { audited } from "@/lib/audit";
import { connOf } from "@/lib/instances";
import type { EngineType } from "@/lib/drivers/types";
import { explorerFor, hasExplorer } from "@/lib/explore";
import { normalizeBrowseRequest, type Explorer } from "@/lib/explore/types";
import { auditParams } from "@/lib/explore/sql";

// HTTP surface of the explorer: /api/instances/:id/explore/<op>
//   GET  containers
//   GET  objects?container=
//   GET  describe?container=&object=
//   POST browse   {container, object, page, pageSize, sortColumn, sortDir, filters}
//   GET  profile?container=&object=&column=
//   GET  stats[?container=]
// Session re-checked here (the middleware covers /api/instances too), instance 404,
// engine without explorer 400. describe/browse/profile/stats are audited like a
// console query: object + filter shape, never data values. Listing calls are not
// audited (navigation noise); they read catalogs only.

import { EXPLORE_OPS, type ExploreOp } from "@/lib/explore/ops";

const str = (v: unknown, max = 512) => (typeof v === "string" ? v.slice(0, max) : "");

export async function handleExplore(req: NextRequest, id: string, op: string): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const actor = session.user.name ?? "admin";
  if (!(EXPLORE_OPS as readonly string[]).includes(op)) return NextResponse.json({ error: "unknown operation" }, { status: 404 });
  const inst = await prisma.instance.findUnique({ where: { id } });
  if (!inst) return NextResponse.json({ error: "not found" }, { status: 404 });
  const engine = inst.type as EngineType;
  if (!hasExplorer(engine)) return NextResponse.json({ error: "Pas d'explorateur pour ce moteur." }, { status: 400 });

  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      body = (await req.json()) as Record<string, unknown>;
      if (!body || typeof body !== "object") body = {};
    } catch {
      return NextResponse.json({ error: "JSON invalide." }, { status: 400 });
    }
  }
  const q = (k: string) => str(body[k] ?? req.nextUrl.searchParams.get(k) ?? "");
  const container = q("container");
  const object = q("object");
  const column = q("column");
  const instance = { id: inst.id, name: inst.name };
  const conn = connOf(inst);

  try {
    const x: Explorer = await explorerFor(engine);
    switch (op as ExploreOp) {
      case "containers":
        return NextResponse.json({ containers: await x.listContainers(conn), caveats: x.caveats ?? [] });
      case "objects":
        if (!container) return NextResponse.json({ error: "container requis" }, { status: 400 });
        return NextResponse.json({ objects: await x.listObjects(conn, container) });
      case "describe":
        if (!container || !object) return NextResponse.json({ error: "container et object requis" }, { status: 400 });
        return NextResponse.json(await audited({ actor, instance, action: "explore.describe", params: { container, object } }, () => x.describeObject(conn, container, object), (d) => `${d.columns.length} columns, ${d.indexes.length} indexes`));
      case "browse": {
        if (!container || !object) return NextResponse.json({ error: "container et object requis" }, { status: 400 });
        const breq = normalizeBrowseRequest(body);
        return NextResponse.json(await audited({ actor, instance, action: "explore.browse", params: { container, object, ...auditParams(breq) } }, () => x.browseRows(conn, container, object, breq), (r) => `${r.rows.length} rows (total ${r.total ?? "?"}${r.totalIsEstimate ? " est." : ""}) in ${r.durationMs} ms`));
      }
      case "profile":
        if (!container || !object || !column) return NextResponse.json({ error: "container, object et column requis" }, { status: 400 });
        return NextResponse.json(await audited({ actor, instance, action: "explore.profile", params: { container, object, column } }, () => x.columnProfile(conn, container, object, column), (p) => ("unsupported" in p && p.unsupported ? "unsupported" : `sample ${(p as { sampleSize: number }).sampleSize}`)));
      case "stats":
        return NextResponse.json(await audited({ actor, instance, action: "explore.stats", params: { container: container || null } }, () => x.stats(conn, container || undefined), (s) => `${s.sections.length} sections in ${s.durationMs} ms`));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message.slice(0, 2000) }, { status: 400 });
  }
  return NextResponse.json({ error: "unknown operation" }, { status: 404 });
}
