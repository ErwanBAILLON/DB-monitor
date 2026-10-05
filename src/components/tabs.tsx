import Link from "next/link";

export function Tabs({ base, current, tabs }: { base: string; current: string; tabs: { key: string; label: string; count?: number }[] }) {
  return (
    <nav className="flex flex-wrap gap-1 border-b border-trait" aria-label="Onglets">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={`${base}?tab=${t.key}`}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${t.key === current ? "border-accent font-medium text-encre" : "border-transparent text-gris hover:text-encre"}`}
          data-testid={`tab-${t.key}`}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded-sm bg-encre/10 px-1 font-mono text-[11px]">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
