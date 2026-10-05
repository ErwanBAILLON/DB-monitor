import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { clientIp, loginGuard } from "@/lib/login-guard";

// Constant-time compare without node:crypto (this module is also loaded by the edge middleware).
function same(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Single administrator, credentials from Vault (ADMIN_USERNAME / ADMIN_PASSWORD).
// Failed attempts are counted per client IP (see login-guard.ts) in addition to the
// per-IP Traefik rate limit of the chart.
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: { username: {}, password: {} },
      authorize(credentials, request) {
        const ip = clientIp(request?.headers);
        const left = loginGuard.lockedFor(ip);
        if (left > 0) {
          console.warn(`[auth] locked login attempt from ${ip} (${Math.ceil(left / 1000)} s left)`);
          return null;
        }
        const user = process.env.ADMIN_USERNAME;
        if (same(credentials?.username, user) && same(credentials?.password, process.env.ADMIN_PASSWORD)) {
          loginGuard.succeed(ip);
          return { id: "admin", name: user };
        }
        const lock = loginGuard.fail(ip);
        console.warn(`[auth] failed login from ${ip}${lock ? ` -> locked ${Math.round(lock / 60000)} min` : ""}`);
        return null;
      },
    }),
  ],
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  callbacks: {
    authorized({ auth }) {
      return !!auth;
    },
  },
});
