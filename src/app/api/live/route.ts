import { NextResponse } from "next/server";

// Liveness: process is up. No DB check, so a database outage does not
// make Kubernetes restart the pod in a loop.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" });
}
