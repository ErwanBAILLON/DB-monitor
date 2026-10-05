import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

// Constant-time compare without node:crypto (this module is also loaded by the edge middleware).
function same(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Single administrator, credentials from Vault (ADMIN_USERNAME / ADMIN_PASSWORD).
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: { username: {}, password: {} },
      authorize(credentials) {
        const user = process.env.ADMIN_USERNAME;
        if (same(credentials?.username, user) && same(credentials?.password, process.env.ADMIN_PASSWORD)) {
          return { id: "admin", name: user };
        }
        return null;
      },
    }),
  ],
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  callbacks: {
    authorized({ auth }) {
      return !!auth;
    },
  },
});
