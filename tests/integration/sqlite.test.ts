import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as sq from "@/lib/drivers/sqlite";
import type { Conn } from "@/lib/drivers/types";

// SQLite needs no server: the "live" test creates the sample file like the pod does and reads it back.
describe("sqlite driver (integration, local file)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dbmon-sqlite-"));
  const file = path.join(dir, "sample.db");
  const conn: Conn = { type: "sqlite", host: "localhost", port: 0, database: file, tls: false };
  beforeAll(async () => {
    process.env.DBMON_SQLITE_ROOTS = dir;
    await sq.createSample(file);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("probes the file", async () => {
    const p = await sq.probe(conn);
    expect(p.up, p.error).toBe(true);
    expect(p.version).toMatch(/^SQLite 3\./);
    expect(p.sizeBytes! > 0n).toBe(true);
    expect(p.role).toBe("delete");
  });

  it("refuses paths outside the allowed roots and missing files", async () => {
    expect((await sq.probe({ ...conn, database: "/etc/passwd" })).error).toMatch(/hors des répertoires/);
    expect((await sq.probe({ ...conn, database: path.join(dir, "nope.db") })).error).toMatch(/introuvable/);
    expect(() => sq.resolvePath(file, [])).toThrow(/DBMON_SQLITE_ROOTS/);
  });

  it("lists tables, indexes and pragmas", async () => {
    const d = await sq.detail(conn);
    expect(d.tables.find((t) => t.name === "visits")?.rows).toBe(500);
    expect(d.indexes.map((i) => i.name)).toContain("visits_at");
    expect(d.pragmas.find((p) => p.name === "page_size")?.value).toBeGreaterThan(0);
    expect(d.file.integrity).toBe("ok");
    expect((await sq.integrityCheck(conn))[0]).toEqual({ integrity_check: "ok" });
  });

  it("runs read-only queries; the read-only handle refuses writes even if the guard were bypassed", async () => {
    const r = await sq.readOnlyQuery(conn, "SELECT status, count(*) AS n FROM visits GROUP BY status ORDER BY n DESC");
    expect(r.rows[0]).toEqual({ status: 200, n: 470 });
    expect((await sq.readOnlyQuery(conn, "PRAGMA journal_mode")).rows[0]).toEqual({ journal_mode: "delete" });
    await expect(sq.readOnlyQuery(conn, "DELETE FROM visits")).rejects.toThrow(/SELECT/);
    await expect(sq.readOnlyQuery(conn, "PRAGMA journal_mode = wal")).rejects.toThrow(/écriture/);
    await expect(sq.withDb(conn, (db) => db.exec("DELETE FROM visits"))).rejects.toThrow(/readonly/i);
  });
});
