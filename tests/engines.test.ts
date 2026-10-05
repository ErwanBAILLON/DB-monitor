import { describe, expect, it } from "vitest";
import { flavourOf as myFlavour, kv, replicationSummary } from "@/lib/drivers/mysql";
import { fromServerStatus, guardMongoSpec } from "@/lib/drivers/mongodb";
import { toRows } from "@/lib/drivers/clickhouse";
import { flavourOf as redisFlavour, parseInfo, versionLabel } from "@/lib/drivers/redis";
import { guardReadOnly } from "@/lib/sqlguard";
import { DEFAULT_PORT, ENGINES, ENGINE_BADGE, ENGINE_LABEL, HAS_CONSOLE } from "@/lib/drivers/types";

describe("engine registry", () => {
  it("has a label, badge, default port and console flag for every engine", () => {
    for (const e of ENGINES) {
      expect(ENGINE_LABEL[e]).toBeTruthy();
      expect(ENGINE_BADGE[e]).toMatch(/^[A-Z]{2}$/);
      expect(DEFAULT_PORT[e]).toBeGreaterThanOrEqual(0);
      expect(typeof HAS_CONSOLE[e]).toBe("boolean");
    }
    expect(new Set(Object.values(ENGINE_BADGE)).size).toBe(ENGINES.length);
  });
});

describe("mysql parsers", () => {
  it("maps SHOW rows to a dictionary", () => {
    expect(kv([{ Variable_name: "Uptime", Value: "12" }, { Variable_name: "Threads_connected", Value: "3" }])).toEqual({ Uptime: "12", Threads_connected: "3" });
  });
  it("detects MariaDB vs MySQL", () => {
    expect(myFlavour("11.4.3-MariaDB-ubu2404", "mariadb.org binary distribution")).toBe("mariadb");
    expect(myFlavour("8.4.3", "MySQL Community Server - GPL")).toBe("mysql");
  });
  it("summarises replication status from MySQL 8 and MariaDB column names", () => {
    expect(replicationSummary(undefined)).toBeNull();
    expect(replicationSummary({ Source_Host: "p", Replica_IO_Running: "Yes", Replica_SQL_Running: "Yes", Seconds_Behind_Source: 0, Last_Error: "" })).toMatchObject({ source_host: "p", io_running: "Yes", seconds_behind: 0 });
    expect(replicationSummary({ Master_Host: "m", Slave_IO_Running: "No", Slave_SQL_Running: "Yes", Seconds_Behind_Master: null })).toMatchObject({ source_host: "m", io_running: "No" });
  });
});

describe("mongodb parsers and guard", () => {
  const standalone = { version: "7.0.14", uptime: 1234.6, connections: { current: 5, available: 838855, totalCreated: 20 } };
  it("reads serverStatus for a standalone", () => {
    expect(fromServerStatus(standalone)).toEqual({ version: "7.0.14", uptimeSec: 1235, connUsed: 5, connMax: 838860, role: "standalone" });
  });
  it("reads the role of a replica set member", () => {
    expect(fromServerStatus({ ...standalone, repl: { isWritablePrimary: true, setName: "rs0" } }).role).toBe("primary");
    expect(fromServerStatus({ ...standalone, repl: { isWritablePrimary: false, secondary: true } }).role).toBe("secondary");
    expect(fromServerStatus(standalone, { myState: 2 }).role).toBe("secondary");
  });
  it("accepts find and aggregate specs within limits", () => {
    const f = guardMongoSpec('{"collection":"users","filter":{"a":{"$gt":1}},"limit":10}');
    expect(f.ok && f.spec.limit).toBe(10);
    const d = guardMongoSpec('{"collection":"users"}');
    expect(d.ok && d.spec.limit).toBe(50);
    expect(guardMongoSpec('{"collection":"users","pipeline":[{"$match":{}},{"$group":{"_id":"$x","n":{"$sum":1}}}]}').ok).toBe(true);
  });
  it("rejects code execution, writes, system collections and bad limits", () => {
    const ko = (s: string, re: RegExp) => {
      const r = guardMongoSpec(s);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(re);
    };
    ko('{"collection":"u","filter":{"$where":"this.a==1"}}', /\$where/);
    ko('{"collection":"u","pipeline":[{"$project":{"x":{"$function":{"body":"","args":[],"lang":"js"}}}}]}', /\$function/);
    ko('{"collection":"u","pipeline":[{"$out":"y"}]}', /\$out/);
    ko('{"collection":"u","pipeline":[{"$merge":{"into":"y"}}]}', /\$merge/);
    ko('{"collection":"u","filter":{"a":{"$expr":{"$where":1}}}}', /\$where/);
    ko('{"collection":"system.users"}', /collection/);
    ko('{"collection":"x.system.users"}', /collection/);
    // Stages that read another collection must not reach system.* either (credential documents).
    ko('{"collection":"x","pipeline":[{"$unionWith":"system.users"}]}', /\$unionWith vers system\.users/);
    ko('{"collection":"x","pipeline":[{"$unionWith":{"coll":"system.users","pipeline":[]}}]}', /\$unionWith/);
    ko('{"collection":"x","pipeline":[{"$lookup":{"from":"system.users","localField":"a","foreignField":"b","as":"u"}}]}', /\$lookup vers system\.users/);
    ko('{"collection":"x","pipeline":[{"$lookup":{"from":{"db":"admin","coll":"system.users"},"as":"u","pipeline":[]}}]}', /\$lookup/);
    ko('{"collection":"x","pipeline":[{"$graphLookup":{"from":"system.version","startWith":"$a","connectFromField":"a","connectToField":"b","as":"g"}}]}', /\$graphLookup/);
    ko('{"collection":"x","pipeline":[{"$facet":{"f":[{"$unionWith":"system.users"}]}}]}', /\$unionWith/);
    ko('{"collection":"x","pipeline":[{"$listSampledQueries":{}}]}', /\$listSampledQueries/);
    // Legitimate joins stay allowed.
    expect(guardMongoSpec('{"collection":"orders","pipeline":[{"$lookup":{"from":"customers","localField":"c","foreignField":"_id","as":"cust"}},{"$unionWith":"archive"}]}').ok).toBe(true);
    expect(guardMongoSpec('{"collection":"x","pipeline":[{"$lookup":{"as":"d","pipeline":[{"$documents":[{"a":1}]}]}}]}').ok).toBe(true);
    ko('{"collection":"u","limit":201}', /limit/);
    ko('{"collection":"u","limit":0}', /limit/);
    ko("not json", /JSON/);
    ko("[]", /objet/);
  });
});

