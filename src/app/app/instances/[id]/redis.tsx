import type { Instance } from "@prisma/client";
import * as redis from "@/lib/drivers/redis";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { bytes } from "@/lib/format";
import { KeysBrowser } from "./redis-keys";

export const redisTabList = [
  { key: "info", label: "INFO" },
  { key: "keyspace", label: "Keyspace" },
  { key: "clients", label: "Clients" },
  { key: "slowlog", label: "Slowlog" },
  { key: "keys", label: "Clés" },
];

const SECTIONS = ["server", "clients", "memory", "persistence", "stats", "replication", "cpu"];

export async function RedisTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  if (tab === "keys") return <KeysBrowser instanceId={inst.id} />;
  const d = await redis.detail(conn);
  switch (tab) {
    case "info": {
      const mem = d.info.memory ?? {};
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ["Mémoire utilisée", bytes(mem.used_memory)],
              ["Pic", bytes(mem.used_memory_peak)],
              ["maxmemory", mem.maxmemory === "0" ? "illimitée" : bytes(mem.maxmemory)],
              ["Politique", mem.maxmemory_policy ?? "–"],
              ["Fragmentation", mem.mem_fragmentation_ratio ?? "–"],
              ["Clients", d.info.clients?.connected_clients ?? "–"],
              ["Ops/s", d.info.stats?.instantaneous_ops_per_sec ?? "–"],
              ["Hit ratio", hitRatio(d.info.stats)],
            ].map(([k, v]) => (
              <div key={k} className="card py-3">
                <p className="text-xs text-gris">{k}</p>
                <p className="font-mono text-lg">{v}</p>
              </div>
            ))}
          </div>
          {SECTIONS.filter((s) => d.info[s]).map((s) => (
            <details key={s} className="card" open={s === "server"}>
              <summary className="cursor-pointer text-sm font-medium"># {s}</summary>
              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-0.5 font-mono text-xs md:grid-cols-2">
                {Object.entries(d.info[s]).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-b border-trait/50 py-0.5">
                    <dt className="text-gris">{k}</dt>
                    <dd className="truncate" title={v}>
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ))}
        </div>
      );
    }
    case "keyspace":
      return <DataTable rows={d.keyspace} empty="Keyspace vide (aucune clé)." />;
    case "clients":
      return <DataTable rows={d.clients} columns={["id", "addr", "name", "age", "idle", "flags", "db", "cmd", "user"]} empty="CLIENT LIST indisponible." />;
    case "slowlog":
      return <DataTable rows={d.slowlog} empty="Slowlog vide." />;
  }
  return null;
}

function hitRatio(stats?: Record<string, string>) {
  if (!stats) return "–";
  const h = Number(stats.keyspace_hits ?? 0);
  const m = Number(stats.keyspace_misses ?? 0);
  return h + m ? `${Math.round((100 * h) / (h + m))} %` : "–";
}
