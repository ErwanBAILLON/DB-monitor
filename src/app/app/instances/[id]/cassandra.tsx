import type { Instance } from "@prisma/client";
import * as cs from "@/lib/drivers/cassandra";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { QueryConsole } from "@/components/query-console";
import { bytes } from "@/lib/format";
import { runReadOnlyQuery } from "@/app/app/actions";

export const cassandraTabList = [
  { key: "node", label: "Nœud" },
  { key: "keyspaces", label: "Keyspaces" },
  { key: "tables", label: "Tables" },
  { key: "clients", label: "Clients" },
  { key: "compaction", label: "Compaction" },
  { key: "query", label: "Requête CQL" },
];

export async function CassandraTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await cs.detail(conn);
  switch (tab) {
    case "node":
      return (
        <div className="space-y-5">
          <div className="card">
            <h2 className="mb-2 text-sm font-medium text-gris">system.local</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
              {Object.entries(d.local).map(([k, v]) => (
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
            <h2 className="mb-2 text-sm font-medium text-gris">system.runtime_info (Scylla)</h2>
            <DataTable rows={d.runtime} empty="Vue absente (Cassandra)." maxHeight="40vh" />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Pairs (system.peers)</h2>
            <DataTable rows={d.peers} empty="Nœud seul : aucun pair." />
          </div>
        </div>
      );
    case "keyspaces":
      return <DataTable rows={d.keyspaces.map((k) => ({ ...k, size_est: bytes(k.size_bytes_est as number) }))} columns={["keyspace_name", "durable_writes", "replication", "tables", "size_est"]} />;
    case "tables":
      return (
        <div className="space-y-2">
          <p className="text-xs text-gris">Tailles et partitions estimées par system.size_estimates (rafraîchi périodiquement par le nœud, 0 sur les petites tables).</p>
          <DataTable rows={d.tables.map((t) => ({ ...t, size_est: bytes(t.size_bytes_est as number | null) }))} columns={["keyspace", "table", "partitions_est", "size_est", "compaction", "ttl", "gc_grace"]} />
        </div>
      );
    case "clients":
      return (
        <div className="space-y-2">
          <p className="text-xs text-gris">{d.clientsSource ? `Source : ${d.clientsSource}` : "Ni system.clients (Scylla) ni system_views.clients (Cassandra 4) ne sont exposées sur ce nœud."}</p>
          <DataTable rows={d.clients} empty="Aucune connexion cliente listée." />
        </div>
      );
    case "compaction":
      return (
        <div className="space-y-5">
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Compactions (system_views.sstable_tasks, sinon historique system.compaction_history)</h2>
            <DataTable rows={d.compactions} empty="Aucune compaction en cours ni historisée." />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Streams (system_views.streaming, Cassandra 4 uniquement)</h2>
            <DataTable rows={d.streams} empty="Aucun stream (ou vue absente sur ce moteur)." />
          </div>
        </div>
      );
    case "query":
      return (
        <div className="card">
          <QueryConsole
            run={runReadOnlyQuery.bind(null, inst.id)}
            databases={d.keyspaces.map((k) => String(k.keyspace_name)).filter((k) => k !== "system_auth")}
            defaultDb={inst.database ?? "system"}
            hint={`SELECT uniquement (CQL) ; LIMIT forcé à ${cs.CONSOLE_LIMIT}, consistance LOCAL_ONE, 5 s max ; system_auth exclu.`}
            placeholder="SELECT keyspace_name, table_name FROM system_schema.tables"
          />
        </div>
      );
  }
  return null;
}
