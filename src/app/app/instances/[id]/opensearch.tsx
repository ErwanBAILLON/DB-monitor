import type { Instance } from "@prisma/client";
import * as os from "@/lib/drivers/opensearch";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { QueryConsole } from "@/components/query-console";
import { bytes } from "@/lib/format";
import { runReadOnlyQuery } from "@/app/app/actions";

export const opensearchTabList = [
  { key: "health", label: "Santé" },
  { key: "indices", label: "Index" },
  { key: "nodes", label: "Nœuds" },
  { key: "tasks", label: "Tâches" },
  { key: "query", label: "Recherche" },
];

const COLOR: Record<string, string> = { green: "text-ok", yellow: "text-alerte", red: "text-panne" };

export async function OpensearchTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await os.detail(conn);
  switch (tab) {
    case "health":
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ["Statut", d.health.status, COLOR[String(d.health.status)] ?? ""],
              ["Nœuds", `${d.health.nodes} (${d.health.data_nodes} data)`],
              ["Shards actifs", `${d.health.active_shards} (${d.health.primary_shards} primaires)`],
              ["Non assignés", d.health.unassigned, Number(d.health.unassigned) > 0 ? "text-alerte" : ""],
              ["En relocalisation", d.health.relocating],
              ["En initialisation", d.health.initializing],
              ["Tâches en attente", d.health.pending_tasks],
              ["Shards actifs %", `${d.health.active_shards_pct} %`],
            ].map(([k, v, cls]) => (
              <div key={String(k)} className="card py-3">
                <p className="text-xs text-gris">{String(k)}</p>
                <p className={`font-mono text-lg ${cls ?? ""}`}>{String(v ?? "–")}</p>
              </div>
            ))}
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Tâches cluster en attente (_cluster/pending_tasks)</h2>
            <DataTable rows={d.pendingTasks} empty="Aucune tâche en attente." />
          </div>
          <p className="text-xs text-gris">
            Hot threads : <span className="font-mono">GET {conn.database ?? ""}/_nodes/hot_threads</span> sur l&apos;instance (texte brut, non affiché ici). Aucune suppression d&apos;index n&apos;est proposée.
          </p>
        </div>
      );
    case "indices":
      return <DataTable rows={d.indices.map((i) => ({ ...i, size: bytes(i.size_bytes as string), primary_size: bytes(i.primary_size_bytes as string) }))} columns={["index", "health", "status", "pri", "rep", "docs", "deleted", "size", "primary_size", "created"]} empty="Aucun index." />;
    case "nodes":
      return (
        <DataTable
          rows={d.nodes.map((n) => ({ ...n, heap: `${bytes(n.heap_used_bytes as string)} / ${bytes(n.heap_max_bytes as string)} (${n.heap_pct} %)`, disk_free: `${bytes(n.disk_free_bytes as string)} / ${bytes(n.disk_total_bytes as string)}`, store: bytes(n.store_bytes as string) }))}
          columns={["name", "roles", "version", "heap", "disk_free", "cpu_pct", "load_1m", "docs", "store", "http_open", "search_queue", "search_rejected", "write_rejected", "uptime_s"]}
        />
      );
    case "tasks":
      return <DataTable rows={d.tasks} empty="Aucune tâche search/bulk/reindex en cours." />;
    case "query":
      return (
        <div className="card">
          <QueryConsole
            run={runReadOnlyQuery.bind(null, inst.id)}
            databases={d.indices.map((i) => String(i.index)).filter((n) => !n.startsWith("."))}
            defaultDb={d.indices.map((i) => String(i.index)).find((n) => !n.startsWith("."))}
            hint="Corps JSON d'une recherche (_search) sur l'index choisi : query, sort, _source, aggs ; size <= 100, timeout 5 s, scripts refusés."
            placeholder='{ "query": { "match_all": {} }, "size": 10, "sort": [{ "_doc": "asc" }] }'
            rows={6}
          />
        </div>
      );
  }
  return null;
}
