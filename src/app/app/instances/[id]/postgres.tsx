import type { Instance } from "@prisma/client";
import * as pg from "@/lib/drivers/postgres";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { ConfirmForm } from "@/components/confirm-form";
import { QueryConsole } from "@/components/query-console";
import { pgCreateDatabase, pgCreateRole, pgTerminate, runReadOnlyQuery } from "@/app/app/actions";

export const postgresTabList = [
  { key: "databases", label: "Bases" },
  { key: "sessions", label: "Sessions" },
  { key: "locks", label: "Verrous" },
  { key: "tables", label: "Tables" },
  { key: "roles", label: "Rôles" },
  { key: "settings-pg", label: "Réglages PG" },
  { key: "query", label: "Requête" },
  { key: "actions", label: "Actions" },
];

export async function PostgresTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await pg.detail(conn);
  const dbNames = d.databases.map((x) => String(x.name));
  switch (tab) {
    case "databases":
      return (
        <div className="space-y-3">
          <DataTable
            rows={d.databases}
            columns={["name", "owner", "size", "sessions", "encoding_name", "allow_conn"]}
            actions={(r) => (
              <a className="link text-xs" href={`/api/instances/${inst.id}/dump?db=${encodeURIComponent(String(r.name))}`} download>
                dump .sql.gz
              </a>
            )}
          />
          <p className="text-xs text-gris">Le dump (pg_dump, format plain, sans owner ni privilèges) est streamé et journalisé dans l&apos;audit. La restauration n&apos;est pas proposée ici.</p>
        </div>
      );
    case "sessions":
      return (
        <div className="space-y-5">
          {d.longQueries.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-medium text-alerte">Requêtes longues (&gt; 5 s)</h2>
              <DataTable rows={d.longQueries} />
            </div>
          )}
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">pg_stat_activity ({d.sessions.length})</h2>
            <DataTable
              rows={d.sessions}
              columns={["pid", "user", "database", "app", "client", "state", "wait_type", "wait_event", "backend_type", "state_age_s", "query"]}
              actions={(r) =>
                r.backend_type === "client backend" ? (
                  <ConfirmForm action={pgTerminate} label="terminer" danger confirm={`Terminer le backend ${r.pid} (${r.user}@${r.database}) ?`} className="inline-flex">
                    <input type="hidden" name="id" value={inst.id} />
                    <input type="hidden" name="pid" value={String(r.pid)} />
                  </ConfirmForm>
                ) : null
              }
            />
          </div>
        </div>
      );
    case "locks":
      return (
        <div>
          <h2 className="mb-2 text-sm font-medium text-gris">Verrous non accordés ou exclusifs</h2>
          <DataTable rows={d.locks} empty="Aucun verrou en attente ni exclusif." />
        </div>
      );
    case "tables":
      return <TablesTab inst={inst} conn={conn} dbNames={dbNames} />;
    case "roles":
      return <DataTable rows={d.roles} />;
    case "settings-pg":
      return (
        <div className="space-y-5">
          <DataTable rows={d.settings} columns={["name", "setting", "unit", "source", "short_desc"]} />
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Extensions installées ({d.extensions.length})</h2>
            <DataTable rows={d.extensions} />
          </div>
        </div>
      );
    case "query":
      return (
        <div className="card">
          <QueryConsole run={runReadOnlyQuery.bind(null, inst.id)} databases={dbNames} defaultDb={inst.database ?? "postgres"} />
        </div>
      );
    case "actions":
      return (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card">
            <h2 className="mb-2 text-sm font-medium">Créer une base</h2>
            <p className="mb-3 text-xs text-gris">Crée la base, révoque PUBLIC, et si demandé un rôle propriétaire avec mot de passe généré, affiché une seule fois.</p>
            <ConfirmForm action={pgCreateDatabase} label="Créer la base" confirm="Créer cette base ?" className="grid grid-cols-1 gap-3" testId="create-db-form">
              <input type="hidden" name="id" value={inst.id} />
              <label className="text-sm">
                <span className="label">Nom</span>
                <input name="name" className="field font-mono" required pattern="[a-z_][a-z0-9_]{0,62}" placeholder="mon_app" />
              </label>
              <label className="text-sm">
                <span className="label">Propriétaire (rôle)</span>
                <input name="owner" className="field font-mono" pattern="[a-z_][a-z0-9_]{0,62}" placeholder="mon_app" />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input name="createOwner" type="checkbox" defaultChecked /> Créer le rôle s&apos;il n&apos;existe pas (mot de passe généré)
              </label>
            </ConfirmForm>
          </div>
          <div className="card">
            <h2 className="mb-2 text-sm font-medium">Créer un rôle</h2>
            <p className="mb-3 text-xs text-gris">Rôle LOGIN avec mot de passe généré (24 caractères), affiché une seule fois et jamais journalisé.</p>
            <ConfirmForm action={pgCreateRole} label="Créer le rôle" confirm="Créer ce rôle ?" className="grid grid-cols-1 gap-3" testId="create-role-form">
              <input type="hidden" name="id" value={inst.id} />
              <label className="text-sm">
                <span className="label">Nom</span>
                <input name="name" className="field font-mono" required pattern="[a-z_][a-z0-9_]{0,62}" />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input name="createdb" type="checkbox" /> CREATEDB
              </label>
            </ConfirmForm>
          </div>
        </div>
      );
  }
  return null;
}

async function TablesTab({ inst, conn, dbNames }: { inst: Instance; conn: Conn; dbNames: string[] }) {
  // Server component reading ?db= is not available here; show the maintenance db and links.
  const current = inst.database && dbNames.includes(inst.database) ? inst.database : dbNames[0];
  const rows = current ? await pg.topTables(conn, current) : [];
  return (
    <div className="space-y-3">
      <p className="text-xs text-gris">
        Top 30 tables par taille dans <span className="font-mono">{current}</span> (base par défaut de l&apos;instance ; changez-la dans Paramètres pour inspecter une autre base). dead_pct élevé = candidat VACUUM.
      </p>
      <DataTable rows={rows} columns={["schema", "table", "total", "heap", "indexes", "est_rows", "dead_rows", "dead_pct", "last_autovacuum"]} empty="Aucune table utilisateur." />
    </div>
  );
}
