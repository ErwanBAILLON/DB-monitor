import { prisma } from "@/lib/prisma";
import { createInstance } from "@/lib/instances";
import { isEngine } from "@/lib/instances";

// First-deploy seed: DBMON_SEED_JSON (from Vault) lists the homelab fleet.
// Additive and idempotent: an instance whose name already exists is left as is,
// so edits made in the UI survive restarts.
export type SeedEntry = {
  name: string;
  type: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  tls?: boolean;
  environment?: string;
  tags?: string[];
};

export function parseSeed(json: string | undefined): SeedEntry[] {
  if (!json) return [];
  const data = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error("DBMON_SEED_JSON must be an array");
  return data as SeedEntry[];
}

export async function seedFromEnv(json = process.env.DBMON_SEED_JSON): Promise<number> {
  let entries: SeedEntry[];
  try {
    entries = parseSeed(json);
  } catch (err) {
    console.error("[seed] invalid DBMON_SEED_JSON", err instanceof Error ? err.message : err);
    return 0;
  }
  let created = 0;
  for (const e of entries) {
    if (!e?.name || !isEngine(e.type) || !e.host) continue;
    const exists = await prisma.instance.findUnique({ where: { name: e.name } });
    if (exists) continue;
    await createInstance({
      name: e.name,
      type: e.type,
      host: e.host,
      port: Number(e.port) || (e.type === "postgres" ? 5432 : e.type === "mysql" ? 3306 : 6379),
      username: e.username,
      password: e.password,
      database: e.database,
      tls: Boolean(e.tls),
      environment: e.environment ?? "prod",
      tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
    });
    created++;
  }
  if (created) console.info(`[seed] ${created} instance(s) created from DBMON_SEED_JSON`);
  return created;
}
