import type { Instance } from "@prisma/client";
import * as ora from "@/lib/drivers/oracle";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { ConfirmForm } from "@/components/confirm-form";
import { QueryConsole } from "@/components/query-console";
import { bytes } from "@/lib/format";
import { oraKillSession, runReadOnlyQuery } from "@/app/app/actions";

export const oracleTabList = [
  { key: "instance", label: "Instance" },
  { key: "tablespaces", label: "Tablespaces" },
  { key: "sessions", label: "Sessions" },
  { key: "longops", label: "Opérations longues" },
  { key: "query", label: "Requête" },
];

function Dl({ obj }: { obj: Record<string, unknown> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
      {Object.entries(obj).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-gris">{k}</dt>
          <dd className="truncate font-mono" title={String(v ?? "")}>
            {String(v ?? "∅")}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export async function OracleTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await ora.detail(conn);
  switch (tab) {
    case "instance":
      return (
        <div className="space-y-5">
          <div className="card">
            <h2 className="mb-2 text-sm font-medium text-gris">v$instance</h2>
            <Dl obj={d.instance} />
          </div>
          <div className="card">
            <h2 className="mb-2 text-sm font-medium text-gris">v$database</h2>
            <Dl obj={d.database} />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <h2 className="mb-2 text-sm font-medium text-gris">v$resource_limit</h2>
              <DataTable rows={d.limits} />
            </div>
            <div>
              <h2 className="mb-2 text-sm font-medium text-gris">PDBs (v$pdbs)</h2>
              <DataTable rows={d.pdbs.map((p) => ({ ...p, total_size: bytes(p.total_size as number) }))} empty="Pas de PDB visible (non-CDB ou droits insuffisants)." />
            </div>
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium text-gris">Paramètres (v$parameter)</h2>
            <DataTable rows={d.parameters} />
          </div>
        </div>
      );
    case "tablespaces":
      return (
        <div className="space-y-2">
          <p className="text-xs text-gris">dba_tablespace_usage_metrics : used / max (max = taille possible avec AUTOEXTEND), allocated = fichiers de données actuels.</p>
          <DataTable rows={d.tablespaces.map((t) => ({ ...t, used: bytes(t.used_bytes as number), max: bytes(t.max_bytes as number), allocated: bytes(t.allocated_bytes as number) }))} columns={["tablespace_name", "contents", "status", "bigfile", "used", "allocated", "max", "used_pct"]} />
        </div>
      );
    case "sessions":
      return (
        <DataTable
          rows={d.sessions}
          columns={["sid", "serial", "username", "status", "osuser", "machine", "program", "module", "event", "wait_class", "seconds_in_wait", "blocking_session", "last_call_et", "logon_time", "sql_id", "sql_text"]}
          empty="Aucune autre session utilisateur."
          actions={(r) => (
            <ConfirmForm action={oraKillSession} label="kill" danger confirm={`ALTER SYSTEM KILL SESSION '${r.sid},${r.serial}' IMMEDIATE ?`} className="inline-flex">
              <input type="hidden" name="id" value={inst.id} />
              <input type="hidden" name="sid" value={String(r.sid)} />
              <input type="hidden" name="serial" value={String(r.serial)} />
            </ConfirmForm>
          )}
        />
      );
    case "longops":
      return <DataTable rows={d.longops} empty="Aucune opération longue en cours (v$session_longops)." />;
    case "query":
      return (
        <div className="card">
          <QueryConsole
            run={runReadOnlyQuery.bind(null, inst.id)}
            databases={[inst.database || ora.DEFAULT_SERVICE, ...d.pdbs.map((p) => String(p.name)).filter((n) => n !== (inst.database || ora.DEFAULT_SERVICE) && n !== "PDB$SEED")]}
            defaultDb={inst.database || ora.DEFAULT_SERVICE}
            hint="SELECT / WITH uniquement, exécuté dans SET TRANSACTION READ ONLY ; blocs PL/SQL, DBMS_*, UTL_*, EXECUTE IMMEDIATE refusés ; callTimeout 5 s, 500 lignes. Le sélecteur = service (PDB)."
            placeholder="SELECT owner, segment_type, round(sum(bytes)/1024/1024) AS mb FROM dba_segments GROUP BY owner, segment_type ORDER BY mb DESC FETCH FIRST 20 ROWS ONLY"
          />
        </div>
      );
  }
  return null;
}
