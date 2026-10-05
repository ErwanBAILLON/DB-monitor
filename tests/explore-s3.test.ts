import { describe, expect, it } from "vitest";
import { normalizeBrowseRequest } from "@/lib/explore/types";
import { BROWSE_COLUMNS, SCAN_CAP, assertBucket, assertColumn, assertKey, compileFilters, isPrefix, likeToRegex, pageEntries, prefixOf, type Entry } from "@/lib/explore/s3";

// S3 explorer: no SQL, so the unit tests cover identifier validation (bucket / key / column)
// and the in-memory filter + sort + page composition applied to a bounded listing.

const e = (key: string, size: number, lm: string | null = "2026-01-01T00:00:00.000Z", sc: string | null = "STANDARD"): Entry => ({ key, size, last_modified: lm, etag: `${key}-etag`, storage_class: sc });
const entries: Entry[] = [e("a/1.txt", 10), e("a/2.json", 200, "2026-02-01T00:00:00.000Z"), e("b/3.bin", 3000, "2025-12-01T00:00:00.000Z", null), e("c.csv", 0, null), e("b/4.txt", 50)];

describe("s3 explorer identifiers", () => {
  it("accepts S3 bucket names and refuses the rest", () => {
    for (const b of ["minio-backups", "a.b.c", "abc", "x".repeat(63)]) expect(assertBucket(b)).toBe(b);
    for (const b of ["AB", "a", "a..b", "a_b", "bucket; drop", "1=1", "", " ab", "a/b", null, 42, "x".repeat(64)]) expect(() => assertBucket(b), String(b)).toThrow(/invalide/);
  });
  it("accepts keys, prefixes and the root marker; refuses traversal and control chars", () => {
    for (const k of ["/", "photos/", "photos/2026/", "file.txt", "a b/c d.json", "é/ü.txt", "x".repeat(1024)]) expect(assertKey(k)).toBe(k);
    for (const k of ["", "/abs", "a//b", "../x", "a/../b", "a\u0000b", "a\nb", "x".repeat(1025), null, 7]) expect(() => assertKey(k), String(k)).toThrow(/invalide/);
    expect(isPrefix("/")).toBe(true);
    expect(isPrefix("a/")).toBe(true);
    expect(isPrefix("a/b.txt")).toBe(false);
    expect(prefixOf("/")).toBe("");
    expect(prefixOf("a/")).toBe("a/");
  });
  it("only knows the five listing columns", () => {
    for (const c of BROWSE_COLUMNS) expect(assertColumn(c)).toBe(c);
    for (const c of ["id; DROP", "1=1", "Key", "size ", "", "preview", null]) expect(() => assertColumn(c), String(c)).toThrow(/invalide/);
  });
});

