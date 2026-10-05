import type { NextRequest } from "next/server";
import { handleExplore } from "@/lib/explore/api";

// /api/instances/:id/explore/:op — see src/lib/explore/api.ts for the operations.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string; op: string } }) {
  return handleExplore(req, params.id, params.op);
}
export async function POST(req: NextRequest, { params }: { params: { id: string; op: string } }) {
  return handleExplore(req, params.id, params.op);
}
