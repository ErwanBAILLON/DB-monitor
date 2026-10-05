import type { Instance } from "@prisma/client";
import * as mysql from "@/lib/drivers/mysql";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { ConfirmForm } from "@/components/confirm-form";
import { QueryConsole } from "@/components/query-console";
import { bytes } from "@/lib/format";
import { myCreateDatabase, myKill, runReadOnlyQuery } from "@/app/app/actions";

export const mysqlTabList = [
  { key: "databases", label: "Bases" },
  { key: "processlist", label: "Processlist" },
  { key: "variables", label: "Variables" },
  { key: "replication", label: "Réplication" },
  { key: "query", label: "Requête" },
  { key: "actions", label: "Actions" },
];

export async function MysqlTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await mysql.detail(conn);
  const dbs = d.databases.map((x) => ({ ...x, size: bytes(x.size_bytes as string) }));
  switch (tab) {
    case "databases":
      return (
        <div className="space-y-3">
          <DataTable
            rows={dbs}
            columns={["name", "charset", "collation", "size", "tables"]}
            actions={(r) =>
              /^[a-z_][a-z0-9_]{0,63}$/.test(String(r.name)) ? (
                <a className="link text-xs" href={`/api/instances/${inst.id}/dump?db=${encodeURIComponent(String(r.name))}`} download>
                  dump .sql.gz
                </a>
              ) : null
            }
          />
          <p className="text-xs text-gris">
            Serveur {d.flavour === "mariadb" ? "MariaDB" : "MySQL"}. Le dump (mariadb-dump, --single-transaction, routines et triggers) est streamé et journalisé dans l&apos;audit.
          </p>
        </div>
      );
    case "processlist":
      return (
        <DataTable
          rows={d.processlist}
          empty="Aucune autre session."
          actions={(r) => (
            <ConfirmForm action={myKill} label="kill" danger confirm={`KILL ${r.id} (${r.user}@${r.host}) ?`} className="inline-flex">
              <input type="hidden" name="id" value={inst.id} />
              <input type="hidden" name="pid" value={String(r.id)} />
            </ConfirmForm>
          )}
        />
      );
    case "variables":
      return (
        <div className="space-y-5">
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Variables globales</h2>
            <DataTable rows={d.variables} />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Compteurs (SHOW GLOBAL STATUS)</h2>
            <DataTable rows={d.status} />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Comptes (mysql.user)</h2>
            <DataTable rows={d.users} empty="Lecture de mysql.user refusée." />
          </div>
        </div>
      );
    case "replication":
      return d.replication ? (
        <DataTable rows={[d.replication]} />
      ) : (
        <p className="py-3 text-sm text-gris" data-testid="no-replication">
          Ce serveur n&apos;est pas un réplica (SHOW REPLICA STATUS vide).
        </p>
      );
    case "query":
      return (
        <div className="card">
          <QueryConsole
            run={runReadOnlyQuery.bind(null, inst.id)}
            databases={d.databases.map((x) => String(x.name))}
            defaultDb={inst.database ?? "information_schema"}
            hint={`SELECT / SHOW / EXPLAIN / DESCRIBE uniquement, transaction READ ONLY, ${d.flavour === "mariadb" ? "max_statement_time" : "max_execution_time"} 5 s, 500 lignes.`}
            placeholder="SHOW ENGINE INNODB STATUS"
          />
        </div>
      );
    case "actions":
      return (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card">
            <h2 className="mb-2 text-sm font-medium">Créer une base</h2>
            <p className="mb-3 text-xs text-gris">CREATE DATABASE utf8mb4 et, si demandé, un utilisateur dédié (ALL PRIVILEGES sur cette base, hôte %) avec mot de passe généré, affiché une seule fois.</p>
            <ConfirmForm action={myCreateDatabase} label="Créer la base" confirm="Créer cette base ?" className="grid grid-cols-1 gap-3" testId="create-db-form">
              <input type="hidden" name="id" value={inst.id} />
              <label className="text-sm">
                <span className="label">Nom</span>
                <input name="name" className="field font-mono" required pattern="[a-z_][a-z0-9_]{0,63}" placeholder="mon_app" />
              </label>
              <label className="text-sm">
                <span className="label">Utilisateur dédié (optionnel)</span>
                <input name="user" className="field font-mono" pattern="[a-z_][a-z0-9_]{0,31}" placeholder="mon_app" />
              </label>
            </ConfirmForm>
          </div>
        </div>
      );
  }
  return null;
}
