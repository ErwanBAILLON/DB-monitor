import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { connOf } from "@/lib/instances";
import { thresholdsOf } from "@/lib/alerts";
import { Tabs } from "@/components/tabs";
import { Engine, StatusDot } from "@/components/status";
import { Sparkline } from "@/components/sparkline";
import { ConfirmForm } from "@/components/confirm-form";
import { InstanceForm } from "@/components/instance-form";
import { ago, bytes, dt, duration } from "@/lib/format";
import { editInstance, removeInstance, saveThresholds, testConnection, toggleEnabled } from "@/app/app/actions";
import { PostgresTabs, postgresTabList } from "./postgres";
import { RedisTabs, redisTabList } from "./redis";
import { MysqlTabs, mysqlTabList } from "./mysql";

export const dynamic = "force-dynamic";

const COMMON_TABS = [
  { key: "overview", label: "Vue d'ensemble" },
  { key: "settings", label: "Paramètres" },
];

export default async function InstancePage({ params, searchParams }: { params: { id: string }; searchParams: { tab?: string } }) {
  const inst = await prisma.instance.findUnique({ where: { id: params.id } });
  if (!inst) notFound();
  const tab = searchParams.tab ?? "overview";
  const engineTabs = inst.type === "postgres" ? postgresTabList : inst.type === "redis" ? redisTabList : mysqlTabList;
  const tabs = [COMMON_TABS[0], ...engineTabs, COMMON_TABS[1]];
  const base = `/app/instances/${inst.id}`;
  const checks = await prisma.check.findMany({ where: { instanceId: inst.id }, orderBy: { at: "desc" }, take: 120 });
  const last = checks[0];
  const alerts = await prisma.alertEvent.findMany({ where: { instanceId: inst.id }, orderBy: { firedAt: "desc" }, take: 20 });
  const t = thresholdsOf(inst.thresholds);

  let engine: React.ReactNode = null;
  if (engineTabs.some((x) => x.key === tab)) {
    const conn = connOf(inst);
    try {
      engine = inst.type === "postgres" ? await PostgresTabs({ inst, conn, tab }) : inst.type === "redis" ? await RedisTabs({ inst, conn, tab }) : await MysqlTabs({ inst, conn, tab });
    } catch (err) {
      engine = (
        <p className="card font-mono text-sm text-panne" data-testid="engine-error">
          Connexion impossible : {err instanceof Error ? err.message : String(err)}
        </p>
      );
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatusDot up={last?.up} />
        <Engine type={inst.type} />
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="instance-name">
          {inst.name}
        </h1>
        <span className="font-mono text-sm text-gris">
          {inst.host}:{inst.port}
          {inst.username ? ` · ${inst.username}` : ""}
          {inst.tls ? " · TLS" : ""}
        </span>
        {inst.tags.map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
        {!inst.enabled && <span className="tag text-alerte">surveillance en pause</span>}
        <div className="ml-auto">
          <ConfirmForm action={testConnection} label="Tester la connexion" testId="test-connection">
            <input type="hidden" name="id" value={inst.id} />
          </ConfirmForm>
        </div>
      </div>
      <Tabs base={base} current={tab} tabs={tabs} />
      <section className="mt-4">
        {tab === "overview" && (
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="card lg:col-span-2">
              <h2 className="text-sm font-medium text-gris">Dernier contrôle {last ? ago(last.at) : ""}</h2>
              {last ? (
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
                  <dt className="text-gris">État</dt>
                  <dd className={`font-mono ${last.up ? "text-ok" : "text-panne"}`} data-testid="last-state">
                    {last.up ? `up · ${last.latencyMs} ms` : "down"}
                  </dd>
                  <dt className="text-gris">Version</dt>
                  <dd className="font-mono">{last.version ?? "–"}</dd>
                  <dt className="text-gris">Uptime</dt>
                  <dd className="font-mono">{duration(last.uptimeSec)}</dd>
                  <dt className="text-gris">Rôle</dt>
                  <dd className="font-mono">{last.role ?? "–"}</dd>
                  <dt className="text-gris">Connexions</dt>
                  <dd className="font-mono">
                    {last.connUsed ?? "–"}
                    {last.connMax ? ` / ${last.connMax}` : ""}
                  </dd>
                  <dt className="text-gris">{inst.type === "redis" ? "Mémoire" : "Taille totale"}</dt>
                  <dd className="font-mono">
                    {bytes(last.sizeBytes)}
                    {last.memMax && last.memMax > 0n ? ` / ${bytes(last.memMax)}` : ""}
                  </dd>
                </dl>
              ) : (
                <p className="mt-2 text-sm text-gris">Pas encore contrôlée.</p>
              )}
              {last?.error && <p className="mt-2 font-mono text-xs text-panne">{last.error}</p>}
              <div className="mt-4">
                <Sparkline points={[...checks].reverse().map((c) => (c.up ? c.latencyMs : null))} width={600} height={48} />
                <p className="font-mono text-[11px] text-gris">latence, {checks.length} derniers contrôles (toutes les 30 s, historique 7 jours)</p>
              </div>
            </div>
            <div className="card">
              <h2 className="text-sm font-medium text-gris">Alertes</h2>
              {alerts.length === 0 && <p className="mt-2 text-sm text-gris">Aucune.</p>}
              <ul className="mt-2 space-y-2 text-sm">
                {alerts.map((a) => (
                  <li key={a.id} className={a.resolvedAt ? "text-gris" : "text-panne"}>
                    <span className="font-mono text-xs">{dt(a.firedAt)}</span> · {a.kind}
                    {a.resolvedAt ? " (résolue)" : ""}
                    <br />
                    <span className="text-xs">{a.message}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card lg:col-span-3">
              <h2 className="text-sm font-medium text-gris">Historique récent</h2>
              <div className="mt-2 max-h-72 overflow-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>État</th>
                      <th>Latence</th>
                      <th>Conn.</th>
                      <th>{inst.type === "redis" ? "Mémoire" : "Taille"}</th>
                      <th>Erreur</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.slice(0, 40).map((c) => (
                      <tr key={c.id}>
                        <td>{dt(c.at)}</td>
                        <td className={c.up ? "text-ok" : "text-panne"}>{c.up ? "up" : "down"}</td>
                        <td>{c.latencyMs} ms</td>
                        <td>
                          {c.connUsed ?? "–"}
                          {c.connMax ? `/${c.connMax}` : ""}
                        </td>
                        <td>{bytes(c.sizeBytes)}</td>
                        <td className="max-w-md truncate">{c.error ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
        {engine}
        {tab === "settings" && (
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="card lg:col-span-2">
              <h2 className="mb-3 text-sm font-medium text-gris">Connexion</h2>
              <InstanceForm instance={inst} action={editInstance.bind(null, inst.id)} submitLabel="Enregistrer" />
            </div>
            <div className="space-y-4">
              <div className="card">
                <h2 className="mb-3 text-sm font-medium text-gris">Seuils d&apos;alerte</h2>
                <ConfirmForm action={saveThresholds} label="Enregistrer" className="grid grid-cols-1 gap-3" testId="thresholds-form">
                  <input type="hidden" name="id" value={inst.id} />
                  <label className="text-sm">
                    <span className="label">Connexions utilisées &gt; %</span>
                    <input name="connectionsPct" type="number" min={1} max={100} className="field" defaultValue={t.connectionsPct} />
                  </label>
                  <label className="text-sm">
                    <span className="label">Down après N contrôles</span>
                    <input name="downChecks" type="number" min={1} max={100} className="field" defaultValue={t.downChecks} />
                  </label>
                  <label className="text-sm">
                    <span className="label">Mémoire (Redis) &gt; %</span>
                    <input name="memoryPct" type="number" min={1} max={100} className="field" defaultValue={t.memoryPct} />
                  </label>
                </ConfirmForm>
                <p className="mt-2 text-xs text-gris">Notification par e-mail (ALERT_EMAIL) et exposition sur /api/alerts.</p>
              </div>
              <div className="card">
                <h2 className="mb-3 text-sm font-medium text-gris">Surveillance</h2>
                <ConfirmForm action={toggleEnabled} label={inst.enabled ? "Mettre en pause" : "Reprendre"}>
                  <input type="hidden" name="id" value={inst.id} />
                </ConfirmForm>
              </div>
              <div className="card border-panne/40">
                <h2 className="mb-3 text-sm font-medium text-panne">Zone dangereuse</h2>
                <ConfirmForm action={removeInstance} label="Supprimer l'instance" danger confirm={`Supprimer ${inst.name} du registre ? Les contrôles et alertes associés sont effacés. La base elle-même n'est pas touchée.`} testId="delete-form">
                  <input type="hidden" name="id" value={inst.id} />
                </ConfirmForm>
              </div>
            </div>
          </div>
        )}
      </section>
      <p className="mt-6 text-xs text-gris">
        <Link href="/app" className="link">
          ← Flotte
        </Link>
      </p>
    </>
  );
}
