import { describe, expect, it } from "vitest";
import { ENGINES } from "@/lib/drivers/types";
import { HAS_EXPLORER, explorerEngines, explorerFor, hasExplorer } from "@/lib/explore";
import { FILTER_OPS, MAX_FILTERS, MAX_PAGE_SIZE, normalizeBrowseRequest, truncateCell } from "@/lib/explore/types";
import { assertExploreIdent, auditParams, composeBrowse, placeholderDollar, placeholderQuestion, quoteBacktick, quoteDouble, splitQualified } from "@/lib/explore/sql";

describe("explorer registry", () => {
  it("has a flag for every engine and refuses unknown ones", async () => {
    for (const e of ENGINES) expect(typeof HAS_EXPLORER[e]).toBe("boolean");
    for (const e of ENGINES) expect(hasExplorer(e)).toBe(HAS_EXPLORER[e]);
    expect(explorerEngines()).toEqual(ENGINES.filter((e) => HAS_EXPLORER[e]));
    const off = ENGINES.find((e) => !HAS_EXPLORER[e]);
    if (off) await expect(explorerFor(off)).rejects.toThrow(/explorateur/);
  });
  it("every registered explorer exposes the six contract functions", async () => {
    for (const e of explorerEngines()) {
      const x = await explorerFor(e);
      for (const fn of ["listContainers", "listObjects", "describeObject", "browseRows", "columnProfile", "stats"] as const) expect(typeof x[fn], `${e}.${fn}`).toBe("function");
    }
  });
});

describe("identifier validation", () => {
  it("accepts plain identifiers", () => {
    for (const s of ["id", "User_Name", "_x", "a$b", "T1", "a".repeat(128)]) expect(assertExploreIdent(s, "c")).toBe(s);
  });
  it("refuses injection attempts and odd shapes", () => {
    for (const s of ["id; DROP TABLE t", "1=1", "1", "", " id", "id ", 'a"b', "a'b", "a.b", "a-b", "a b", "a`b", "a)b", "a/*x*/", "é", "a".repeat(129), null, undefined, 42, {}])
      expect(() => assertExploreIdent(s, "Colonne"), String(s)).toThrow(/invalide/);
  });
  it("splits qualified names and validates both parts", () => {
    expect(splitQualified("public.users", "x")).toEqual(["public", "users"]);
    expect(splitQualified("users", "public")).toEqual(["public", "users"]);
    expect(() => splitQualified("a.b.c", "x")).toThrow(/invalide/);
    expect(() => splitQualified('public."users"; drop', "x")).toThrow(/invalide/);
    expect(() => splitQualified("", "x")).toThrow(/invalide/);
  });
});

describe("browse request normalisation", () => {
  it("clamps page and page size", () => {
    expect(normalizeBrowseRequest({}).page).toBe(1);
    expect(normalizeBrowseRequest({ page: 0 }).page).toBe(1);
    expect(normalizeBrowseRequest({ page: "7" }).page).toBe(7);
    expect(normalizeBrowseRequest({ page: -3, pageSize: 1000 })).toMatchObject({ page: 1, pageSize: MAX_PAGE_SIZE });
    expect(normalizeBrowseRequest({ pageSize: 0 }).pageSize).toBe(1);
    expect(normalizeBrowseRequest({ pageSize: "abc" }).pageSize).toBe(50);
    expect(normalizeBrowseRequest({ pageSize: 2.5 }).pageSize).toBe(50);
  });
  it("validates ops and values", () => {
    const r = normalizeBrowseRequest({ filters: [{ column: "a", op: "=", value: "1" }, { column: "b", op: "is null", value: "ignored" }] });
    expect(r.filters).toEqual([
      { column: "a", op: "=", value: "1" },
      { column: "b", op: "is null", value: undefined },
    ]);
    expect(() => normalizeBrowseRequest({ filters: [{ column: "a", op: "in", value: "1" }] })).toThrow(/opérateur/);
    expect(() => normalizeBrowseRequest({ filters: [{ column: "a", op: "=" }] })).toThrow(/valeur/);
    expect(() => normalizeBrowseRequest({ filters: [{ op: "=", value: "1" }] })).toThrow(/colonne/);
    expect(() => normalizeBrowseRequest({ filters: Array.from({ length: MAX_FILTERS + 1 }, () => ({ column: "a", op: "is null" })) })).toThrow(/filtres/);
    expect(() => normalizeBrowseRequest({ filters: [{ column: "a", op: "=", value: "x".repeat(5000) }] })).toThrow(/longue/);
    expect(FILTER_OPS).toHaveLength(9);
  });
  it("defaults sort direction to asc", () => {
    expect(normalizeBrowseRequest({ sortColumn: "a", sortDir: "sideways" }).sortDir).toBe("asc");
    expect(normalizeBrowseRequest({ sortColumn: "" }).sortColumn).toBeUndefined();
  });
  it("truncates long cells", () => {
    expect(truncateCell("x".repeat(5000))).toMatch(/tronqué, 5000/);
    expect(truncateCell("short")).toBe("short");
    expect(truncateCell(42)).toBe(42);
  });
});

