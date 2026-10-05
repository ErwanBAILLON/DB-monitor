import type { Instance } from "@prisma/client";
import * as ms from "@/lib/drivers/mssql";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { ConfirmForm } from "@/components/confirm-form";
import { QueryConsole } from "@/components/query-console";
import { bytes } from "@/lib/format";
import { msCreateDatabase, msKill, runReadOnlyQuery } from "@/app/app/actions";

export const mssqlTabList = [
  { key: "databases", label: "Bases" },
  { key: "sessions", label: "Sessions" },
  { key: "blocking", label: "Blocages" },
  { key: "config", label: "Configuration" },
  { key: "query", label: "Requête" },
  { key: "actions", label: "Actions" },
];

export async function MssqlTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await ms.detail(conn);
  const dbNames = d.databases.map((x) => String(x.name));
  switch (tab) {
    case "databases":
      return <DataTable rows={d.databases.map((x) => ({ ...x, data: bytes(x.data_bytes as string), log: bytes(x.log_bytes as string), size: bytes(x.size_bytes as string) }))} columns={["name", "state", "recovery", "compat", "owner", "read_only", "data", "log", "size", "collation"]} />;
    case "sessions":
      return (
        <div className="space-y-5">
          {d.requests.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-medium text-gris">Requêtes en cours (sys.dm_exec_requests)</h2>
              <DataTable rows={d.requests} />
            </div>
          )}
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Sessions utilisateur ({d.sessions.length})</h2>
            <DataTable
              rows={d.sessions}
              empty="Aucune autre session utilisateur."
              actions={(r) => (
                <ConfirmForm action={msKill} label="kill" danger confirm={`KILL ${r.session_id} (${r.login}@${r.host}) ?`} className="inline-flex">
                  <input type="hidden" name="id" value={inst.id} />
                  <input type="hidden" name="sessionId" value={String(r.session_id)} />
                </ConfirmForm>
              )}
            />
          </div>
        </div>
      );
    case "blocking":
      return (
        <div className="space-y-5">
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Chaînes de blocage</h2>
            <DataTable rows={d.blocking} empty="Aucun blocage en cours." />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Top attentes (sys.dm_os_wait_stats, cumul depuis le démarrage)</h2>
            <DataTable rows={d.waits} />
          </div>
        </div>
      );
    case "config":
      return (
        <div className="space-y-5">
          <DataTable rows={d.config} />
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Logins (sys.server_principals)</h2>
            <DataTable rows={d.logins} />
          </div>
        </div>
      );
    case "query":
      return (
        <div className="card">
          <QueryConsole
            run={runReadOnlyQuery.bind(null, inst.id)}
            databases={dbNames}
            defaultDb={inst.database ?? "master"}
            hint="SELECT / WITH / EXEC sp_help* uniquement, READ COMMITTED, LOCK_TIMEOUT 5 s, 500 lignes. SQL Server n'a pas de transaction READ ONLY : le garde-fou syntaxique et les droits du login sont les seules barrières (voir docs/engines.md)."
            placeholder="SELECT TOP 20 * FROM sys.dm_exec_requests"
          />
        </div>
      );
    case "actions":
      return (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card">
            <h2 className="mb-2 text-sm font-medium">Créer une base</h2>
            <p className="mb-3 text-xs text-gris">CREATE DATABASE et, si demandé, un login SQL (mot de passe généré, affiché une seule fois) mappé en db_owner de cette base uniquement.</p>
            <ConfirmForm action={msCreateDatabase} label="Créer la base" confirm="Créer cette base ?" className="grid grid-cols-1 gap-3" testId="create-db-form">
              <input type="hidden" name="id" value={inst.id} />
              <label className="text-sm">
                <span className="label">Nom</span>
                <input name="name" className="field font-mono" required pattern="[A-Za-z_][A-Za-z0-9_]{0,63}" placeholder="MonApp" />
              </label>
              <label className="text-sm">
                <span className="label">Login dédié (optionnel)</span>
                <input name="login" className="field font-mono" pattern="[A-Za-z_][A-Za-z0-9_]{0,63}" placeholder="monapp" />
              </label>
            </ConfirmForm>
          </div>
        </div>
      );
  }
  return null;
}
