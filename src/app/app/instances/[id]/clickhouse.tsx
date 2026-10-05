import type { Instance } from "@prisma/client";
import * as ch from "@/lib/drivers/clickhouse";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { ConfirmForm } from "@/components/confirm-form";
import { QueryConsole } from "@/components/query-console";
import { bytes } from "@/lib/format";
import { chKillQuery, runReadOnlyQuery } from "@/app/app/actions";

export const clickhouseTabList = [
  { key: "databases", label: "Bases" },
  { key: "tables", label: "Tables" },
  { key: "processes", label: "Requêtes" },
  { key: "merges", label: "Merges" },
  { key: "replication", label: "Réplication" },
  { key: "metrics", label: "Métriques" },
  { key: "query", label: "Requête" },
];

export async function ClickhouseTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await ch.detail(conn);
  switch (tab) {
    case "databases":
      return <DataTable rows={d.databases.map((x) => ({ ...x, size: bytes(x.size_bytes as string) }))} columns={["name", "engine", "tables", "rows", "size"]} />;
    case "tables":
      return <DataTable rows={d.tables} columns={["database", "table", "rows", "size", "uncompressed_bytes", "parts", "last_modified"]} empty="Aucune part active (tables MergeTree vides)." />;
    case "processes":
      return (
        <DataTable
          rows={d.processes}
          empty="Aucune autre requête en cours."
          actions={(r) => (
            <ConfirmForm action={chKillQuery} label="kill" danger confirm={`KILL QUERY ${r.query_id} ?`} className="inline-flex">
              <input type="hidden" name="id" value={inst.id} />
              <input type="hidden" name="queryId" value={String(r.query_id)} />
            </ConfirmForm>
          )}
        />
      );
    case "merges":
      return <DataTable rows={d.merges} empty="Aucun merge ni mutation en cours." />;
    case "replication":
      return <DataTable rows={d.replication} empty="Aucune table répliquée (system.replicas vide)." />;
    case "metrics":
      return (
        <div className="space-y-5">
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">system.metrics / system.asynchronous_metrics</h2>
            <DataTable rows={d.metrics} />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Réglages serveur</h2>
            <DataTable rows={d.settings} />
          </div>
        </div>
      );
    case "query":
      return (
        <div className="card">
          <QueryConsole
            run={runReadOnlyQuery.bind(null, inst.id)}
            databases={d.databases.map((x) => String(x.name))}
            defaultDb={inst.database ?? "default"}
            hint="SELECT / SHOW / DESCRIBE / EXISTS / EXPLAIN uniquement ; exécuté avec readonly=1 et max_execution_time=5 côté serveur, 500 lignes."
            placeholder="SELECT * FROM system.query_log ORDER BY event_time DESC LIMIT 20"
          />
        </div>
      );
  }
  return null;
}
