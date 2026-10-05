import type { Instance } from "@prisma/client";
import * as neo from "@/lib/drivers/neo4j";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { ConfirmForm } from "@/components/confirm-form";
import { QueryConsole } from "@/components/query-console";
import { bytes } from "@/lib/format";
import { neoTerminate, runReadOnlyQuery } from "@/app/app/actions";

export const neo4jTabList = [
  { key: "databases", label: "Bases" },
  { key: "transactions", label: "Transactions" },
  { key: "graph", label: "Graphe" },
  { key: "schema", label: "Index & contraintes" },
  { key: "connections", label: "Connexions" },
  { key: "query", label: "Cypher" },
];

export async function Neo4jTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await neo.detail(conn);
  switch (tab) {
    case "databases":
      return (
        <div className="space-y-5">
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">SHOW DATABASES{d.sizesAvailable ? "" : " (taille du store : métrique Enterprise uniquement, absente ici)"}</h2>
            <DataTable rows={d.databases.map((x) => ({ ...x, store_size: d.sizesAvailable ? bytes(x.store_size_bytes as number | null) : "n/d" }))} columns={["name", "type", "access", "role", "currentStatus", "statusMessage", "default", "home", "store_size", "address"]} />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">dbms.components()</h2>
            <DataTable rows={d.components} />
          </div>
        </div>
      );
    case "transactions":
      return (
        <DataTable
          rows={d.transactions}
          columns={["transactionId", "database", "username", "status", "elapsedTime", "startTime", "clientAddress", "currentQueryAllocatedBytes", "pageHits", "pageFaults", "currentQuery"]}
          empty="Aucune autre transaction en cours."
          actions={(r) =>
            String(r.currentQuery ?? "").includes("SHOW TRANSACTIONS") ? null : (
              <ConfirmForm action={neoTerminate} label="terminer" danger confirm={`TERMINATE TRANSACTIONS "${r.transactionId}" ?`} className="inline-flex">
                <input type="hidden" name="id" value={inst.id} />
                <input type="hidden" name="transactionId" value={String(r.transactionId)} />
              </ConfirmForm>
            )
          }
        />
      );
    case "graph":
      return (
        <div className="space-y-5">
          <div className="card">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
              <dt className="text-gris">Base</dt>
              <dd className="font-mono">{conn.database || "neo4j"}</dd>
              <dt className="text-gris">Nœuds</dt>
              <dd className="font-mono" data-testid="neo-nodes">
                {d.counts.nodes}
              </dd>
              <dt className="text-gris">Relations</dt>
              <dd className="font-mono">{d.counts.relationships}</dd>
            </dl>
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <h2 className="mb-2 text-sm font-medium text-gris">Nœuds par label</h2>
              <DataTable rows={d.counts.labels} empty="Aucun label." />
            </div>
            <div>
              <h2 className="mb-2 text-sm font-medium text-gris">Relations par type</h2>
              <DataTable rows={d.counts.relTypes} empty="Aucune relation." />
            </div>
          </div>
        </div>
      );
    case "schema":
      return (
        <div className="space-y-5">
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">SHOW INDEXES</h2>
            <DataTable rows={d.indexes} empty="Aucun index." />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">SHOW CONSTRAINTS</h2>
            <DataTable rows={d.constraints} empty="Aucune contrainte." />
          </div>
        </div>
      );
    case "connections":
      return <DataTable rows={d.connections} empty="dbms.listConnections() indisponible ou aucune connexion." />;
    case "query":
      return (
        <div className="card">
          <QueryConsole
            run={runReadOnlyQuery.bind(null, inst.id)}
            databases={d.databases.map((x) => String(x.name)).filter((n) => n !== "system")}
            defaultDb={inst.database ?? "neo4j"}
            hint={`Cypher en lecture : session en mode READ (refus serveur des écritures), timeout de transaction 5 s, LIMIT ${neo.CONSOLE_LIMIT} ; CREATE/MERGE/DELETE/SET/REMOVE/LOAD CSV, dbms.* d'administration et apoc.* refusés.`}
            placeholder="MATCH (n) RETURN labels(n) AS labels, count(*) AS n ORDER BY n DESC"
          />
        </div>
      );
  }
  return null;
}
