import { auth } from "@/lib/auth";

// Server actions are reachable by POST from anywhere, so each one re-checks the
// session instead of relying on the middleware alone. Returns the actor name.
export async function requireAdmin(): Promise<string> {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  return session.user.name ?? "admin";
}
