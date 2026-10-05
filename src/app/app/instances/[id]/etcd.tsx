import type { Instance } from "@prisma/client";
import * as etcd from "@/lib/drivers/etcd";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { bytes } from "@/lib/format";

export const etcdTabList = [
  { key: "cluster", label: "Cluster" },
  { key: "keys", label: "Clés" },
];

export async function EtcdTabs({ conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await etcd.detail(conn);
  switch (tab) {
    case "cluster": {
      const size = Number(d.status.dbSize ?? 0);
      const inUse = Number(d.status.dbSizeInUse ?? 0);
      const pct = d.quotaBytes ? Math.round((100 * size) / d.quotaBytes) : null;
      return (
        <div className="space-y-5">
          <div className="card">
            <h2 className="mb-2 text-sm font-medium text-gris">Base (bbolt) et quota</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
              <dt className="text-gris">dbSize</dt>
              <dd className="font-mono" data-testid="etcd-dbsize">
                {bytes(size)}
              </dd>
              <dt className="text-gris">dbSizeInUse</dt>
              <dd className="font-mono">{bytes(inUse)}</dd>
              <dt className="text-gris">Quota</dt>
              <dd className="font-mono">
                {bytes(d.quotaBytes)}
                {pct !== null && <span className={`ml-2 ${pct > 85 ? "text-panne" : pct > 60 ? "text-alerte" : "text-gris"}`}>{pct} %</span>}
              </dd>
              <dt className="text-gris">Clés</dt>
              <dd className="font-mono">{d.keyCount}</dd>
            </dl>
            <p className="mt-2 text-xs text-gris">Quota = valeur du champ « base » de l&apos;instance (--quota-backend-bytes) ou 2 Gio par défaut. Au-delà du quota, etcd lève l&apos;alarme NOSPACE et passe en lecture seule.</p>
          </div>
          <div className="card">
            <h2 className="mb-2 text-sm font-medium text-gris">/v3/maintenance/status</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
              {Object.entries(d.status).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-gris">{k}</dt>
                  <dd className="truncate font-mono" title={String(v ?? "")}>
                    {String(v ?? "∅")}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Membres</h2>
            <DataTable rows={d.members} />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Alarmes</h2>
            <DataTable rows={d.alarms} empty="Aucune alarme (NOSPACE / CORRUPT)." />
          </div>
        </div>
      );
    }
    case "keys":
      return (
        <div className="space-y-2">
          <p className="text-xs text-gris">
            Nombre de clés par préfixe de premier niveau : clés parcourues sans leurs valeurs (keys_only), {d.scanned} clés lues{d.capped ? ` (plafond ${etcd.PREFIX_SCAN_CAP} atteint : des préfixes au-delà peuvent manquer)` : ""}, puis un comptage exact (count_only) par préfixe. Aucune valeur n&apos;est jamais lue.
          </p>
          <DataTable rows={d.prefixes} empty="Aucune clé." />
        </div>
      );
  }
  return null;
}
