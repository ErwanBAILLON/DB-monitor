import type { Probe } from "@/lib/drivers/types";

export type Thresholds = {
  connectionsPct: number; // alert when connUsed/connMax > pct
  downChecks: number; // alert after N consecutive failed checks
  memoryPct: number; // redis: used_memory/maxmemory > pct
};

export const DEFAULT_THRESHOLDS: Thresholds = { connectionsPct: 80, downChecks: 2, memoryPct: 85 };

export function thresholdsOf(raw: unknown): Thresholds {
  const t = (raw ?? {}) as Partial<Thresholds>;
  const num = (v: unknown, d: number, min: number, max: number) => (typeof v === "number" && v >= min && v <= max ? v : d);
  return {
    connectionsPct: num(t.connectionsPct, DEFAULT_THRESHOLDS.connectionsPct, 1, 100),
    downChecks: num(t.downChecks, DEFAULT_THRESHOLDS.downChecks, 1, 100),
    memoryPct: num(t.memoryPct, DEFAULT_THRESHOLDS.memoryPct, 1, 100),
  };
}

export type AlertKind = "down" | "connections" | "memory";
export type Evaluation = { kind: AlertKind; message: string }[];

// Pure: which alert conditions hold given the latest probe and the number of
// consecutive failures (including this one).
export function evaluate(probe: Probe, consecutiveDown: number, t: Thresholds): Evaluation {
  const out: Evaluation = [];
  if (!probe.up) {
    if (consecutiveDown >= t.downChecks) out.push({ kind: "down", message: `Injoignable depuis ${consecutiveDown} contrôles : ${probe.error ?? "erreur inconnue"}` });
    return out;
  }
  if (probe.connUsed !== undefined && probe.connMax && probe.connMax > 0) {
    const pct = (100 * probe.connUsed) / probe.connMax;
    if (pct > t.connectionsPct) out.push({ kind: "connections", message: `Connexions ${probe.connUsed}/${probe.connMax} (${pct.toFixed(0)} % > ${t.connectionsPct} %)` });
  }
  if (probe.sizeBytes !== undefined && probe.memMax && probe.memMax > 0n) {
    const pct = Number((probe.sizeBytes * 10000n) / probe.memMax) / 100;
    if (pct > t.memoryPct) out.push({ kind: "memory", message: `Mémoire ${pct.toFixed(0)} % de maxmemory (> ${t.memoryPct} %)` });
  }
  return out;
}
