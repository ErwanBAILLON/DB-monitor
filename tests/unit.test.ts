import { describe, expect, it } from "vitest";
import { decrypt, encrypt, generatePassword } from "@/lib/crypto";
import { guardReadOnly } from "@/lib/sqlguard";
import { DEFAULT_THRESHOLDS, evaluate, thresholdsOf } from "@/lib/alerts";
import { parseInfo } from "@/lib/drivers/redis";
import { assertIdent } from "@/lib/drivers/postgres";
import { parseSeed } from "@/lib/seed";
import { bytes, duration } from "@/lib/format";
import { LoginGuard, MAX_FAILURES, LOCK_MS, MAX_LOCK_MS, clientIp } from "@/lib/login-guard";
import { assertAllowedTarget, isAllowedTarget, parseTargets } from "@/lib/targets";

const KEY = "ab".repeat(32);

describe("crypto", () => {
  it("round-trips and randomises the IV", () => {
    const a = encrypt("s3cret", KEY);
    const b = encrypt("s3cret", KEY);
    expect(a).not.toEqual(b);
    expect(decrypt(a, KEY)).toBe("s3cret");
    expect(decrypt(b, KEY)).toBe("s3cret");
  });
  it("handles the empty password", () => expect(decrypt(encrypt("", KEY), KEY)).toBe(""));
  it("refuses a wrong key and a tampered blob", () => {
    const blob = encrypt("x", KEY);
    expect(() => decrypt(blob, "cd".repeat(32))).toThrow();
    const [v, iv, enc, tag] = blob.split(".");
    expect(() => decrypt(`${v}.${iv}.${enc}.${tag.slice(0, -2)}AA`, KEY)).toThrow();
  });
  it("refuses a malformed key", () => expect(() => encrypt("x", "short")).toThrow(/32 bytes/));
  it("generates 24-char URL-safe passwords", () => expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]{24}$/));
});

describe("read-only SQL guard", () => {
  const ok = (s: string) => expect(guardReadOnly(s).ok, s).toBe(true);
  const ko = (s: string, re?: RegExp) => {
    const r = guardReadOnly(s);
    expect(r.ok, s).toBe(false);
    if (re && !r.ok) expect(r.reason).toMatch(re);
  };
  it("allows SELECT / WITH / EXPLAIN / SHOW / VALUES", () => {
    ok("SELECT 1");
    ok("select * from pg_stat_activity where state = 'active';");
    ok("WITH x AS (SELECT 1) SELECT * FROM x");
    ok("EXPLAIN SELECT * FROM t");
    ok("EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM t");
    ok("SHOW max_connections");
    ok("VALUES (1), (2)");
    ok("  (SELECT 1) UNION (SELECT 2)");
    ok("SELECT CASE WHEN a > 1 THEN 'yes' ELSE 'no' END FROM t");
    ok("SELECT n_tup_upd, n_tup_del, last_autovacuum FROM pg_stat_user_tables");
    ok("SELECT 'DROP TABLE x; DELETE FROM y' AS text -- insert into");
    ok('SELECT "update" FROM "delete"');
  });
  it("rejects DML and DDL", () => {
    ko("INSERT INTO t VALUES (1)");
    ko("UPDATE t SET a = 1");
    ko("DELETE FROM t");
    ko("DROP TABLE t");
    ko("TRUNCATE t");
    ko("COPY t TO '/tmp/x'");
    ko("CALL proc()");
    ko("CREATE TABLE x (a int)");
    ko("ALTER ROLE x SUPERUSER");
    ko("GRANT ALL ON t TO x");
    ko("VACUUM");
  });
  it("rejects writes smuggled into read statements", () => {
    ko("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", /DELETE/);
    ko("EXPLAIN ANALYZE DELETE FROM t", /DELETE/);
    ko("EXPLAIN ANALYZE INSERT INTO t SELECT 1", /INSERT/);
    ko("SELECT * INTO new_t FROM t", /INTO/);
    ko("SELECT * FROM t FOR UPDATE", /UPDATE/);
    ko("SELECT * FROM t FOR SHARE", /Verrous/);
    ko("EXPLAIN ANALYZE VERBOSE CALL p()", /CALL/);
    ko("SELECT pg_terminate_backend(123)", /pg_terminate_backend/);
    ko("SELECT pg_sleep(10)", /pg_sleep/);
    ko("SELECT setval('s', 1)", /setval/);
    ko("SELECT set_config('x', 'y', false)", /set_config/);
    ko("SELECT pg_read_file('/etc/passwd')", /pg_read_file/);
  });
  it("rejects side-effect functions hidden in quoted identifiers (review finding)", () => {
    ko('select "pg_terminate_backend"(123)', /guillemets/);
    ko('select pg_catalog."pg_terminate_backend"(123)', /guillemets/);
    ko('select "pg_sleep"(10)', /guillemets/);
    ko('select "set_config"(\'role\', \'postgres\', false)', /guillemets/);
    ko('select * from "pg_read_file"(\'/etc/passwd\')', /guillemets/);
    ko('select "pg_catalog"."pg_terminate_backend" (1)', /guillemets/);
    ko('SELECT U&"pg_terminate_backend"(1)', /U&/);
    ko('SELECT U&"\\0070g_sleep"(1)', /U&/);
    ko('SELECT "pg_sleep" FROM t', /Identifiant interdit/);
    // Legit quoted identifiers that are not function calls stay allowed.
    ok('SELECT "update" FROM "delete"');
    ok('SELECT "weird name", "pid" FROM "my table" WHERE "x" = 1');
  });
  it("rejects more side-effect functions in clear", () => {
    ko("select pg_notify('x','y')", /pg_notify/);
    ko("select pg_stat_reset()", /pg_stat_reset/);
    ko("select pg_stat_reset_shared('bgwriter')", /pg_stat_reset_shared/);
    ko("select pg_log_backend_memory_contents(1)", /pg_log_backend_memory_contents/);
    ko("select pg_catalog . pg_terminate_backend (1)", /pg_terminate_backend/);
    ko("select lo_get(1)", /lo_get/);
    ok("select pg_stat_get_activity(null) is null");
  });
  it("rejects multiple statements, empty input and unterminated literals", () => {
    ko("SELECT 1; DELETE FROM t", /seule instruction/);
    ko("SELECT 1; SELECT 2", /seule instruction/);
    ko("", /vide/);
    ko("   ;  ", /vide/);
    ko("SELECT 'abc", /terminé/);
    ko("BEGIN", /SELECT/);
    ko("SET statement_timeout = 0", /SELECT/);
    ko("DO $$ BEGIN DELETE FROM t; END $$", /SELECT/);
  });
});

