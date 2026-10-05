import type { NextFetchEvent, NextMiddleware, NextRequest } from "next/server";
import { auth } from "@/lib/auth";

// next-auth's middleware form: redirects to /login without a session.
const guard = auth as unknown as NextMiddleware;

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  return guard(request, event);
}

export const config = {
  matcher: ["/app/:path*", "/api/instances/:path*", "/api/alerts"],
};
