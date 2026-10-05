import { ENGINE_BADGE, ENGINE_LABEL } from "@/lib/drivers/types";

export function StatusDot({ up, stale }: { up: boolean | undefined; stale?: boolean }) {
  const cls = up === undefined ? "bg-gris/50" : stale ? "bg-alerte" : up ? "bg-ok" : "bg-panne";
  const label = up === undefined ? "jamais contrôlé" : stale ? "contrôle ancien" : up ? "up" : "down";
  return <span className={`dot ${cls}`} title={label} aria-label={label} data-testid="status" data-status={label} />;
}

export function Engine({ type }: { type: string }) {
  const label = (ENGINE_BADGE as Record<string, string>)[type] ?? type.slice(0, 2).toUpperCase();
  const title = (ENGINE_LABEL as Record<string, string>)[type] ?? type;
  return (
    <span className="rounded-sm bg-encre/90 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-fond" title={title} data-engine={type}>
      {label}
    </span>
  );
}
