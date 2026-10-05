import type { Instance } from "@prisma/client";
import * as mysql from "@/lib/drivers/mysql";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { ConfirmForm } from "@/components/confirm-form";
import { QueryConsole } from "@/components/query-console";
import { myKill, runReadOnlyQuery } from "@/app/app/actions";

export const mysqlTabList = [
  { key: "databases", label: "Bases" },
  { key: "processlist", label: "Processlist" },
  { key: "variables", label: "Variables" },
  { key: "query", label: "Requête" },
];

export async function MysqlTabs({ inst, conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  const d = await mysql.detail(conn);
  switch (tab) {
    case "databases":
      return <DataTable rows={d.databases} />;
    case "processlist":
      return (
        <DataTable
          rows={d.processlist}
          actions={(r) => (
            <ConfirmForm action={myKill} label="kill" danger confirm={`KILL ${r.id} ?`} className="inline-flex">
              <input type="hidden" name="id" value={inst.id} />
              <input type="hidden" name="pid" value={String(r.id)} />
            </ConfirmForm>
          )}
        />
      );
    case "variables":
      return (
        <div className="space-y-5">
          <DataTable rows={d.variables} />
          <DataTable rows={d.status} />
        </div>
      );
    case "query":
      return (
        <div className="card">
          <QueryConsole run={runReadOnlyQuery.bind(null, inst.id)} databases={d.databases.map((x) => String(x.name))} defaultDb={inst.database ?? undefined} />
        </div>
      );
  }
  return null;
}
