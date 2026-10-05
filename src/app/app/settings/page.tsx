import { prisma } from "@/lib/prisma";
import { DEFAULT_THRESHOLDS } from "@/lib/alerts";
import { CHECK_INTERVAL_MS } from "@/lib/checker";

export const dynamic = "force-dynamic";
export const metadata = { title: "Réglages" };

export default async function SettingsPage() {
  const [instances, checks, oldest, audits, alerts] = await Promise.all([
    prisma.instance.count(),
    prisma.check.count(),
    prisma.check.findFirst({ orderBy: { at: "asc" }, select: { at: true } }),
    prisma.audit.count(),
    prisma.alertEvent.count({ where: { resolvedAt: null } }),
  ]);
  const smtp = !!process.env.SMTP_HOST;
  const rows: [string, string][] = [
    ["Intervalle de contrôle", `${CHECK_INTERVAL_MS / 1000} s`],
    ["Rétention des contrôles", "7 jours"],
    ["Seuils par défaut", `connexions > ${DEFAULT_THRESHOLDS.connectionsPct} %, down après ${DEFAULT_THRESHOLDS.downChecks} contrôles, mémoire > ${DEFAULT_THRESHOLDS.memoryPct} %`],
    ["E-mail d'alerte", smtp ? `${process.env.ALERT_EMAIL ?? process.env.NOTIFY_EMAIL ?? "(ALERT_EMAIL non défini)"} via ${process.env.SMTP_HOST}` : "SMTP non configuré : alertes visibles uniquement dans l'UI et /api/alerts"],
    ["Chiffrement des secrets", process.env.DBMON_ENCRYPTION_KEY ? "AES-256-GCM, clé présente" : "CLÉ ABSENTE"],
    ["Seed au démarrage", process.env.DBMON_SEED_JSON ? "DBMON_SEED_JSON présent (additif, par nom)" : "aucun"],
    ["Instances", String(instances)],
    ["Contrôles stockés", `${checks}${oldest ? ` (depuis ${oldest.at.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })})` : ""}`],
    ["Entrées d'audit", String(audits)],
    ["Alertes actives", String(alerts)],
    ["Version", process.env.APP_VERSION ?? "dev"],
  ];
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Réglages</h1>
      <p className="mt-1 text-sm text-gris">Configuration lue depuis l&apos;environnement (Vault via ExternalSecret). Les seuils se règlent par instance dans son onglet Paramètres.</p>
      <dl className="card mt-4 grid grid-cols-1 gap-y-2 text-sm md:grid-cols-[14rem_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-gris">{k}</dt>
            <dd className="font-mono">{v}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
