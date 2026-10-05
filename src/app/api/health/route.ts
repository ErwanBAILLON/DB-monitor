import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Readiness: the app is only useful with its database.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "db_unavailable" }, { status: 503 });
  }
}