describe("thresholds", () => {
  it("falls back to defaults on bad input", () => {
    expect(thresholdsOf(null)).toEqual(DEFAULT_THRESHOLDS);
    expect(thresholdsOf({ connectionsPct: 500, downChecks: "x" })).toEqual(DEFAULT_THRESHOLDS);
    expect(thresholdsOf({ connectionsPct: 50 }).connectionsPct).toBe(50);
  });
  it("fires down only after N consecutive failures", () => {
    const t = thresholdsOf(null);
    expect(evaluate({ up: false, latencyMs: 0, error: "refused" }, 1, t)).toEqual([]);
    expect(evaluate({ up: false, latencyMs: 0, error: "refused" }, 2, t).map((a) => a.kind)).toEqual(["down"]);
  });
  it("fires connections above the percentage, not at it", () => {
    const t = thresholdsOf(null);
    expect(evaluate({ up: true, latencyMs: 1, connUsed: 80, connMax: 100 }, 0, t)).toEqual([]);
    expect(evaluate({ up: true, latencyMs: 1, connUsed: 81, connMax: 100 }, 0, t).map((a) => a.kind)).toEqual(["connections"]);
  });
  it("fires memory for redis maxmemory and ignores unlimited", () => {
    const t = thresholdsOf(null);
    expect(evaluate({ up: true, latencyMs: 1, sizeBytes: 90n, memMax: 100n }, 0, t).map((a) => a.kind)).toEqual(["memory"]);
    expect(evaluate({ up: true, latencyMs: 1, sizeBytes: 90n, memMax: 0n }, 0, t)).toEqual([]);
    expect(evaluate({ up: true, latencyMs: 1, sizeBytes: 90n }, 0, t)).toEqual([]);
  });
});

describe("redis INFO parser", () => {
  it("splits sections and key/values", () => {
    const i = parseInfo("# Server\r\nredis_version:7.2.4\r\nuptime_in_seconds:42\r\n\r\n# Keyspace\r\ndb0:keys=3,expires=1,avg_ttl=0\r\n");
    expect(i.server.redis_version).toBe("7.2.4");
    expect(i.keyspace.db0).toBe("keys=3,expires=1,avg_ttl=0");
  });
});