describe("s3 explorer filters", () => {
  it("translates LIKE patterns and escapes regex metacharacters", () => {
    expect(likeToRegex("a%").test("abc")).toBe(true);
    expect(likeToRegex("a%").test("ba")).toBe(false);
    expect(likeToRegex("a_c").test("abc")).toBe(true);
    expect(likeToRegex("a_c").test("abbc")).toBe(false);
    expect(likeToRegex("%.txt").test("x/y.txt")).toBe(true);
    expect(likeToRegex("%.txt").test("x/ytxt")).toBe(false);
    expect(likeToRegex("(a+)").test("(a+)")).toBe(true);
    expect(likeToRegex("(a+)").test("aa")).toBe(false);
  });
  it("derives a server-side prefix hint only from key = / key like 'x%'", () => {
    expect(compileFilters([{ column: "key", op: "like", value: "photos/%" }]).prefixHint).toBe("photos/");
    expect(compileFilters([{ column: "key", op: "=", value: "photos/a.txt" }]).prefixHint).toBe("photos/a.txt");
    expect(compileFilters([{ column: "key", op: "like", value: "%.txt" }]).prefixHint).toBeUndefined();
    expect(compileFilters([{ column: "key", op: "like", value: "a_b%" }]).prefixHint).toBeUndefined();
    expect(compileFilters([{ column: "size", op: "like", value: "1%" }]).prefixHint).toBeUndefined();
  });
  it("refuses unknown columns, ops and non-numeric size values", () => {
    expect(() => compileFilters([{ column: "id; DROP", op: "=", value: "1" }])).toThrow(/invalide/);
    expect(() => compileFilters([{ column: "key", op: "in" as never, value: "1" }])).toThrow(/Opérateur/);
    expect(() => compileFilters([{ column: "size", op: ">", value: "abc" }])).toThrow(/nombre/);
    expect(() => compileFilters([{ column: "size", op: "is null" }])).not.toThrow();
  });
  it("compares size numerically and strings lexically, null-aware", () => {
    const req = (filters: unknown[]) => normalizeBrowseRequest({ filters, pageSize: 100 });
    const keys = (r: { rows: Record<string, unknown>[] }) => r.rows.map((x) => x.key);
    expect(keys(pageEntries(entries, req([{ column: "size", op: ">=", value: "50" }]), false))).toEqual(["a/2.json", "b/3.bin", "b/4.txt"]);
    expect(keys(pageEntries(entries, req([{ column: "size", op: "<", value: "9" }]), false))).toEqual(["c.csv"]);
    expect(keys(pageEntries(entries, req([{ column: "storage_class", op: "is null" }]), false))).toEqual(["b/3.bin"]);
    expect(keys(pageEntries(entries, req([{ column: "last_modified", op: "is not null" }, { column: "key", op: "like", value: "%.txt" }]), false))).toEqual(["a/1.txt", "b/4.txt"]);
    expect(keys(pageEntries(entries, req([{ column: "key", op: "!=", value: "c.csv" }, { column: "last_modified", op: ">", value: "2026-01-15" }]), false))).toEqual(["a/2.json"]);
    expect(keys(pageEntries(entries, req([{ column: "etag", op: "=", value: "c.csv-etag" }]), false))).toEqual(["c.csv"]);
  });
});

describe("s3 explorer sort and pagination", () => {
  it("sorts by any column with key as tie-breaker and defaults to key asc", () => {
    const keys = (r: { rows: Record<string, unknown>[] }) => r.rows.map((x) => x.key);
    expect(keys(pageEntries(entries, normalizeBrowseRequest({}), false))).toEqual(["a/1.txt", "a/2.json", "b/3.bin", "b/4.txt", "c.csv"]);
    expect(keys(pageEntries(entries, normalizeBrowseRequest({ sortColumn: "size", sortDir: "desc" }), false))).toEqual(["b/3.bin", "a/2.json", "b/4.txt", "a/1.txt", "c.csv"]);
    expect(keys(pageEntries(entries, normalizeBrowseRequest({ sortColumn: "last_modified" }), false)).slice(0, 2)).toEqual(["c.csv", "b/3.bin"]);
    expect(() => pageEntries(entries, normalizeBrowseRequest({ sortColumn: "key; DROP" }), false)).toThrow(/invalide/);
    expect(() => pageEntries(entries, normalizeBrowseRequest({ sortColumn: "1=1" }), false)).toThrow(/invalide/);
  });
  it("pages with exact total, flags the cap as an estimate", () => {
    const p2 = pageEntries(entries, normalizeBrowseRequest({ page: 2, pageSize: 2 }), false);
    expect(p2.rows.map((x) => x.key)).toEqual(["b/3.bin", "b/4.txt"]);
    expect(p2).toMatchObject({ page: 2, pageSize: 2, total: 5, totalIsEstimate: false, columns: [...BROWSE_COLUMNS] });
    expect(pageEntries(entries, normalizeBrowseRequest({ page: 9 }), false).rows).toEqual([]);
    const capped = pageEntries(entries, normalizeBrowseRequest({}), true);
    expect(capped.totalIsEstimate).toBe(true);
    expect(capped.notes?.[0]).toMatch(new RegExp(String(SCAN_CAP)));
  });
  it("returns plain rows (no Date / bigint)", () => {
    const r = pageEntries(entries, normalizeBrowseRequest({ pageSize: 1 }), false);
    expect(r.rows[0]).toEqual({ key: "a/1.txt", size: 10, last_modified: "2026-01-01T00:00:00.000Z", etag: "a/1.txt-etag", storage_class: "STANDARD" });
  });
});
