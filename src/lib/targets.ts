// Application-level egress allowlist for monitored instances.
// The cluster CNI (flannel) does not enforce NetworkPolicy, so the chart derives
// DBMON_ALLOWED_TARGETS from the same `networkPolicy.egress` list and the app refuses
// any instance whose host:port is outside it (create, edit, test).
//
// Format: comma-separated entries `<host-pattern>[:<port>[/<port>...]]`
//   pattern  = exact host, `.suffix` (matches `x.suffix`), or `*`
//   no ports = any port
// Empty / unset = everything allowed (local development).

export type Target = { pattern: string; ports: number[] };

export function parseTargets(spec: string | undefined): Target[] {
  return (spec ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [pattern, ports] = entry.split(":");
      return {
        pattern: pattern.toLowerCase(),
        ports: (ports ?? "")
          .split("/")
          .map((p) => Number(p))
          .filter((p) => Number.isInteger(p) && p > 0),
      };
    });
}

export function isAllowedTarget(host: string, port: number, targets: Target[]): boolean {
  if (targets.length === 0) return true;
  const h = host.toLowerCase().replace(/\.$/, "");
  return targets.some((t) => {
    const hostOk = t.pattern === "*" || h === t.pattern || (t.pattern.startsWith(".") && h.endsWith(t.pattern) && h.length > t.pattern.length);
    return hostOk && (t.ports.length === 0 || t.ports.includes(port));
  });
}

export function assertAllowedTarget(host: string, port: number, spec = process.env.DBMON_ALLOWED_TARGETS): void {
  const targets = parseTargets(spec);
  if (!isAllowedTarget(host, port, targets)) {
    throw new Error(`Cible ${host}:${port} hors de la liste autorisée (DBMON_ALLOWED_TARGETS, dérivée de networkPolicy.egress du chart).`);
  }
}