describe("SQL composition", () => {
  const columns = ["id", "name", "created_at"];
  it("binds every value and quotes identifiers (postgres style)", () => {
    const c = composeBrowse({
      quote: quoteDouble,
      placeholder: placeholderDollar,
      table: '"public"."users"',
      columns,
      req: { page: 3, pageSize: 25, sortColumn: "name", sortDir: "desc", filters: [{ column: "name", op: "like", value: "%o'; DROP TABLE users; --" }, { column: "created_at", op: "is not null" }] },
    });
    expect(c.select).toBe('SELECT "id", "name", "created_at" FROM "public"."users" WHERE "name" LIKE $1 AND "created_at" IS NOT NULL ORDER BY "name" DESC LIMIT $2 OFFSET $3');
    expect(c.params).toEqual(["%o'; DROP TABLE users; --", 25, 50]);
    expect(c.count).toBe('SELECT count(*) AS n FROM "public"."users" WHERE "name" LIKE $1 AND "created_at" IS NOT NULL');
    expect(c.whereParams).toEqual(["%o'; DROP TABLE users; --"]);
    expect(c.select).not.toContain("DROP");
  });
  it("uses ? placeholders and backticks (mysql style)", () => {
    const c = composeBrowse({ quote: quoteBacktick, placeholder: placeholderQuestion, table: "`db`.`t`", columns, req: { page: 1, pageSize: 10, filters: [{ column: "id", op: ">=", value: "5" }] } });
    expect(c.select).toBe("SELECT `id`, `name`, `created_at` FROM `db`.`t` WHERE `id` >= ? ORDER BY `id` LIMIT ? OFFSET ?");
    expect(c.params).toEqual(["5", 10, 0]);
  });
  it("supports OFFSET ... FETCH paging", () => {
    const c = composeBrowse({ quote: quoteDouble, placeholder: placeholderDollar, table: "t", columns, req: { page: 2, pageSize: 10, filters: [] }, paging: "offset-fetch" });
    expect(c.select).toMatch(/OFFSET \$1 ROWS FETCH NEXT \$2 ROWS ONLY$/);
    expect(c.params).toEqual([10, 10]);
  });
  it("refuses unknown or malformed sort/filter columns", () => {
    const base = { quote: quoteDouble, placeholder: placeholderDollar, table: "t", columns };
    expect(() => composeBrowse({ ...base, req: { page: 1, pageSize: 10, sortColumn: "nope", filters: [] } })).toThrow(/tri inconnue/);
    expect(() => composeBrowse({ ...base, req: { page: 1, pageSize: 10, sortColumn: "id; DROP", filters: [] } })).toThrow(/invalide/);
    expect(() => composeBrowse({ ...base, req: { page: 1, pageSize: 10, filters: [{ column: "1=1", op: "=", value: "1" }] } })).toThrow(/invalide/);
    expect(() => composeBrowse({ ...base, req: { page: 1, pageSize: 10, filters: [{ column: "password", op: "=", value: "1" }] } })).toThrow(/filtre inconnue/);
    expect(() => composeBrowse({ ...base, req: { page: 1, pageSize: 10, filters: [{ column: "id", op: "in" as never, value: "1" }] } })).toThrow(/Opérateur/);
    expect(() => composeBrowse({ ...base, columns: [], req: { page: 1, pageSize: 10, filters: [] } })).toThrow(/colonnes/);
  });
  it("applies the cast hook per op", () => {
    const c = composeBrowse({ quote: quoteDouble, placeholder: placeholderDollar, table: "t", columns, columnTypes: { id: "integer" }, castForOp: (q, op, t) => (op === "like" && t !== "text" ? `${q}::text` : q), req: { page: 1, pageSize: 10, filters: [{ column: "id", op: "like", value: "1%" }] } });
    expect(c.select).toContain('"id"::text LIKE $1');
  });
  it("audit params never carry filter values", () => {
    const a = auditParams({ page: 2, pageSize: 50, sortColumn: "name", sortDir: "desc", filters: [{ column: "email", op: "=", value: "secret@example.org" }] });
    expect(JSON.stringify(a)).not.toContain("secret");
    expect(a).toEqual({ page: 2, pageSize: 50, sort: "name desc", filters: ["email = ?"] });
  });
});