describe("clickhouse parsers", () => {
  it("turns JSONCompact into rows", () => {
    expect(toRows({ meta: [{ name: "a", type: "UInt8" }, { name: "b", type: "String" }], data: [[1, "x"], [2, "y"]], rows: 2 })).toEqual([{ a: 1, b: "x" }, { a: 2, b: "y" }]);
  });
  it("lets the guard accept DESCRIBE / EXISTS for ClickHouse only", () => {
    expect(guardReadOnly("DESCRIBE TABLE system.parts").ok).toBe(false);
    expect(guardReadOnly("DESCRIBE TABLE system.parts", { allowFirst: ["describe"] }).ok).toBe(true);
    expect(guardReadOnly("EXISTS TABLE t", { allowFirst: ["exists"] }).ok).toBe(true);
    expect(guardReadOnly("DROP TABLE t", { allowFirst: ["describe", "exists"] }).ok).toBe(false);
  });
});

describe("redis-compatible flavour", () => {
  it("detects Valkey, Dragonfly, KeyDB and plain Redis from INFO server", () => {
    const valkey = parseInfo("# Server\r\nredis_version:7.2.4\r\nserver_name:valkey\r\nvalkey_version:8.0.1\r\n").server;
    expect(redisFlavour(valkey)).toEqual({ flavour: "valkey", version: "8.0.1" });
    expect(versionLabel(valkey)).toBe("valkey 8.0.1");
    expect(redisFlavour({ redis_version: "6.2.11", dragonfly_version: "df-v1.21.0" })).toEqual({ flavour: "dragonfly", version: "v1.21.0" });
    expect(redisFlavour({ redis_version: "6.3.4", keydb_version: "6.3.4" }).flavour).toBe("keydb");
    expect(versionLabel({ redis_version: "7.4.0" })).toBe("7.4.0");
  });
});

describe("opensearch parsers and guard", () => {
  it("builds the probe from root, health and node stats", async () => {
    const { fromCluster } = await import("@/lib/drivers/opensearch");
    const p = fromCluster(
      { version: { number: "2.17.0", distribution: "opensearch" } },
      { status: "yellow", number_of_nodes: 1 },
      { nodes: { a: { jvm: { uptime_in_millis: 61_000, mem: { heap_used_in_bytes: 100, heap_max_in_bytes: 1000 } }, indices: { store: { size_in_bytes: 2048 } }, http: { current_open: 3 } } } },
    );
    expect(p).toEqual({ version: "opensearch 2.17.0", uptimeSec: 61, connUsed: 3, sizeBytes: 2048n, role: "yellow · 1 nœud(s)" });
    expect(fromCluster({ version: { number: "8.15.0" } }, { status: "green" }, {}).version).toBe("elasticsearch 8.15.0");
  });
  it("guards the search body", async () => {
    const { guardSearch } = await import("@/lib/drivers/opensearch");
    expect(guardSearch("logs-*", '{"query":{"match_all":{}}}')).toMatchObject({ ok: true, body: { size: 20 } });
    expect(guardSearch("logs", "")).toMatchObject({ ok: true, body: { size: 20 } });
    expect(guardSearch(".kibana", "{}").ok).toBe(false);
    expect(guardSearch("Logs", "{}").ok).toBe(false);
    expect(guardSearch("logs", '{"size":101}').ok).toBe(false);
    expect(guardSearch("logs", '{"script_fields":{"x":{"script":"1"}}}').ok).toBe(false);
    expect(guardSearch("logs", "[1]").ok).toBe(false);
  });
});

