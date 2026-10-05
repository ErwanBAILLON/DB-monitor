import type { Instance } from "@prisma/client";
import * as crdb from "@/lib/drivers/cockroach";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { ConfirmForm } from "@/components/confirm-form";
import { QueryConsole } from "@/components/query-console";
import { bytes } from "@/lib/format";
import { crdbCancelSession, crdbCreateDatabase, crdbCreateRole, runReadOnlyQuery } from "@/app/app/actions";

// CockroachDB: Postgres wire, crdb_internal introspection. No pg_locks / pg_settings
// / extensions / pg_dump here (cockroach dump was removed upstream; use BACKUP).
export const cockroachTabList = [
  { key: "databases", label: "Bases" },
  { key: "sessions", label: "Sessions" },
  { key: "tables", label: "Tables" },
  { key: "nodes", label: "Nœuds" },
  { key: "roles", label: "Rôles" },
  { key: "settings-crdb", label: "Réglages" },
  { key: "query", label: "Requête" },
  { key: "actions", label: "Actions" },
];

export async function CockroachTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await crdb.detail(conn);
  const dbNames = d.databases.map((x) => String(x.name));
  switch (tab) {
    case "databases":
      return <DataTable rows={d.databases.map((x) => ({ ...x, size: bytes(x.size_bytes as string) }))} columns={["name", "owner", "size", "ranges", "tables"]} />;
    case "sessions":
      return (
        <DataTable
          rows={d.sessions}
          empty="Aucune autre session."
          columns={["session_id", "node_id", "user", "client", "app", "status", "age_s", "active_queries", "last_query"]}
          actions={(r) => (
            <ConfirmForm action={crdbCancelSession} label="annuler" danger confirm={`CANCEL SESSION ${String(r.session_id).slice(0, 8)}… (${r.user}) ?`} className="inline-flex">
              <input type="hidden" name="id" value={inst.id} />
              <input type="hidden" name="sessionId" value={String(r.session_id)} />
            </ConfirmForm>
          )}
        />
      );
    case "tables": {
      const current = inst.database && dbNames.includes(inst.database) ? inst.database : dbNames.find((n) => !["system", "postgres"].includes(n)) ?? dbNames[0];
      const rows = current ? await crdb.tables(conn, current) : [];
      return (
        <div className="space-y-3">
          <p className="text-xs text-gris">
            Tables de <span className="font-mono">{current}</span> (lignes estimées, taille des ranges). Changez la base par défaut dans Paramètres pour inspecter une autre base.
          </p>
          <DataTable rows={rows.map((r) => ({ ...r, size: bytes(r.size_bytes as string) }))} columns={["schema", "table", "est_rows", "size", "ranges", "mod_time"]} empty="Aucune table utilisateur." />
        </div>
      );
    }
    case "nodes":
      return <DataTable rows={d.nodes} />;
    case "roles":
      return <DataTable rows={d.roles} />;
    case "settings-crdb":
      return (
        <div className="space-y-5">
          <DataTable rows={d.settings} />
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Jobs récents</h2>
            <DataTable rows={d.jobs} empty="Aucun job." />
          </div>
        </div>
      );
    case "query":
      return (
        <div className="card">
          <QueryConsole run={runReadOnlyQuery.bind(null, inst.id)} databases={dbNames} defaultDb={inst.database ?? "defaultdb"} placeholder="SELECT * FROM crdb_internal.node_statement_statistics LIMIT 20" />
        </div>
      );
    case "actions":
      return (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card">
            <h2 className="mb-2 text-sm font-medium">Créer une base</h2>
            <ConfirmForm action={crdbCreateDatabase} label="Créer la base" confirm="Créer cette base ?" className="grid grid-cols-1 gap-3" testId="create-db-form">
              <input type="hidden" name="id" value={inst.id} />
              <label className="text-sm">
                <span className="label">Nom</span>
                <input name="name" className="field font-mono" required pattern="[a-z_][a-z0-9_]{0,62}" placeholder="mon_app" />
              </label>
              <label className="text-sm">
                <span className="label">Propriétaire (rôle existant, optionnel)</span>
                <input name="owner" className="field font-mono" pattern="[a-z_][a-z0-9_]{0,62}" />
              </label>
            </ConfirmForm>
          </div>
          <div className="card">
            <h2 className="mb-2 text-sm font-medium">Créer un rôle</h2>
            <p className="mb-3 text-xs text-gris">Un nœud --insecure refuse les mots de passe : laissez la case décochée dans ce cas.</p>
            <ConfirmForm action={crdbCreateRole} label="Créer le rôle" confirm="Créer ce rôle ?" className="grid grid-cols-1 gap-3" testId="create-role-form">
              <input type="hidden" name="id" value={inst.id} />
              <label className="text-sm">
                <span className="label">Nom</span>
                <input name="name" className="field font-mono" required pattern="[a-z_][a-z0-9_]{0,62}" />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input name="withPassword" type="checkbox" /> Mot de passe généré (cluster sécurisé)
              </label>
            </ConfirmForm>
          </div>
        </div>
      );
  }
  return null;
}
