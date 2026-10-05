import { startChecker } from "@/lib/checker";
import { seedFromEnv } from "@/lib/seed";

// Disabled with CHECKER_DISABLED=true, and during the build (no database).
export async function boot() {
  if (process.env.CHECKER_DISABLED === "true" || !process.env.DATABASE_URL) return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  await seedFromEnv().catch((err) => console.error("[seed] failed", err));
  startChecker();
}
