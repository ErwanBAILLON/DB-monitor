import type { Instance } from "@prisma/client";
import * as ix from "@/lib/drivers/influxdb";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { QueryConsole } from "@/components/query-console";
import { runReadOnlyQuery } from "@/app/app/actions";

export const influxTabList = [
  { key: "server", label: "Serveur" },
  { key: "buckets", label: "Buckets" },
  { key: "tasks", label: "Tâches" },
  { key: "query", label: "Flux" },
];

export async function InfluxTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await ix.detail(conn);
  switch (tab) {
    case "server":
      return (
        <div className="space-y-5">
          <div className="card">
            <h2 className="mb-2 text-sm font-medium text-gris">/health et /ready</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
              {Object.entries({ ...d.health, ...d.ready }).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-gris">{k}</dt>
                  <dd className="truncate font-mono" title={String(v ?? "")}>
                    {Array.isArray(v) || (v && typeof v === "object") ? JSON.stringify(v) : String(v ?? "∅")}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Organisations</h2>
            <DataTable rows={d.orgs} columns={["name", "buckets", "description", "created", "id"]} />
          </div>
        </div>
      );
    case "buckets":
      return (
        <div className="space-y-2">
          <p className="text-xs text-gris">Cardinalité = séries distinctes sur 30 jours (influxdb.cardinality), par bucket utilisateur.{d.cardinalityNote ? ` Erreur sur au moins un bucket : ${d.cardinalityNote}` : ""}</p>
          <DataTable rows={d.buckets} columns={["name", "org", "type", "retention", "shard_group", "cardinality_30d", "created"]} />
        </div>
      );
    case "tasks":
      return <DataTable rows={d.tasks} columns={["name", "org", "status", "every", "cron", "last_run_status", "last_run_started", "last_run_finished", "last_error"]} empty="Aucune tâche Flux définie." />;
    case "query":
      return (
        <div className="card">
          <QueryConsole
            run={runReadOnlyQuery.bind(null, inst.id)}
            databases={d.orgs.map((o) => String(o.name))}
            defaultDb={inst.database ?? String(d.orgs[0]?.name ?? "")}
            hint={`Flux en lecture seule : range() obligatoire, to() / experimental / http / sql / secrets refusés, limit(n: ${ix.CONSOLE_LIMIT}) ajouté, 5 s max.`}
            placeholder={'from(bucket: "metrics")\n  |> range(start: -1h)\n  |> filter(fn: (r) => r._measurement == "cpu")'}
            rows={6}
          />
        </div>
      );
  }
  return null;
}
