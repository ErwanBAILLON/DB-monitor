import { ENGINES, type EngineType } from "@/lib/drivers/types";
import type { Explorer } from "./types";

// Registry: engine -> explorer implementation. Engines without an entry have no
// "Explorer" / "Statistiques" tabs. Add `<engine>: <module>.explorer` here when a
// src/lib/explore/<engine>.ts lands (keep both entries on a merge conflict).
const REGISTRY: Partial<Record<EngineType, () => Promise<Explorer>>> = {};

export function registerExplorer(engine: EngineType, load: () => Promise<Explorer>): void {
  REGISTRY[engine] = load;
}

export function hasExplorer(engine: EngineType): boolean {
  return Boolean(REGISTRY[engine]);
}

export const HAS_EXPLORER: Record<EngineType, boolean> = Object.fromEntries(ENGINES.map((e) => [e, false])) as Record<EngineType, boolean>;

export async function explorerFor(engine: EngineType): Promise<Explorer> {
  const load = REGISTRY[engine];
  if (!load) throw new Error("Pas d'explorateur pour ce moteur.");
  return load();
}

// Static registration (lazy modules keep the page bundle small: drivers load on demand).
function reg(engine: EngineType, load: () => Promise<{ explorer: Explorer }>) {
  registerExplorer(engine, async () => (await load()).explorer);
  HAS_EXPLORER[engine] = true;
}

// --- registrations ------------------------------------------------------------
// One line per engine, added by that engine's commit. Keep both lines on a merge conflict.
reg("postgres", () => import("./postgres"));
reg("mysql", () => import("./mysql"));
reg("sqlite", () => import("./sqlite"));
reg("s3", () => import("./s3"));
reg("clickhouse", () => import("./clickhouse"));

export const explorerEngines = (): EngineType[] => ENGINES.filter((e) => HAS_EXPLORER[e]);
