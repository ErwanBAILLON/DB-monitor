"use client";

import { useState, useTransition } from "react";
import type { QueryResult } from "@/lib/drivers/types";
import { DataTable } from "./data-table";

export function QueryConsole({
  run,
  databases,
  defaultDb,
  hint = "SELECT / WITH / EXPLAIN / SHOW uniquement, une instruction, transaction READ ONLY, 5 s max, 500 lignes.",
  placeholder = "SELECT now()",
  rows = 5,
}: {
  run: (fd: FormData) => Promise<{ ok: true; result: QueryResult } | { ok: false; message: string }>;
  databases?: string[];
  defaultDb?: string;
  hint?: string;
  placeholder?: string;
  rows?: number;
}) {
  const [out, setOut] = useState<Awaited<ReturnType<typeof run>> | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-col gap-3"
      action={(fd) =>
        start(async () => {
          setOut(await run(fd));
        })
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        {databases && (
          <label className="text-sm">
            <span className="label">Base</span>
            <select name="database" className="field" defaultValue={defaultDb}>
              {databases.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
        )}
        <p className="text-xs text-gris">{hint}</p>
      </div>
      <textarea name="sql" rows={rows} className="field font-mono" placeholder={placeholder} spellCheck={false} required />
      <div>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Exécution…" : "Exécuter (lecture seule)"}
        </button>
      </div>
      {out && !out.ok && (
        <p className="font-mono text-sm text-panne" data-testid="query-error">
          {out.message}
        </p>
      )}
      {out && out.ok && (
        <div data-testid="query-result">
          <p className="mb-2 text-xs text-gris">
            {out.result.rowCount} ligne(s) en {out.result.durationMs} ms{out.result.truncated ? " (tronqué à 500)" : ""}
          </p>
          <DataTable rows={out.result.rows} columns={out.result.columns} maxHeight="50vh" empty="Aucune ligne renvoyée." />
        </div>
      )}
    </form>
  );
}
