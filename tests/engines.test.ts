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
    expect(p).toEqual({ version: "opensearch 2.17.0", uptimeSec: 61, connUsed: 3, sizeBytes: 2048n, memMax: 1000n, role: "yellow · 1 nœud(s)" });
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
