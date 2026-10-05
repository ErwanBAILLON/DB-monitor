import { prisma } from "@/lib/prisma";
import { dt } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit" };

export default async function AuditPage({ searchParams }: { searchParams: { page?: string } }) {
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const take = 100;
  const [rows, total] = await Promise.all([prisma.audit.findMany({ orderBy: { at: "desc" }, skip: (page - 1) * take, take }), prisma.audit.count()]);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Audit</h1>
      <p className="mt-1 text-sm text-gris">{total} action(s) journalisée(s). Les mots de passe ne sont jamais écrits ici.</p>
      <div className="mt-4 overflow-auto rounded-md border border-trait">
        <table className="tbl" data-testid="audit-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Acteur</th>
              <th>Instance</th>
              <th>Action</th>
              <th>Paramètres</th>
              <th>Résultat</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-action={r.action}>
                <td className="whitespace-nowrap">{dt(r.at)}</td>
                <td>{r.actor}</td>
                <td>{r.instanceName ?? "–"}</td>
                <td>{r.action}</td>
                <td className="max-w-md truncate" title={JSON.stringify(r.params)}>
                  {JSON.stringify(r.params)}
                </td>
                <td className={`max-w-md truncate ${r.ok ? "text-ok" : "text-panne"}`} title={r.result ?? ""}>
                  {r.ok ? "✓ " : "✗ "}
                  {r.result}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 flex gap-3 text-sm">
        {page > 1 && (
          <a className="link" href={`?page=${page - 1}`}>
            ← Plus récent
          </a>
        )}
        {page * take < total && (
          <a className="link" href={`?page=${page + 1}`}>
            Plus ancien →
          </a>
        )}
      </p>
    </>
  );
}
