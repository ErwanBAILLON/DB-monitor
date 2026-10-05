export function StatusDot({ up, stale }: { up: boolean | undefined; stale?: boolean }) {
  const cls = up === undefined ? "bg-gris/50" : stale ? "bg-alerte" : up ? "bg-ok" : "bg-panne";
  const label = up === undefined ? "jamais contrôlé" : stale ? "contrôle ancien" : up ? "up" : "down";
  return <span className={`dot ${cls}`} title={label} aria-label={label} data-testid="status" data-status={label} />;
}

export function Engine({ type }: { type: string }) {
  const label = type === "postgres" ? "PG" : type === "mysql" ? "MY" : type === "redis" ? "RD" : type.slice(0, 2).toUpperCase();
  return <span className="rounded-sm bg-encre/90 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-fond">{label}</span>;
}