describe("mssql and sqlite helpers", () => {
  it("shortens @@VERSION", async () => {
    const { shortVersion } = await import("@/lib/drivers/mssql");
    expect(shortVersion("Microsoft SQL Server 2022 (RTM-CU15) (KB5041321) - 16.0.4145.4 (X64) \n\tJul 24 2024 Developer Edition (64-bit) on Linux")).toBe("2022 16.0.4145.4");
  });
  it("T-SQL guard: refuses mid-batch statements, EXEC smuggling and server-level commands", async () => {
    const { guardTsql } = await import("@/lib/drivers/mssql");
    const ok = (s: string) => expect(guardTsql(s).ok, s).toBe(true);
    const ko = (s: string, re: RegExp) => {
      const r = guardTsql(s);
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(re);
    };
    ok("SELECT 1 AS one, 'x' AS s");
    ok("SELECT TOP 10 name FROM sys.tables ORDER BY name OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY");
    ok("SELECT * FROM [dbo].[Orders] o WHERE o.[status] = 'exec kill' AND o.n > 1");
    ok("SELECT CASE WHEN a > 1 THEN 'a' ELSE 'b' END FROM t");
    ok("WITH c AS (SELECT 1 AS n) SELECT * FROM c");
    ok("EXEC sp_who");
    ok("EXEC sp_who2 'active'");
    ok("EXECUTE sp_help 'dbo.Orders'");
    ok("exec sp_who @loginame = N'sa'");
    ok("EXEC sp_configure");
    ok("EXEC sp_configure 'max server memory (MB)'");
    ok("EXEC sp_spaceused N'dbo.t'");
    // T-SQL does not need ';' between statements: any second statement is refused.
    ko("SELECT 1 EXEC sp_executesql N'DROP DATABASE foo'", /EXEC/);
    ko("SELECT 1 EXEC('DROP TABLE t')", /EXEC/);
    ko("SELECT 1\nEXEC sp_configure 'show advanced options', 1\nRECONFIGURE WITH OVERRIDE", /EXEC|RECONFIGURE/);
    ko("SELECT 1 KILL 55", /KILL/);
    ko("SELECT 1 SHUTDOWN WITH NOWAIT", /SHUTDOWN/);
    ko("SELECT 1 WAITFOR DELAY '00:00:30'", /WAITFOR/);
    ko("SELECT 1 DBCC FREEPROCCACHE", /DBCC/);
    ko("SELECT 1 BACKUP DATABASE x TO DISK = 'y'", /BACKUP/);
    ko("SELECT 1 USE master", /USE/);
    ko("SELECT 1 DECLARE @x int", /DECLARE/);
    ko("SELECT 1 SET IDENTITY_INSERT t ON", /SET/);
    ko("SELECT 1 BEGIN TRAN", /BEGIN/);
    ko("SELECT * FROM OPENROWSET(BULK 'x', SINGLE_BLOB) AS t", /OPENROWSET|BULK/);
    ko("SELECT * FROM sys.fn_trace_gettable('x', 1)", /FN_TRACE/);
    ko("SELECT 1 FROM [xp_cmdshell]", /xp_cmdshell/);
    ko("SELECT * FROM t WHERE [a", /non terminé/);
    // EXEC: allowlisted read procedures only, no nested statement in the arguments.
    ko("EXEC sp_configure 'max server memory (MB)', 256", /lecture/);
    ko("EXEC sp_executesql N'DROP DATABASE foo'", /EXEC/);
    ko("EXEC xp_cmdshell 'ls'", /EXEC/);
    ko("EXEC sp_addsrvrolemember 'x','sysadmin'", /EXEC/);
    ko("EXEC sp_OACreate 'WScript.Shell', @o OUT", /EXEC/);
    ko("EXEC sp_who EXEC sp_executesql N'EXEC x' + 'p_cmdshell ''dir'''", /Arguments/);
    ko("EXEC sp_help 'x' SELECT 1", /Arguments/);
    ko("EXEC sp_help ('x')", /Arguments/);
    ko("EXEC sp_help 'x'; DROP TABLE t", /seule|instruction/i);
    ko("SELECT 1 INSERT INTO t VALUES (1)", /INSERT/);
  });
  it("confines sqlite paths to the allowed roots", async () => {
    const { resolvePath, roots } = await import("@/lib/drivers/sqlite");
    expect(roots("/data/sqlite, /mnt/x/")).toEqual(["/data/sqlite", "/mnt/x"]);
    expect(resolvePath("/data/sqlite/app.db", ["/data/sqlite"])).toBe("/data/sqlite/app.db");
    expect(() => resolvePath("/data/sqlite/../../etc/passwd", ["/data/sqlite"])).toThrow(/hors/);
    expect(() => resolvePath("/data/sqlite2/app.db", ["/data/sqlite"])).toThrow(/hors/);
    expect(() => resolvePath("", ["/data/sqlite"])).toThrow(/requis/);
    expect(() => resolvePath("/x.db", [])).toThrow(/DBMON_SQLITE_ROOTS/);
  });
});
