"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Row } from "@/lib/drivers/types";
import { FILTER_OPS, type BrowseResult, type ColumnProfile, type ExploreContainer, type ExploreDescription, type ExploreFilter, type ExploreObject, type ExploreStats, type FilterOp, type StatSection } from "@/lib/explore/types";
import type { ExploreOp } from "@/lib/explore/ops";

// Generic explorer driven by the contract (src/lib/explore/types.ts): tree of
// containers > objects on the left, Structure / Données / Profil / Statistiques
// on the right. Everything goes through /api/instances/:id/explore/:op.

type Mode = "explore" | "stats";
type SubTab = "structure" | "data" | "profile" | "stats";

const fmtBytes = (v: number | null | undefined) => {
  if (v === null || v === undefined) return "–";
  let n = Number(v);
  const u = ["o", "Kio", "Mio", "Gio", "Tio"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};
const fmtNum = (v: number | null | undefined) => (v === null || v === undefined ? "–" : new Intl.NumberFormat("fr-FR").format(v));
const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};
const pretty = (v: unknown): string => {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "string") {
    const t = v.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return v;
      }
    }
    return v;
  }
  return JSON.stringify(v, null, 2);
};
const csvOf = (columns: string[], rows: Row[]): string => {
  const esc = (s: string) => (/[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [columns.map(esc).join(","), ...rows.map((r) => columns.map((c) => esc(r[c] === null || r[c] === undefined ? "" : cellText(r[c]))).join(","))].join("\n");
};

async function api<T>(instanceId: string, op: ExploreOp, params: Record<string, string | undefined>, body?: unknown): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const res = await fetch(`/api/instances/${instanceId}/explore/${op}${body ? "" : `?${qs}`}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...params, ...(body as object) }) } : undefined);
  const json = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className="rounded border border-panne/40 bg-panne/10 px-3 py-2 font-mono text-xs text-panne" role="alert" data-testid="explore-error">
      {error}
    </p>
  ) : null;
}
const Loading = ({ what }: { what: string }) => <p className="py-2 text-sm text-gris">Chargement {what}…</p>;

export function Explorer({ instanceId, mode }: { instanceId: string; mode: Mode }) {
  const [containers, setContainers] = useState<ExploreContainer[] | null>(null);
  const [caveats, setCaveats] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [container, setContainer] = useState<string | null>(null);
  const [objects, setObjects] = useState<Record<string, ExploreObject[] | "loading" | { error: string }>>({});
  const [object, setObject] = useState<ExploreObject | null>(null);
  const [search, setSearch] = useState("");
  const [sub, setSub] = useState<SubTab>(mode === "stats" ? "stats" : "structure");

  useEffect(() => {
    api<{ containers: ExploreContainer[]; caveats: string[] }>(instanceId, "containers", {})
      .then((r) => {
        setContainers(r.containers);
        setCaveats(r.caveats ?? []);
        if (mode === "stats" && r.containers[0]) setContainer(r.containers[0].name);
      })
      .catch((e: Error) => setError(e.message));
  }, [instanceId, mode]);

  const loadObjects = useCallback(
    (name: string) => {
      setObjects((o) => ({ ...o, [name]: "loading" }));
      api<{ objects: ExploreObject[] }>(instanceId, "objects", { container: name })
        .then((r) => setObjects((o) => ({ ...o, [name]: r.objects })))
        .catch((e: Error) => setObjects((o) => ({ ...o, [name]: { error: e.message } })));
    },
    [instanceId],
  );
  const toggleContainer = (name: string) => {
    if (container === name) {
      setContainer(null);
      return;
    }
    setContainer(name);
    if (!objects[name]) loadObjects(name);
  };
  const pick = (o: ExploreObject) => {
    setObject(o);
    if (sub === "stats") setSub("structure");
  };

  const needle = search.trim().toLowerCase();
  if (mode === "stats") {
    return (
      <div className="space-y-3">
        <ErrorLine error={error} />
        {containers && containers.length > 0 && (
          <label className="text-sm">
            <span className="label">Conteneur</span>
            <select className="field max-w-xs" value={container ?? ""} onChange={(e) => setContainer(e.target.value || null)} data-testid="stats-container">
              {containers.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {containers === null && !error && <Loading what="des conteneurs" />}
        {containers && (containers.length === 0 || container) && <StatsPanel instanceId={instanceId} container={container} />}
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <aside className="card max-h-[75vh] overflow-auto p-2" data-testid="explore-tree">
        <input className="field mb-2" placeholder="Rechercher un objet…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Rechercher" />
        {containers === null && !error && <Loading what="des conteneurs" />}
        {containers && containers.length === 0 && <p className="px-2 py-2 text-sm text-gris">Aucun conteneur visible.</p>}
        <ul className="space-y-0.5 text-sm">
          {containers?.map((c) => {
            const list = objects[c.name];
            const open = container === c.name;
            const filtered = Array.isArray(list) ? list.filter((o) => !needle || o.name.toLowerCase().includes(needle)) : [];
            return (
              <li key={c.name}>
                <button type="button" className={`flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left hover:bg-fond ${open ? "font-medium" : ""}`} onClick={() => toggleContainer(c.name)} data-testid={`container-${c.name}`}>
                  <span className="w-3 font-mono text-gris">{open ? "▾" : "▸"}</span>
                  <span className="truncate font-mono">{c.name}</span>
                  <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-gris">
                    {c.objectCount !== undefined && c.objectCount !== null ? `${fmtNum(c.objectCount)} · ` : ""}
                    {c.sizeBytes !== undefined ? fmtBytes(c.sizeBytes) : ""}
                  </span>
                </button>
                {open && (
                  <ul className="ml-4 border-l border-trait pl-1">
                    {list === "loading" && <Loading what="des objets" />}
                    {list && typeof list === "object" && "error" in list && <li className="px-2 py-1 font-mono text-xs text-panne">{list.error}</li>}
                    {Array.isArray(list) && list.length === 0 && <li className="px-2 py-1 text-xs text-gris">Vide.</li>}
                    {Array.isArray(list) && list.length > 0 && filtered.length === 0 && <li className="px-2 py-1 text-xs text-gris">Aucun objet ne correspond.</li>}
                    {filtered.map((o) => (
                      <li key={o.name}>
                        <button type="button" className={`flex w-full items-center gap-1.5 rounded-sm px-2 py-0.5 text-left hover:bg-fond ${object?.name === o.name && container === c.name ? "bg-accent/10 text-accent" : ""}`} onClick={() => pick(o)} title={`${o.kind}${o.estRows !== undefined && o.estRows !== null ? ` · ~${fmtNum(o.estRows)} lignes` : ""}`} data-testid={`object-${o.name}`}>
                          <span className="tag w-9 shrink-0 justify-center text-center text-[10px]">{o.kind.slice(0, 5)}</span>
                          <span className="truncate font-mono text-[13px]">{o.name}</span>
                          <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-gris">{o.sizeBytes !== undefined && o.sizeBytes !== null ? fmtBytes(o.sizeBytes) : o.estRows !== undefined && o.estRows !== null ? fmtNum(o.estRows) : ""}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {caveats.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-trait px-2 pt-2 text-[11px] text-gris">
            {caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
      </aside>
      <section className="min-w-0 space-y-3">
        <ErrorLine error={error} />
        {!object && !container && <p className="card text-sm text-gris">Choisissez un conteneur puis un objet dans l&apos;arbre pour voir sa structure, ses données, un profil de colonne et ses statistiques.</p>}
        {container && !object && (
          <div className="space-y-3">
            <p className="text-sm text-gris">
              Conteneur <span className="font-mono text-encre">{container}</span> : choisissez un objet, ou consultez ses statistiques.
            </p>
            <StatsPanel instanceId={instanceId} container={container} />
          </div>
        )}
        {object && container && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-mono text-base" data-testid="explore-object-title">
                {container} / {object.name}
              </h2>
              <span className="tag">{object.kind}</span>
              {object.estRows !== undefined && object.estRows !== null && <span className="text-xs text-gris">~{fmtNum(object.estRows)} lignes</span>}
              {object.sizeBytes !== undefined && object.sizeBytes !== null && <span className="text-xs text-gris">{fmtBytes(object.sizeBytes)}</span>}
            </div>
            <nav className="flex gap-1 border-b border-trait" aria-label="Sous-onglets">
              {(
                [
                  ["structure", "Structure"],
                  ["data", "Données"],
                  ["profile", "Profil"],
                  ["stats", "Statistiques"],
                ] as [SubTab, string][]
              ).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setSub(k)} className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${sub === k ? "border-accent font-medium text-encre" : "border-transparent text-gris hover:text-encre"}`} data-testid={`subtab-${k}`}>
                  {label}
                </button>
              ))}
            </nav>
            {sub === "structure" && <StructurePanel key={`${container}/${object.name}`} instanceId={instanceId} container={container} object={object.name} />}
            {sub === "data" && <DataPanel key={`${container}/${object.name}`} instanceId={instanceId} container={container} object={object.name} />}
            {sub === "profile" && <ProfilePanel key={`${container}/${object.name}`} instanceId={instanceId} container={container} object={object.name} />}
            {sub === "stats" && <StatsPanel instanceId={instanceId} container={container} />}
          </>
        )}
      </section>
    </div>
  );
}

