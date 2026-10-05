import type { Instance } from "@prisma/client";
import * as sq from "@/lib/drivers/sqlite";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { ConfirmForm } from "@/components/confirm-form";
import { QueryConsole } from "@/components/query-console";
import { runReadOnlyQuery, sqliteIntegrity } from "@/app/app/actions";

export const sqliteTabList = [
  { key: "file", label: "Fichier" },
  { key: "tables", label: "Tables" },
  { key: "indexes", label: "Index" },
  { key: "query", label: "Requête" },
];

export async function SqliteTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await sq.detail(conn);
  switch (tab) {
    case "file":
      return (
        <div className="space-y-4">
          <DataTable rows={[d.file]} />
          <DataTable rows={d.pragmas} />
          <ConfirmForm action={sqliteIntegrity} label="PRAGMA integrity_check (complet)" confirm="Lancer integrity_check ? Peut être long sur un gros fichier." testId="integrity-form">
            <input type="hidden" name="id" value={inst.id} />
          </ConfirmForm>
          <p className="text-xs text-gris">Fichier ouvert en lecture seule (SQLITE_OPEN_READONLY). Aucune action d&apos;écriture n&apos;existe pour ce moteur.</p>
        </div>
      );
    case "tables":
      return <DataTable rows={d.tables} empty="Aucune table." />;
    case "indexes":
      return <DataTable rows={d.indexes} empty="Aucun index." />;
    case "query":
      return (
        <div className="card">
          <QueryConsole run={runReadOnlyQuery.bind(null, inst.id)} hint="SELECT / WITH / EXPLAIN / PRAGMA (lecture) uniquement, fichier ouvert en lecture seule, 500 lignes." placeholder="SELECT name FROM sqlite_master WHERE type = 'table'" />
        </div>
      );
  }
  return null;
}