describe("identifiers and seed", () => {
  it("accepts snake_case and refuses injection", () => {
    expect(assertIdent("my_app1", "x")).toBe("my_app1");
    expect(() => assertIdent('a"; DROP DATABASE x; --', "x")).toThrow();
    expect(() => assertIdent("Upper", "x")).toThrow();
    expect(() => assertIdent("1abc", "x")).toThrow();
  });
  it("parses the seed array", () => {
    expect(parseSeed(undefined)).toEqual([]);
    expect(parseSeed('[{"name":"a","type":"redis","host":"h","port":6379}]')[0].name).toBe("a");
    expect(() => parseSeed("{}")).toThrow();
  });
});

describe("format", () => {
  it("formats bytes and durations in French units", () => {
    expect(bytes(0)).toBe("0 o");
    expect(bytes(1536)).toBe("1.5 Kio");
    expect(bytes(5n * 1024n * 1024n * 1024n)).toBe("5.0 Gio");
    expect(duration(59)).toBe("59 s");
    expect(duration(3 * 86400 + 3600)).toBe("3 j 1 h");
  });
});

describe("login guard", () => {
  it("locks after MAX_FAILURES, doubles the lock, resets on success", () => {
    let t = 1_000_000;
    const g = new LoginGuard(() => t);
    for (let i = 1; i < MAX_FAILURES; i++) expect(g.fail("ip")).toBe(0);
    expect(g.lockedFor("ip")).toBe(0);
    expect(g.fail("ip")).toBe(LOCK_MS);
    expect(g.lockedFor("ip")).toBe(LOCK_MS);
    expect(g.lockedFor("other")).toBe(0);
    t += LOCK_MS + 1;
    expect(g.lockedFor("ip")).toBe(0);
    for (let i = 1; i < MAX_FAILURES; i++) g.fail("ip");
    expect(g.fail("ip")).toBe(LOCK_MS * 2);
    g.succeed("ip");
    expect(g.lockedFor("ip")).toBe(0);
  });
  it("caps the lock duration", () => {
    let t = 0;
    const g = new LoginGuard(() => t);
    let applied = 0;
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < MAX_FAILURES; i++) applied = g.fail("ip") || applied;
      t += applied + 1;
    }
    expect(applied).toBe(MAX_LOCK_MS);
  });
  it("takes the first X-Forwarded-For hop", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "192.168.1.42, 10.0.0.1" }))).toBe("192.168.1.42");
    expect(clientIp(new Headers({ "x-real-ip": "192.168.1.7" }))).toBe("192.168.1.7");
    expect(clientIp(new Headers({ "x-forwarded-for": "<script>" }))).toBe("unknown");
    expect(clientIp(undefined)).toBe("unknown");
  });
});

describe("egress allowlist (DBMON_ALLOWED_TARGETS)", () => {
  const spec = ".database.svc.cluster.local:5432,.projects.svc.cluster.local:5432/6379,db.lan,*:9999";
  const t = parseTargets(spec);
  it("parses entries with and without ports", () => {
    expect(t).toHaveLength(4);
    expect(t[1].ports).toEqual([5432, 6379]);
    expect(t[2].ports).toEqual([]);
  });
  it("matches suffix + port, exact host, wildcard", () => {
    expect(isAllowedTarget("shared-postgres-rw.database.svc.cluster.local", 5432, t)).toBe(true);
    expect(isAllowedTarget("shared-postgres-rw.database.svc.cluster.local", 6379, t)).toBe(false);
    expect(isAllowedTarget("sorago-redis.projects.svc.cluster.local", 6379, t)).toBe(true);
    expect(isAllowedTarget("gitea-http.git.svc.cluster.local", 3000, t)).toBe(false);
    expect(isAllowedTarget("192.168.1.1", 80, t)).toBe(false);
    expect(isAllowedTarget("database.svc.cluster.local", 5432, t)).toBe(false);
    expect(isAllowedTarget("DB.LAN", 3306, t)).toBe(true);
    expect(isAllowedTarget("anything", 9999, t)).toBe(true);
  });
  it("allows everything when unset and throws otherwise", () => {
    expect(isAllowedTarget("192.168.1.1", 80, [])).toBe(true);
    expect(() => assertAllowedTarget("192.168.1.1", 80, spec)).toThrow(/hors de la liste/);
    expect(() => assertAllowedTarget("x.database.svc.cluster.local", 5432, spec)).not.toThrow();
  });
});
