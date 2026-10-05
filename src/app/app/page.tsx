import Link from "next/link";
import { fleet } from "@/lib/instances";
import { AutoRefresh } from "@/components/auto-refresh";
import { Sparkline } from "@/components/sparkline";
import { Engine, StatusDot } from "@/components/status";
import { ago, bytes, duration, pct } from "@/lib/format";
import { CHECK_INTERVAL_MS } from "@/lib/checker";

export const dynamic = "force-dynamic";
export const metadata = { title: "Flotte" };

export default async function FleetPage() {
  const rows = await fleet();
  const up = rows.filter((r) => r.last?.up).length;
  const down = rows.filter((r) => r.last && !r.last.up).length;
  return (
    <>
      <div className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Flotte</h1>
        <p className="text-sm text-gris" data-testid="fleet-summary">
          {rows.length} instance{rows.length > 1 ? "s" : ""} · <span className="text-ok">{up} up</span> · <span className={down ? "text-panne" : ""}>{down} down</span>
        </p>
        <span className="ml-auto">
          <AutoRefresh seconds={CHECK_INTERVAL_MS / 1000} />
        </span>
      </div>
      {rows.length === 0 && (
        <div className="card">
          <p>Aucune instance. </p>
          <Link href="/app/instances/new" className="link">
            Ajouter la première
          </Link>
        </div>
      )}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="fleet">
        {rows.map(({ instance: i, last, spark, upRatio24h, alerts }) => {
          const stale = last ? Date.now() - new Date(last.at).getTime() > 3 * CHECK_INTERVAL_MS : false;
          const conn = pct(last?.connUsed, last?.connMax);
          const mem = last?.memMax && last.memMax > 0n && last.sizeBytes !== null && last.sizeBytes !== undefined ? Number((last.sizeBytes * 100n) / last.memMax) : null;
          return (
            <li key={i.id} className={`card relative ${!i.enabled ? "opacity-60" : ""}`} data-testid="instance-card" data-name={i.name}>
              <Link href={`/app/instances/${i.id}`} className="absolute inset-0" aria-label={i.name} />
              <div className="flex items-center gap-2">
                <StatusDot up={last?.up} stale={stale} />
                <Engine type={i.type} />
                <h2 className="truncate font-medium">{i.name}</h2>
                {alerts > 0 && <span className="ml-auto rounded-sm bg-panne/15 px-1.5 font-mono text-[11px] text-panne">{alerts} ⚠</span>}
                {!i.enabled && <span className="tag ml-auto">pause</span>}
              </div>
              <p className="mt-1 truncate font-mono text-xs text-gris">
                {i.host}:{i.port}
                {i.environment !== "prod" && <span className="tag ml-2">{i.environment}</span>}
              </p>
              <dl className="mt-3 grid grid-cols-3 gap-x-2 gap-y-1 text-xs">
                <dt className="text-gris">Version</dt>
                <dd className="col-span-2 font-mono">{last?.version ?? "–"}</dd>
                <dt className="text-gris">Uptime</dt>
                <dd className="col-span-2 font-mono">
                  {duration(last?.uptimeSec)}
                  {last?.role && <span className="ml-2 tag">{last.role}</span>}
                </dd>
                <dt className="text-gris">Connexions</dt>
                <dd className="col-span-2 font-mono">
                  {last?.connUsed ?? "–"}
                  {last?.connMax ? ` / ${last.connMax}` : ""}
                  {conn !== null && <span className={`ml-2 ${conn > 80 ? "text-panne" : conn > 60 ? "text-alerte" : "text-gris"}`}>{conn} %</span>}
                </dd>
                <dt className="text-gris">{i.type === "redis" ? "Mémoire" : "Taille"}</dt>
                <dd className="col-span-2 font-mono">
                  {bytes(last?.sizeBytes)}
                  {mem !== null && <span className={`ml-2 ${mem > 85 ? "text-panne" : "text-gris"}`}>{mem} % de {bytes(last?.memMax)}</span>}
                </dd>
              </dl>
              <div className="mt-3 flex items-end justify-between gap-2">
                <div>
                  <Sparkline points={spark} />
                  <p className="mt-0.5 font-mono text-[11px] text-gris">
                    {last ? (last.up ? `${last.latencyMs} ms` : "down") : "–"}
                    {upRatio24h !== null && ` · ${Math.round(upRatio24h * 100)} % up 24 h`}
                  </p>
                </div>
                <p className="text-right font-mono text-[11px] text-gris" title={last ? new Date(last.at).toISOString() : ""}>
                  {ago(last?.at)}
                </p>
              </div>
              {last && !last.up && <p className="mt-2 truncate font-mono text-xs text-panne" title={last.error ?? ""}>{last.error}</p>}
            </li>
          );
        })}
      </ul>
    </>
  );
}
