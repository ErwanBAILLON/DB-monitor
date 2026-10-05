import type { Instance } from "@prisma/client";
import * as rmq from "@/lib/drivers/rabbitmq";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { bytes } from "@/lib/format";

export const rabbitmqTabList = [
  { key: "overview-rmq", label: "Broker" },
  { key: "queues", label: "Files" },
  { key: "connections", label: "Connexions" },
  { key: "channels", label: "Canaux" },
  { key: "exchanges", label: "Exchanges & vhosts" },
];

export async function RabbitmqTabs({ conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await rmq.detail(conn);
  switch (tab) {
    case "overview-rmq":
      return (
        <div className="space-y-5">
          <div className="card">
            <h2 className="mb-2 text-sm font-medium text-gris">Totaux</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
              {Object.entries(d.totals).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-gris">{k}</dt>
                  <dd className="font-mono" data-testid={`rmq-${k}`}>
                    {String(v ?? "∅")}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="card">
            <h2 className="mb-2 text-sm font-medium text-gris">/api/overview</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
              {Object.entries(d.overview).map(([k, v]) => (
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
            <h2 className="mb-2 text-sm font-medium text-gris">Nœuds (alarmes mémoire / disque)</h2>
            <DataTable rows={d.nodes.map((n) => ({ ...n, mem_used: bytes(n.mem_used as number), mem_limit: bytes(n.mem_limit as number), disk_free: bytes(n.disk_free as number), disk_free_limit: bytes(n.disk_free_limit as number) }))} />
          </div>
        </div>
      );
    case "queues":
      return (
        <div className="space-y-2">
          <p className="text-xs text-gris">
            {d.queuesTotal} file{d.queuesTotal > 1 ? "s" : ""}, triées par messages (200 premières). Aucune action : purge et suppression ne sont pas offertes.
          </p>
          <DataTable rows={d.queues.map((q) => ({ ...q, memory: bytes(q.memory as number), message_bytes: bytes(q.message_bytes as number) }))} columns={["vhost", "name", "type", "state", "messages", "messages_ready", "messages_unacknowledged", "consumers", "memory", "message_bytes", "durable", "auto_delete", "policy", "node", "idle_since"]} empty="Aucune file." />
        </div>
      );
    case "connections":
      return <DataTable rows={d.connections} empty="Aucune connexion AMQP." />;
    case "channels":
      return <DataTable rows={d.channels} empty="Aucun canal ouvert." />;
    case "exchanges":
      return (
        <div className="space-y-5">
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">vhosts</h2>
            <DataTable rows={d.vhosts} />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Exchanges (hors exchange par défaut)</h2>
            <DataTable rows={d.exchanges} empty="Aucun exchange." />
          </div>
        </div>
      );
  }
  return null;
}
