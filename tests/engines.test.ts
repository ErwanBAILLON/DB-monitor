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
      expect(ENGINE_BADGE[e]).toMatch(/^[A-Z][A-Z0-9]$/);
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

describe("cassandra parsers and CQL guard", () => {
  it("builds the probe from system.local / peers (uptime from gossip_generation)", async () => {
    const { fromLocal, parseUptime } = await import("@/lib/drivers/cassandra");
    const now = 1_800_000_000_000;
    const p = fromLocal({ release_version: "3.0.8", data_center: "datacenter1", rack: "rack1", gossip_generation: 1_799_999_940 }, [], 2, { scyllaVersion: "6.1.5-0.20250119.c84780618297", runtimeUptime: "1 day, 2 hours, 3 minutes, 4 seconds" }, now);
    expect(p).toEqual({ version: "scylla 6.1.5-0.20250119.c84780618297", uptimeSec: 93784, connUsed: 2, role: "datacenter1/rack1 · 1 nœud" });
    expect(fromLocal({ release_version: "3.0.8", data_center: "d", rack: "r", gossip_generation: 1_799_999_940 }, [], 2, {}, now).uptimeSec).toBe(60);
    expect(parseUptime("43 seconds")).toBe(43);
    expect(parseUptime(undefined)).toBeUndefined();
    const c = fromLocal({ release_version: "4.1.5", data_center: "dc1", rack: "r1" }, [{ data_center: "dc1" }, { data_center: "dc2" }], undefined, {}, now);
    expect(c).toEqual({ version: "cassandra 4.1.5", uptimeSec: undefined, connUsed: undefined, role: "dc1/r1 · 3 nœuds · 2 DC" });
  });
  it("converts CQL driver values", async () => {
    const { cqlValue } = await import("@/lib/drivers/cassandra");
    const { types } = await import("cassandra-driver");
    expect(cqlValue(types.Long.fromNumber(42))).toBe("42");
    expect(cqlValue(types.Uuid.fromString("6ba7b810-9dad-11d1-80b4-00c04fd430c8"))).toBe("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
    expect(cqlValue(new Map([["a", 1]]))).toBe('{"a":1}');
    expect(cqlValue(Buffer.from("ab"))).toBe("0x6162");
    expect(cqlValue(null)).toBeNull();
  });
  it("CQL guard: SELECT only, LIMIT forced <= 200, no DML/DDL/BATCH, no system_auth", async () => {
    const { guardCql, CONSOLE_LIMIT } = await import("@/lib/drivers/cassandra");
    expect(CONSOLE_LIMIT).toBe(200);
    const ok = (s: string) => {
      const r = guardCql(s);
      expect(r.ok, s).toBe(true);
      return r.ok ? r.cql : "";
    };
    const ko = (s: string, re: RegExp) => {
      const r = guardCql(s);
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(re);
    };
    expect(ok("SELECT * FROM system.local")).toBe("SELECT * FROM system.local\nLIMIT 200");
    expect(ok("select * from system.local;")).toBe("select * from system.local\nLIMIT 200");
    expect(ok("SELECT * FROM t LIMIT 10")).toBe("SELECT * FROM t LIMIT 10");
    expect(ok("SELECT * FROM t LIMIT 5000")).toBe("SELECT * FROM t LIMIT 200");
    expect(ok("SELECT * FROM t WHERE a = 1 ALLOW FILTERING")).toBe("SELECT * FROM t WHERE a = 1\nLIMIT 200 ALLOW FILTERING");
    expect(ok("SELECT * FROM t LIMIT 999 ALLOW FILTERING")).toBe("SELECT * FROM t LIMIT 200 ALLOW FILTERING");
    expect(ok("SELECT * FROM t WHERE name = 'DROP TABLE x'")).toContain("LIMIT 200");
    expect(ok("SELECT * FROM t WHERE url = 'http://x' -- c")).toBe("SELECT * FROM t WHERE url = 'http://x' -- c\nLIMIT 200");
    ko("", /vide/);
    ko("INSERT INTO t (a) VALUES (1)", /SELECT/);
    ko("UPDATE t SET a = 1 WHERE b = 2", /SELECT/);
    ko("DELETE FROM t WHERE a = 1", /SELECT/);
    ko("TRUNCATE t", /SELECT/);
    ko("DROP TABLE t", /SELECT/);
    ko("ALTER TABLE t ADD c int", /SELECT/);
    ko("CREATE TABLE t (a int PRIMARY KEY)", /SELECT/);
    ko("BEGIN BATCH INSERT INTO t (a) VALUES (1); APPLY BATCH", /SELECT|instruction/);
    ko("GRANT SELECT ON ALL KEYSPACES TO x", /SELECT/);
    ko("SELECT * FROM t; DROP TABLE t", /Une seule/);
    ko("SELECT * FROM t WHERE a = 'x", /Littéral/);
    ko("SELECT * FROM system_auth.roles", /system_auth/);
    ko("SELECT * FROM t LIMIT :n", /LIMIT/);
    ko('SELECT "DROP"(1) FROM t', /guillemets/);
  });
});

describe("influxdb parsers and Flux guard", () => {
  it("parses Go durations and builds the probe", async () => {
    const { fromHealth, parseGoDuration, retentionLabel } = await import("@/lib/drivers/influxdb");
    expect(parseGoDuration("14m15.114803232s")).toBe(855);
    expect(parseGoDuration("2h3m4s")).toBe(7384);
    expect(parseGoDuration("26.3s")).toBe(26);
    expect(parseGoDuration(undefined)).toBeUndefined();
    expect(fromHealth({ status: "pass", version: "v2.7.12" }, { status: "ready", up: "1h" }, [{ id: "o" }], [{ type: "user" }, { type: "system" }, { type: "user" }])).toEqual({ version: "2.7.12", uptimeSec: 3600, role: "pass · 1 org · 2 buckets" });
    expect(retentionLabel([{ type: "expire", everySeconds: 604800 }])).toBe("7 j");
    expect(retentionLabel([{ type: "expire", everySeconds: 0 }])).toBe("infini");
    expect(retentionLabel([{ everySeconds: 7200 }])).toBe("2 h");
  });
  it("parses annotated CSV with several tables and typed columns", async () => {
    const { parseAnnotatedCsv } = await import("@/lib/drivers/influxdb");
    const csv = '#datatype,string,long,dateTime:RFC3339,double,string\n#group,false,false,false,false,true\n#default,_result,,,,\n,result,table,_time,_value,host\n,_result,0,2026-10-05T12:00:00Z,0.5,"a,b"\n,_result,0,2026-10-05T12:01:00Z,,a\n\n#datatype,string,long,long\n#group,false,false,false\n#default,_result,,\n,result,table,_value\n,_result,1,42\n';
    const r = parseAnnotatedCsv(csv);
    expect(r.columns).toEqual(["table", "_time", "_value", "host"]);
    expect(r.rows).toEqual([
      { table: 0, _time: "2026-10-05T12:00:00Z", _value: 0.5, host: "a,b" },
      { table: 0, _time: "2026-10-05T12:01:00Z", _value: null, host: "a" },
      { table: 1, _value: 42 },
    ]);
    expect(parseAnnotatedCsv("").rows).toEqual([]);
  });
  it("Flux guard: range() required, no to()/experimental/http/sql/secrets, limit appended", async () => {
    const { guardFlux } = await import("@/lib/drivers/influxdb");
    const ok = (s: string) => {
      const r = guardFlux(s);
      expect(r.ok, s).toBe(true);
      return r.ok ? r.flux : "";
    };
    const ko = (s: string, re: RegExp) => {
      const r = guardFlux(s);
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(re);
    };
    expect(ok('from(bucket: "m") |> range(start: -1h)')).toBe('from(bucket: "m") |> range(start: -1h)\n  |> limit(n: 200)');
    ok('import "influxdata/influxdb/schema"\nschema.measurements(bucket: "m")');
    ok("buckets()");
    ok('import "influxdata/influxdb"\ninfluxdb.cardinality(bucket: "m", start: -1d)');
    ok('from(bucket: "m") |> range(start: -1h) |> filter(fn: (r) => r.host == "to(")');
    ok('from(bucket: "m") |> range(start: -1h) |> filter(fn: (r) => r.url == "http://x") // to()');
    ko("", /vide/);
    ko('from(bucket: "m") |> filter(fn: (r) => true)', /range/);
    ko('from(bucket: "m") |> range(start: -1h) |> to(bucket: "other")', /to\(\)/);
    ko('import "experimental"\nexperimental.to(bucket: "x")', /experimental|Import|to\(\)/);
    ko('import "experimental/http"\nhttp.post(url: "http://x")', /http|Import/);
    ko('import "sql"\nsql.from(driverName: "postgres", dataSourceName: "", query: "")', /sql|Import/);
    ko('import "influxdata/influxdb/secrets"\nsecrets.get(key: "k")', /secrets|Import/);
    ko('import "slack"\nfrom(bucket:"m") |> range(start:-1h)', /Import|notification/);
    ko('from(bucket: "m") |> range(start: -1h) |> wideTo(bucket: "x")', /wideTo/);
    ko('from(bucket: "m") |> range(start: -1h) |> filter(fn: (r) => r.a == "unterminated)', /Littéral/);
  });
});

describe("neo4j parsers and Cypher guard", () => {
  it("builds the probe from dbms.components / SHOW DATABASES / JMX", async () => {
    const { fromComponents, neoValue } = await import("@/lib/drivers/neo4j");
    const p = fromComponents([{ name: "Neo4j Kernel", versions: ["5.26.0"], edition: "community" }], [{ name: "neo4j", currentStatus: "online", role: "primary" }, { name: "system", currentStatus: "online" }], 61_500, 3, 400);
    expect(p).toEqual({ version: "5.26.0 community", uptimeSec: 62, connUsed: 3, connMax: 400, role: "1 base" });
    expect(fromComponents([], [{ name: "a", currentStatus: "offline" }, { name: "b", currentStatus: "online", role: "secondary" }], undefined, undefined, undefined).role).toBe("2 bases · 1 hors ligne · undefined/secondary");
    expect(neoValue(null)).toBeNull();
    expect(neoValue([1, "a"])).toEqual([1, "a"]);
    expect(neoValue({ a: 1 })).toBe('{"a":1}');
  });
  it("Cypher guard: read clauses only, writers and admin/apoc procedures refused, LIMIT capped", async () => {
    const { guardCypher } = await import("@/lib/drivers/neo4j");
    const ok = (s: string) => {
      const r = guardCypher(s);
      expect(r.ok, s).toBe(true);
      return r.ok ? r.cypher : "";
    };
    const ko = (s: string, re: RegExp) => {
      const r = guardCypher(s);
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(re);
    };
    expect(ok("MATCH (n) RETURN n")).toBe("MATCH (n) RETURN n\nLIMIT 200");
    expect(ok("MATCH (n) RETURN n LIMIT 10")).toBe("MATCH (n) RETURN n LIMIT 10");
    expect(ok("MATCH (n) RETURN n LIMIT 5000;")).toBe("MATCH (n) RETURN n LIMIT 5000".replace("5000", "200"));
    expect(ok("MATCH (n) WITH n LIMIT 5 RETURN n")).toBe("MATCH (n) WITH n LIMIT 5 RETURN n\nLIMIT 200");
    expect(ok("MATCH (n) RETURN n ORDER BY n.name LIMIT 300 // c")).toBe("MATCH (n) RETURN n ORDER BY n.name LIMIT 200 // c");
    ok("CALL db.labels() YIELD label RETURN label");
    ok("CALL db.labels()");
    ok("CALL dbms.components() YIELD name, versions RETURN *");
    ok("UNWIND [1,2] AS x RETURN x");
    ok("MATCH (n {name: 'CREATE'}) RETURN n");
    ok("MATCH (n:`SET`) RETURN n");
    ko("", /vide/);
    ko("CREATE (n:X) RETURN n", /CREATE/);
    ko("MATCH (n) SET n.a = 1 RETURN n", /SET/);
    ko("MATCH (n) DETACH DELETE n", /DETACH|DELETE/);
    ko("MERGE (n:X {a: 1}) RETURN n", /MERGE/);
    ko("MATCH (n) REMOVE n.a RETURN n", /REMOVE/);
    ko("LOAD CSV FROM 'file:///x.csv' AS row RETURN row", /LOAD CSV/);
    ko("CALL dbms.killConnections(['x'])", /Procédure interdite/);
    ko("CALL dbms.security.listUsers()", /Procédure interdite/);
    ko("CALL apoc.load.json('http://x') YIELD value RETURN value", /interdite|apoc/);
    ko("CALL apoc.cypher.runWrite('CREATE ()', {}) YIELD value RETURN value", /interdite|apoc/);
    ko("MATCH (n) RETURN n; MATCH (m) RETURN m", /Une seule/);
    ko("MATCH (n) WHERE n.a = 'x RETURN n", /Littéral/);
    ko("SHOW TRANSACTIONS", /SHOW/);
    ko("DROP INDEX x", /DROP/);
    ko("CREATE DATABASE foo", /CREATE/);
    ko("TERMINATE TRANSACTIONS 'x'", /TERMINATE/);
    ko("MATCH (n) CALL { WITH n SET n.x = 1 } IN TRANSACTIONS RETURN count(*)", /SET|IN TRANSACTIONS/);
  });
});

describe("etcd parsers", () => {
  it("builds the probe from status, members and alarms", async () => {
    const { fromStatus, topPrefix, nextPrefix, quotaOf, DEFAULT_QUOTA_BYTES } = await import("@/lib/drivers/etcd");
    const status = { header: { member_id: "1", revision: "9" }, version: "3.5.17", dbSize: "20480", dbSizeInUse: "16384", leader: "1", raftTerm: "2" };
    const p = fromStatus(status, [{ ID: "1", name: "a" }, { ID: "2", name: "b" }], [], 42, 64 * 1024 * 1024);
    expect(p).toEqual({ version: "3.5.17", sizeBytes: 20480n, memMax: 67108864n, connUsed: 42, role: "leader · 2 membres · leader a" });
    expect(fromStatus({ ...status, leader: "2", errors: ["x"] }, [{ ID: "1", name: "a" }, { ID: "2", name: "b" }], [{ alarm: "NOSPACE" }], 0).role).toBe("follower · 2 membres · leader b · 1 alarme · 1 erreur(s)");
    expect(topPrefix("/registry/pods/x")).toBe("/registry");
    expect(topPrefix("foo/a")).toBe("foo");
    expect(topPrefix("bar")).toBe("bar");
    expect(nextPrefix("foo")).toBe("fop");
    expect(nextPrefix("/registry")).toBe("/registrz");
    expect(quotaOf({ type: "etcd", host: "h", port: 1, tls: false, database: "123" })).toBe(123);
    expect(quotaOf({ type: "etcd", host: "h", port: 1, tls: false, database: "" })).toBe(DEFAULT_QUOTA_BYTES);
  });
});

describe("rabbitmq parsers", () => {
  it("builds the probe from /api/overview and /api/nodes", async () => {
    const { fromOverview } = await import("@/lib/drivers/rabbitmq");
    const p = fromOverview(
      { rabbitmq_version: "3.13.7", erlang_version: "26.2.5.16", object_totals: { connections: 2, channels: 3, queues: 4, consumers: 1, exchanges: 7 }, queue_totals: { messages: 10 } },
      [{ name: "rabbit@a", uptime: 62_575, mem_used: 100, mem_limit: 1000, mem_alarm: false, disk_free: 5, disk_free_limit: 1, disk_free_alarm: false, sockets_total: 966, running: true }],
    );
    expect(p).toEqual({ version: "3.13.7 · erlang 26.2.5.16", uptimeSec: 63, connUsed: 2, connMax: 966, sizeBytes: 100n, memMax: 1000n, role: "1 nœud · 4 files · 1 consommateur" });
    const alarms = fromOverview({ rabbitmq_version: "3.13.7", object_totals: {} }, [{ name: "rabbit@a", mem_alarm: true, disk_free_alarm: true, running: true }, { name: "rabbit@b", running: false }]);
    expect(alarms.role).toBe("2 nœuds · 0 file · 0 consommateur · alarme mémoire rabbit@a, disque rabbit@a, rabbit@b arrêté");
    expect(alarms.memMax).toBeUndefined();
  });
});

describe("s3 helpers", () => {
  it("builds a path-style client with the instance credentials", async () => {
    const { clientOf, OBJECT_CAP } = await import("@/lib/drivers/s3");
    const client = clientOf({ type: "s3", host: "minio.storage.svc.cluster.local", port: 9000, username: "k", password: "s", database: "", tls: false });
    expect(await client.config.region()).toBe("us-east-1");
    expect(client.config.forcePathStyle).toBe(true);
    expect((await client.config.credentials()).accessKeyId).toBe("k");
    expect(OBJECT_CAP).toBe(5000);
    client.destroy();
  });
});
