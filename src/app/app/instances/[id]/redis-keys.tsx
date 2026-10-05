"use client";

import { useState, useTransition } from "react";
import { redisDelete, redisScan } from "@/app/app/actions";
import type { Row } from "@/lib/drivers/types";

export function KeysBrowser({ instanceId }: { instanceId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [pattern, setPattern] = useState("*");

  const scan = () =>
    start(async () => {
      const fd = new FormData();
      fd.set("pattern", pattern);
      const r = await redisScan(instanceId, fd);
      if (r.ok) {
        setRows(r.rows);
        setError(null);
      } else setError(r.message);
    });

  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          scan();
        }}
      >
        <label className="text-sm">
          <span className="label">Motif (SCAN MATCH, 200 clés max)</span>
          <input className="field font-mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        </label>
        <button className="btn" disabled={pending}>
          {pending ? "…" : "Scanner"}
        </button>
        <p className="basis-full text-xs text-gris">KEYS n&apos;est jamais utilisé ; FLUSHDB/FLUSHALL ne sont pas proposés.</p>
      </form>
      {error && <p className="font-mono text-sm text-panne">{error}</p>}
      {rows && (
        <div className="overflow-auto rounded-md border border-trait" style={{ maxHeight: "60vh" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>key</th>
                <th>type</th>
                <th>ttl</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-gris">
                    Aucune clé.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={String(r.key)}>
                  <td className="max-w-lg truncate" title={String(r.key)}>
                    {String(r.key)}
                  </td>
                  <td>{String(r.type)}</td>
                  <td>{Number(r.ttl_ms) < 0 ? "∞" : `${Math.round(Number(r.ttl_ms) / 1000)} s`}</td>
                  <td>
                    <button
                      className="text-xs text-panne underline"
                      disabled={pending}
                      onClick={() => {
                        if (!window.confirm(`Supprimer la clé ${r.key} ?`)) return;
                        start(async () => {
                          const fd = new FormData();
                          fd.set("id", instanceId);
                          fd.set("key", String(r.key));
                          const res = await redisDelete(fd);
                          if (!res.ok) setError(res.message);
                          else setRows((rs) => (rs ?? []).filter((x) => x.key !== r.key));
                        });
                      }}
                    >
                      supprimer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