function useDescribe(instanceId: string, container: string, object: string) {
  const [d, setD] = useState<ExploreDescription | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setD(null);
    setError(null);
    api<ExploreDescription>(instanceId, "describe", { container, object })
      .then(setD)
      .catch((e: Error) => setError(e.message));
  }, [instanceId, container, object]);
  return { d, error };
}

function KV({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  if (!entries.length) return <p className="text-sm text-gris">–</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-gris">{k}</dt>
          <dd className="break-all font-mono text-[13px]">{cellText(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function StructurePanel({ instanceId, container, object }: { instanceId: string; container: string; object: string }) {
  const { d, error } = useDescribe(instanceId, container, object);
  if (error) return <ErrorLine error={error} />;
  if (!d) return <Loading what="de la structure" />;
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="structure-panel">
      <div className="card lg:col-span-2">
        <h3 className="mb-2 text-sm font-medium text-gris">Colonnes ({d.columns.length})</h3>
        {d.columns.length === 0 ? (
          <p className="text-sm text-gris">Pas de colonnes (objet sans schéma).</p>
        ) : (
          <div className="overflow-auto rounded-md border border-trait">
            <table className="tbl">
              <thead>
                <tr>
                  <th>nom</th>
                  <th>type</th>
                  <th>null</th>
                  <th>défaut</th>
                  <th>clé</th>
                  <th>autre</th>
                </tr>
              </thead>
              <tbody>
                {d.columns.map((c) => (
                  <tr key={c.name}>
                    <td className={c.pk ? "font-semibold" : ""}>{c.name}</td>
                    <td>{c.type}</td>
                    <td>{c.nullable === undefined ? "–" : c.nullable ? "oui" : "non"}</td>
                    <td className="max-w-xs truncate" title={c.default ?? ""}>
                      {c.default ?? ""}
                    </td>
                    <td>{c.pk ? "PK" : ""}</td>
                    <td className="max-w-xs truncate text-gris">{c.extra ? Object.entries(c.extra).map(([k, v]) => `${k}=${cellText(v)}`).join(" ") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <h3 className="mb-2 text-sm font-medium text-gris">Index ({d.indexes.length})</h3>
        {d.indexes.length === 0 && <p className="text-sm text-gris">Aucun.</p>}
        <ul className="space-y-1 text-sm">
          {d.indexes.map((ix) => (
            <li key={ix.name} className="font-mono text-[13px]">
              <span className={ix.primary ? "font-semibold" : ""}>{ix.name}</span> ({ix.columns.join(", ")}){ix.unique ? " · unique" : ""}
              {ix.sizeBytes !== undefined && ix.sizeBytes !== null ? ` · ${fmtBytes(ix.sizeBytes)}` : ""}
              {ix.extra && <span className="text-gris"> {Object.entries(ix.extra).map(([k, v]) => `${k}=${cellText(v)}`).join(" ")}</span>}
              {ix.definition && <div className="truncate text-xs text-gris" title={ix.definition}>{ix.definition}</div>}
            </li>
          ))}
        </ul>
      </div>
      <div className="card">
        <h3 className="mb-2 text-sm font-medium text-gris">Contraintes ({d.constraints.length})</h3>
        {d.constraints.length === 0 && <p className="text-sm text-gris">Aucune.</p>}
        <ul className="space-y-1 text-sm">
          {d.constraints.map((c) => (
            <li key={c.name} className="font-mono text-[13px]">
              <span className="tag mr-1">{c.kind}</span>
              {c.name} ({c.columns.join(", ")}){c.refObject ? ` → ${c.refObject}(${(c.refColumns ?? []).join(", ")})` : ""}
              {c.definition && !c.refObject && <div className="truncate text-xs text-gris" title={c.definition}>{c.definition}</div>}
            </li>
          ))}
        </ul>
      </div>
      <div className="card">
        <h3 className="mb-2 text-sm font-medium text-gris">Stockage</h3>
        <KV data={d.storage ?? {}} />
      </div>
      <div className="card">
        <h3 className="mb-2 text-sm font-medium text-gris">Partitionnement / distribution</h3>
        {d.partitioning ? <KV data={d.partitioning} /> : <p className="text-sm text-gris">Aucun.</p>}
      </div>
      <div className="card lg:col-span-2">
        <h3 className="mb-2 text-sm font-medium text-gris">Exemple</h3>
        {d.sample ? <pre className="max-h-64 overflow-auto rounded-sm bg-fond p-2 font-mono text-xs">{JSON.stringify(d.sample, null, 2)}</pre> : <p className="text-sm text-gris">Aucune ligne.</p>}
      </div>
      {d.notes && d.notes.length > 0 && (
        <ul className="lg:col-span-2 space-y-0.5 text-xs text-gris">
          {d.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DataPanel({ instanceId, container, object }: { instanceId: string; container: string; object: string }) {
  const { d, error: dErr } = useDescribe(instanceId, container, object);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<{ column: string; dir: "asc" | "desc" } | null>(null);
  const [filters, setFilters] = useState<ExploreFilter[]>([]);
  const [draft, setDraft] = useState<{ column: string; op: FilterOp; value: string }>({ column: "", op: "=", value: "" });
  const [res, setRes] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ column: string; value: unknown } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    api<BrowseResult>(instanceId, "browse", { container, object }, { page, pageSize, sortColumn: sort?.column, sortDir: sort?.dir, filters })
      .then((r) => {
        if (n === seq.current) setRes(r);
      })
      .catch((e: Error) => {
        if (n === seq.current) setError(e.message);
      })
      .finally(() => {
        if (n === seq.current) setLoading(false);
      });
  }, [instanceId, container, object, page, pageSize, sort, filters]);

  const columns = useMemo(() => d?.columns.map((c) => c.name) ?? res?.columns ?? [], [d, res]);
  const filterable = columns.length > 0;
  const toggleSort = (c: string) => {
    if (!filterable) return;
    setPage(1);
    setSort((s) => (s?.column === c ? (s.dir === "asc" ? { column: c, dir: "desc" } : null) : { column: c, dir: "asc" }));
  };
  const addFilter = () => {
    if (!draft.column) return;
    const needsValue = draft.op !== "is null" && draft.op !== "is not null";
    setFilters((f) => [...f, { column: draft.column, op: draft.op, value: needsValue ? draft.value : undefined }]);
    setDraft((x) => ({ ...x, value: "" }));
    setPage(1);
  };
  const exportCsv = () => {
    if (!res) return;
    const blob = new Blob([csvOf(res.columns, res.rows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${object.replace(/[^\w.-]/g, "_")}-page${res.page}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const copyRow = async (r: Row, i: number) => {
    await navigator.clipboard.writeText(JSON.stringify(r, null, 2)).catch(() => undefined);
    setCopied(i);
    setTimeout(() => setCopied(null), 1200);
  };
  const totalPages = res?.total !== null && res?.total !== undefined ? Math.max(1, Math.ceil(res.total / pageSize)) : null;

  return (
    <div className="space-y-3" data-testid="data-panel">
      {filterable && (
        <div className="card flex flex-wrap items-end gap-2 p-3" data-testid="filter-bar">
          <label className="text-sm">
            <span className="label">Colonne</span>
            <select className="field w-44" value={draft.column} onChange={(e) => setDraft({ ...draft, column: e.target.value })} data-testid="filter-column">
              <option value="">—</option>
              {columns.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="label">Opérateur</span>
            <select className="field w-32" value={draft.op} onChange={(e) => setDraft({ ...draft, op: e.target.value as FilterOp })} data-testid="filter-op">
              {FILTER_OPS.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
          {draft.op !== "is null" && draft.op !== "is not null" && (
            <label className="text-sm">
              <span className="label">Valeur</span>
              <input className="field w-56 font-mono" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} onKeyDown={(e) => e.key === "Enter" && addFilter()} data-testid="filter-value" />
            </label>
          )}
          <button type="button" className="btn-ghost" onClick={addFilter} disabled={!draft.column} data-testid="filter-add">
            Filtrer
          </button>
          <div className="flex flex-wrap gap-1">
            {filters.map((f, i) => (
              <button key={i} type="button" className="tag font-mono hover:border-panne hover:text-panne" title="Retirer ce filtre" onClick={() => setFilters((x) => x.filter((_, j) => j !== i))} data-testid="filter-chip">
                {f.column} {f.op} {f.value !== undefined ? JSON.stringify(f.value) : ""} ×
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="btn-ghost" onClick={exportCsv} disabled={!res || res.rows.length === 0} data-testid="export-csv">
              Exporter CSV (page)
            </button>
          </div>
        </div>
      )}
      <ErrorLine error={error ?? dErr} />
      {loading && !res && <Loading what="des données" />}
      {res && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs text-gris">
            <span data-testid="browse-summary">
              {res.rows.length} ligne(s) affichée(s)
              {res.total !== null ? ` · ${res.totalIsEstimate ? "≈ " : ""}${fmtNum(res.total)} au total${res.totalIsEstimate ? " (estimation)" : ""}` : ""} · {res.durationMs} ms{loading ? " · mise à jour…" : ""}
            </span>
            <span className="ml-auto flex items-center gap-1">
              <button type="button" className="btn-ghost px-2 py-0.5" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} data-testid="page-prev">
                ‹
              </button>
              <span className="font-mono">
                page {page}
                {totalPages ? ` / ${totalPages}` : ""}
              </span>
              <button type="button" className="btn-ghost px-2 py-0.5" disabled={(totalPages !== null && page >= totalPages) || res.rows.length < pageSize} onClick={() => setPage((p) => p + 1)} data-testid="page-next">
                ›
              </button>
              <select
                className="field w-auto px-1 py-0.5"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                aria-label="Lignes par page"
              >
                {[25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
            </span>
          </div>
          {res.rows.length === 0 ? (
            <p className="card text-sm text-gris">Aucune ligne{filters.length ? " ne correspond aux filtres" : ""}.</p>
          ) : (
            <div className="overflow-auto rounded-md border border-trait" style={{ maxHeight: "60vh" }}>
              <table className="tbl" data-testid="data-grid">
                <thead>
                  <tr>
                    <th />
                    {res.columns.map((c) => (
                      <th key={c} className={filterable ? "cursor-pointer select-none hover:text-encre" : ""} onClick={() => toggleSort(c)} data-testid={`col-${c}`}>
                        {c}
                        {sort?.column === c ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {res.rows.map((r, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap">
                        <button type="button" className="text-xs text-gris hover:text-accent" title="Copier la ligne en JSON" onClick={() => copyRow(r, i)}>
                          {copied === i ? "copié" : "{ }"}
                        </button>
                      </td>
                      {res.columns.map((c) => (
                        <td key={c} className="max-w-xs cursor-pointer truncate hover:text-accent" onClick={() => setDrawer({ column: c, value: r[c] })} title="Voir la valeur complète">
                          {cellText(r[c]).slice(0, 200)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {res.notes && res.notes.length > 0 && (
            <ul className="space-y-0.5 text-xs text-gris">
              {res.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {drawer && (
        <div className="fixed inset-y-0 right-0 z-20 flex w-full max-w-xl flex-col border-l border-trait bg-carte shadow-xl" role="dialog" aria-label="Valeur" data-testid="cell-drawer">
          <div className="flex items-center gap-2 border-b border-trait px-4 py-2">
            <span className="font-mono text-sm">{drawer.column}</span>
            <button type="button" className="btn-ghost ml-auto px-2 py-0.5" onClick={() => navigator.clipboard.writeText(pretty(drawer.value)).catch(() => undefined)}>
              Copier
            </button>
            <button type="button" className="btn-ghost px-2 py-0.5" onClick={() => setDrawer(null)} aria-label="Fermer">
              ×
            </button>
          </div>
          <pre className="flex-1 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-xs">{pretty(drawer.value)}</pre>
        </div>
      )}
    </div>
  );
}

function ProfilePanel({ instanceId, container, object }: { instanceId: string; container: string; object: string }) {
  const { d, error: dErr } = useDescribe(instanceId, container, object);
  const [column, setColumn] = useState("");
  const [p, setP] = useState<ColumnProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (c: string) => {
    setColumn(c);
    setP(null);
    if (!c) return;
    setLoading(true);
    setError(null);
    api<ColumnProfile>(instanceId, "profile", { container, object, column: c })
      .then(setP)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };
  return (
    <div className="space-y-3" data-testid="profile-panel">
      <ErrorLine error={dErr ?? error} />
      {d && d.columns.length === 0 && <p className="card text-sm text-gris">Pas de colonnes à profiler sur cet objet.</p>}
      {d && d.columns.length > 0 && (
        <label className="text-sm">
          <span className="label">Colonne</span>
          <select className="field max-w-xs" value={column} onChange={(e) => run(e.target.value)} data-testid="profile-column">
            <option value="">—</option>
            {d.columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.type})
              </option>
            ))}
          </select>
        </label>
      )}
      {loading && <Loading what="du profil (échantillon ≤ 10 000 lignes)" />}
      {p && "unsupported" in p && p.unsupported && <p className="card text-sm text-gris">Profil indisponible sur ce moteur{p.reason ? ` : ${p.reason}` : "."}</p>}
      {p && !p.unsupported && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card">
            <h3 className="mb-2 text-sm font-medium text-gris">
              {p.column} · échantillon de {fmtNum(p.sampleSize)} lignes
            </h3>
            <KV data={{ "null %": `${p.nullPct.toFixed(1)} %`, distinct: p.distinct === null ? "–" : `${p.distinctIsEstimate ? "≈ " : ""}${fmtNum(p.distinct)}`, min: p.min, max: p.max }} />
            {p.notes && p.notes.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-gris">
                {p.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="card">
            <h3 className="mb-2 text-sm font-medium text-gris">Top 10 valeurs</h3>
            {p.top.length === 0 ? (
              <p className="text-sm text-gris">Aucune valeur.</p>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>valeur</th>
                    <th>n</th>
                    <th>%</th>
                  </tr>
                </thead>
                <tbody>
                  {p.top.map((t, i) => (
                    <tr key={i}>
                      <td className="max-w-md truncate" title={cellText(t.value)}>
                        {cellText(t.value)}
                      </td>
                      <td>{fmtNum(t.count)}</td>
                      <td>{p.sampleSize ? ((100 * t.count) / p.sampleSize).toFixed(1) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatsPanel({ instanceId, container }: { instanceId: string; container: string | null }) {
  const [s, setS] = useState<ExploreStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setS(null);
    setError(null);
    api<ExploreStats>(instanceId, "stats", { container: container ?? undefined })
      .then(setS)
      .catch((e: Error) => setError(e.message));
  }, [instanceId, container]);
  if (error) return <ErrorLine error={error} />;
  if (!s) return <Loading what="des statistiques" />;
  return (
    <div className="space-y-4" data-testid="stats-panel">
      <p className="text-xs text-gris">
        {s.sections.length} section(s) · {s.durationMs} ms
      </p>
      {s.sections.map((sec) => (
        <StatSectionView key={sec.key} sec={sec} />
      ))}
    </div>
  );
}

function StatSectionView({ sec }: { sec: StatSection }) {
  const cols = sec.columns ?? (sec.rows[0] ? Object.keys(sec.rows[0]) : []);
  return (
    <div className="card" data-testid={`stat-${sec.key}`}>
      <h3 className="text-sm font-medium">{sec.title}</h3>
      {sec.description && <p className="mb-2 text-xs text-gris">{sec.description}</p>}
      {sec.unsupported ? (
        <p className="text-sm text-gris">Indisponible{sec.note ? ` : ${sec.note}` : "."}</p>
      ) : sec.rows.length === 0 ? (
        <p className="text-sm text-gris">Rien à signaler.</p>
      ) : (
        <div className="max-h-96 overflow-auto rounded-md border border-trait">
          <table className="tbl">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sec.rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c} className="max-w-md truncate" title={cellText(r[c])}>
                      {cellText(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!sec.unsupported && sec.note && <p className="mt-1 text-xs text-gris">{sec.note}</p>}
    </div>
  );
}
