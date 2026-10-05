import type { Instance } from "@prisma/client";
import * as mongo from "@/lib/drivers/mongodb";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { ConfirmForm } from "@/components/confirm-form";
import { QueryConsole } from "@/components/query-console";
import { bytes } from "@/lib/format";
import { mongoCreateDatabase, mongoKillOp, runReadOnlyQuery } from "@/app/app/actions";

export const mongoTabList = [
  { key: "server", label: "Serveur" },
  { key: "databases", label: "Bases" },
  { key: "collections", label: "Collections" },
  { key: "currentop", label: "Opérations" },
  { key: "replset", label: "Replica set" },
  { key: "query", label: "Requête" },
  { key: "actions", label: "Actions" },
];

export async function MongoTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await mongo.detail(conn);
  const dbNames = d.databases.map((x) => String(x.name));
  switch (tab) {
    case "server":
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ["Version", d.server.version],
              ["Moteur", d.server.storage_engine],
              ["Connexions", `${d.server.connections_current} / ${Number(d.server.connections_current) + Number(d.server.connections_available)}`],
              ["RSS", `${d.mem.resident_mb ?? "–"} Mio`],
              ["Cache WiredTiger", `${bytes(d.mem.wiredtiger_cache_bytes as string)} / ${bytes(d.mem.wiredtiger_cache_max_bytes as string)}`],
              ["Requêtes (query)", d.server.ops_query],
              ["Insertions", d.server.ops_insert],
              ["Mises à jour", d.server.ops_update],
            ].map(([k, v]) => (
              <div key={String(k)} className="card py-3">
                <p className="text-xs text-gris">{String(k)}</p>
                <p className="font-mono text-lg">{String(v ?? "–")}</p>
              </div>
            ))}
          </div>
          <DataTable rows={[d.server]} />
        </div>
      );
    case "databases":
      return <DataTable rows={d.databases.map((x) => ({ ...x, size: bytes(x.size_bytes as number) }))} columns={["name", "size", "size_bytes", "empty"]} />;
    case "collections": {
      const current = inst.database && dbNames.includes(inst.database) && inst.database !== "admin" ? inst.database : dbNames.find((n) => !["admin", "local", "config"].includes(n)) ?? dbNames[0];
      const rows = current ? await mongo.collections(conn, current) : [];
      return (
        <div className="space-y-3">
          <p className="text-xs text-gris">
            Collections de <span className="font-mono">{current}</span> avec documents, taille, stockage et index ($collStats). Changez la base par défaut dans Paramètres pour inspecter une autre base.
          </p>
          <DataTable rows={rows.map((r) => ({ ...r, size: bytes(r.size_bytes as number), storage: bytes(r.storage_bytes as number), index_size: bytes(r.index_bytes as number) }))} columns={["name", "type", "documents", "size", "storage", "indexes", "index_size", "index_names"]} empty="Aucune collection." />
        </div>
      );
    }
    case "currentop":
      return (
        <DataTable
          rows={d.currentOp}
          empty="Aucune opération en cours."
          columns={["opid", "active", "secs_running", "op", "ns", "client", "app", "user", "waiting_for_lock", "command"]}
          actions={(r) => (
            <ConfirmForm action={mongoKillOp} label="killOp" danger confirm={`killOp ${r.opid} ?`} className="inline-flex">
              <input type="hidden" name="id" value={inst.id} />
              <input type="hidden" name="opid" value={String(r.opid)} />
            </ConfirmForm>
          )}
        />
      );
    case "replset":
      return d.replicaSet ? <DataTable rows={d.replicaSet} /> : <p className="py-3 text-sm text-gris" data-testid="no-replset">Instance autonome (pas de replica set).</p>;
    case "query":
      return (
        <div className="card">
          <QueryConsole
            run={runReadOnlyQuery.bind(null, inst.id)}
            databases={dbNames}
            defaultDb={inst.database && inst.database !== "admin" ? inst.database : dbNames.find((n) => !["admin", "local", "config"].includes(n))}
            hint="Spécification JSON : {collection, filter, projection, sort, limit <= 200} ou {collection, pipeline}. readPreference secondaryPreferred, maxTimeMS 5 s. $where, $function, $accumulator, $out, $merge refusés."
            placeholder='{ "collection": "users", "filter": { "active": true }, "limit": 20 }'
            rows={6}
          />
        </div>
      );
    case "actions":
      return (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card">
            <h2 className="mb-2 text-sm font-medium">Créer une base</h2>
            <p className="mb-3 text-xs text-gris">Crée la base (collection _dbmon_init) et, si demandé, un utilisateur readWrite sur cette base avec mot de passe généré, affiché une seule fois. Aucune suppression n&apos;est proposée.</p>
            <ConfirmForm action={mongoCreateDatabase} label="Créer la base" confirm="Créer cette base ?" className="grid grid-cols-1 gap-3" testId="create-db-form">
              <input type="hidden" name="id" value={inst.id} />
              <label className="text-sm">
                <span className="label">Nom</span>
                <input name="name" className="field font-mono" required pattern="[A-Za-z0-9_\-]{1,63}" placeholder="mon_app" />
              </label>
              <label className="text-sm">
                <span className="label">Utilisateur readWrite (optionnel)</span>
                <input name="user" className="field font-mono" pattern="[A-Za-z0-9_\-]{1,63}" placeholder="mon_app" />
              </label>
            </ConfirmForm>
          </div>
        </div>
      );
  }
  return null;
}
