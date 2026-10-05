import { spawn } from "node:child_process";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { connOf } from "@/lib/instances";
import { dumpSpec } from "@/lib/drivers/postgres";

// GET /api/instances/:id/dump?db=<name> -> <name>-<date>.sql.gz streamed from pg_dump.
// Audited; the dump is never written to disk.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const actor = session.user.name ?? "admin";
  const inst = await prisma.instance.findUnique({ where: { id: params.id } });
  if (!inst) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (inst.type !== "postgres") return NextResponse.json({ error: "dump only for postgres" }, { status: 400 });
  const db = req.nextUrl.searchParams.get("db") ?? "";
  let spec;
  try {
    spec = dumpSpec(connOf(inst), db);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "bad request" }, { status: 400 });
  }
  const bin = process.env.PG_DUMP_BIN ?? "pg_dump";
  const child = spawn(bin, spec.args, { env: { ...process.env, ...spec.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString().slice(0, 2000)));
  const gz = createGzip({ level: 6 });
  child.stdout.pipe(gz);
  const audit = (ok: boolean, result: string) =>
    prisma.audit.create({ data: { actor, instanceId: inst.id, instanceName: inst.name, action: "pg_dump", params: { database: db }, ok, result: result.slice(0, 2000) } }).catch(() => undefined);
  child.on("close", (code) => {
    if (code === 0) void audit(true, "dump streamed");
    else {
      void audit(false, `pg_dump exit ${code}: ${stderr}`);
      gz.destroy(new Error(`pg_dump exit ${code}: ${stderr}`));
    }
  });
  child.on("error", (err) => {
    void audit(false, err.message);
    gz.destroy(err);
  });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return new NextResponse(Readable.toWeb(gz) as ReadableStream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${db}-${stamp}.sql.gz"`,
      "Cache-Control": "no-store",
    },
  });
}
