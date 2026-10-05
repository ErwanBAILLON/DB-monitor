import { spawn } from "node:child_process";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { connOf } from "@/lib/instances";
import { dumpSpec as pgDumpSpec } from "@/lib/drivers/postgres";
import { dumpSpec as myDumpSpec } from "@/lib/drivers/mysql";

// GET /api/instances/:id/dump?db=<name> -> <name>-<date>.sql.gz streamed from pg_dump.
// Audited; the dump is never written to disk.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const actor = session.user.name ?? "admin";
  const inst = await prisma.instance.findUnique({ where: { id: params.id } });
  if (!inst) return NextResponse.json({ error: "not found" }, { status: 404 });
  const tool = inst.type === "postgres" ? "pg_dump" : inst.type === "mysql" ? "mariadb-dump" : null;
  if (!tool) return NextResponse.json({ error: "dump only for postgres and mysql" }, { status: 400 });
  const db = req.nextUrl.searchParams.get("db") ?? "";
  let spec;
  try {
    spec = tool === "pg_dump" ? pgDumpSpec(connOf(inst), db) : myDumpSpec(connOf(inst), db);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "bad request" }, { status: 400 });
  }
  const bin = tool === "pg_dump" ? process.env.PG_DUMP_BIN ?? "pg_dump" : process.env.MYSQL_DUMP_BIN ?? "mariadb-dump";
  const child = spawn(bin, spec.args, { env: { ...process.env, ...spec.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString().slice(0, 2000)));
  const gz = createGzip({ level: 6 });
  child.stdout.pipe(gz);
  const audit = (ok: boolean, result: string) =>
    prisma.audit.create({ data: { actor, instanceId: inst.id, instanceName: inst.name, action: tool, params: { database: db }, ok, result: result.slice(0, 2000) } }).catch(() => undefined);
  child.on("close", (code) => {
    if (code === 0) void audit(true, "dump streamed");
    else {
      void audit(false, `${tool} exit ${code}: ${stderr}`);
      gz.destroy(new Error(`${tool} exit ${code}: ${stderr}`));
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
