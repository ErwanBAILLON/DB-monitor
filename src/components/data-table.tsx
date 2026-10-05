import type { Row } from "@/lib/drivers/types";

function cell(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

// Generic read-only table for driver rows. Columns = keys of the first row unless given.
export function DataTable({ rows, columns, empty = "Aucune ligne.", maxHeight = "70vh", actions }: { rows: Row[]; columns?: string[]; empty?: string; maxHeight?: string; actions?: (r: Row) => React.ReactNode }) {
  if (!rows.length) return <p className="py-3 text-sm text-gris">{empty}</p>;
  const cols = columns ?? Object.keys(rows[0]);
  return (
    <div className="overflow-auto rounded-md border border-trait" style={{ maxHeight }}>
      <table className="tbl">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
            {actions && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className="max-w-md truncate" title={cell(r[c])}>
                  {cell(r[c])}
                </td>
              ))}
              {actions && <td className="whitespace-nowrap">{actions(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
