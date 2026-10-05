# Engines: permissions, what is read, what can be changed

One driver per engine in `src/lib/drivers/<engine>.ts`; each exposes `probe`
(stored as a `Check` row every 30 s), `detail` (the instance tabs) and the
actions listed below. Every action asks for confirmation and is written to the
audit log; generated passwords are shown once and never logged.

Validation status: see the support matrix in `README.md` (image tag tested,
test counts). Integration tests live in `tests/integration/<engine>.test.ts`
and are skipped unless the `TEST_<ENGINE>_URL` variable points to a live server.

## PostgreSQL (`postgres`)

See README "Roles and permissions": role `dbmon` in `pg_monitor`,
`pg_read_all_data`, `pg_signal_backend`, with `CREATEDB CREATEROLE` for the
create actions. A `postgres` instance whose `version()` says CockroachDB is
probed with the CockroachDB driver automatically.

## CockroachDB (`cockroach`, Postgres wire, default port 26257)

| Need | Grant |
|---|---|
| Probe, sessions, nodes, settings | a SQL user with `VIEWACTIVITY` (or `admin`); `crdb_internal.cluster_sessions`, `gossip_nodes`, `kv_node_status`, `ranges` |
| Database / table sizes | `SHOW RANGES ... WITH DETAILS` needs `ZONECONFIG` or `admin`; sizes degrade to unknown otherwise |
| Cancel session | `CANCELQUERY` (or `admin`) |
| Create database / role | `CREATEDB` / `CREATEROLE` |
| Read-only console | `SELECT` on the target tables; same guard as Postgres + `BEGIN READ ONLY` |

Not available: pg_locks, pg_settings, extensions, `pg_dump` (upstream removed
`cockroach dump`: use `BACKUP`). An `--insecure` node refuses passwords, hence
the "role without password" option.

## MySQL / MariaDB (`mysql`)

| Need | Grant |
|---|---|
| Probe, databases, variables, status | `PROCESS`, `SHOW DATABASES`, `SELECT` on `information_schema` |
| Processlist of other users, KILL | `PROCESS` + `CONNECTION_ADMIN` (MySQL 8) or `SUPER` (MariaDB) |
| Accounts tab | `SELECT` on `mysql.user` (degrades to empty) |
| Replication tab | `REPLICATION CLIENT` / `BINLOG MONITOR` |
| Create database (+ user) | `CREATE`, `CREATE USER`, `GRANT OPTION` on `*.*` |
| Dump | `SELECT`, `SHOW VIEW`, `TRIGGER`, `EVENT` on the database (binary `mariadb-dump` in the image, works on MySQL 8 too) |
| Read-only console | `SELECT`; the session runs `SET SESSION TRANSACTION READ ONLY` + `START TRANSACTION READ ONLY`, with `max_execution_time` (MySQL, ms) or `max_statement_time` (MariaDB, s) = 5 s |

Both `caching_sha2_password` (MySQL 8 default) and `mysql_native_password`
(MariaDB default) authenticate through `mysql2`. The `DEFAULT_PORT` is 3306.

## Redis-compatible (`redis`: Redis, Valkey, KeyDB, Dragonfly)

No ACL needed for `PING`, `INFO`, `SCAN`, `TYPE`, `PTTL`, `DEL`; `CONFIG GET
maxclients`, `CLIENT LIST`, `SLOWLOG GET` optional (the UI degrades). The
flavour is read from `INFO server` (`valkey_version`, `dragonfly_version`,
`keydb_version`, else `redis_version`) and shown in the version cell
(`valkey 8.0.1`). `FLUSHDB`/`FLUSHALL` are never offered.

## MongoDB (`mongodb`)

| Need | Role |
|---|---|
| Probe (`serverStatus`, `listDatabases`), currentOp, replSetGetStatus | `clusterMonitor` |
| Collections tab (`$collStats`, indexes) | `readAnyDatabase` (or `read` on the inspected database) |
| killOp | `hostManager` (or `root`) |
| Create database + user (`createUser` readWrite on that db) | `userAdminAnyDatabase` + `readWriteAnyDatabase` (or `root`) |
| Read-only console | `read` on the database; executed with `readPreference: secondaryPreferred`, `maxTimeMS: 5000`, `limit <= 200`; `$where`, `$function`, `$accumulator`, `$out`, `$merge` and system collections are refused before reaching the server, including `system.*` targets of `$unionWith` / `$lookup` / `$graphLookup` (`admin.system.users` holds the SCRAM credentials) |

The "database" field of the instance is the `authSource` (usually `admin`).
Dropping anything is out of scope.

## ClickHouse (`clickhouse`, HTTP interface, default port 8123)

| Need | Grant |
|---|---|
| Probe, metrics, parts, processes, merges, replicas | `SELECT` on `system.*` (the `default` user has it) |
| KILL QUERY | `KILL QUERY` privilege |
| Read-only console | `SELECT`; every console request carries `readonly=1` and `max_execution_time=5` as URL settings, so writes and `SET` are refused by the server itself even if the syntactic guard were bypassed |

TLS: set the TLS flag with port 8443; the certificate is not verified (same as the other engines).

## OpenSearch / Elasticsearch (`opensearch`, default port 9200)

| Need | Permission |
|---|---|
| Probe (`/`, `_cluster/health`, `_nodes/stats`) | `cluster:monitor/*` (role `readall_and_monitor` in OpenSearch) |
| Indices (`_cat/indices`), tasks, pending tasks | `indices:monitor/*`, `cluster:monitor/tasks` |
| Search console | `indices:data/read/search` on the index; `size <= 100`, `timeout=5s`, bodies containing `script` are refused; system (`.`-prefixed) indices cannot be targeted |

Basic auth from the instance's username/password; without the security plugin,
leave them empty. The "database" field may hold a URL prefix (reverse proxy).
No delete, no settings change. Hot threads are not rendered (plain-text endpoint
`_nodes/hot_threads`, called by hand).

## Microsoft SQL Server (`mssql`, default port 1433)

| Need | Permission |
|---|---|
| Probe, sessions, requests, waits, config | `VIEW SERVER STATE` |
| Databases and file sizes | `VIEW ANY DEFINITION` (sys.master_files) |
| Logins tab | `VIEW ANY DEFINITION` |
| KILL session | `ALTER ANY CONNECTION` (sessions > 50 only) |
| Create database (+ login db_owner) | `CREATE ANY DATABASE`, `ALTER ANY LOGIN` |
| Read-only console | `SELECT` on the target; `EXEC` accepted only as the whole request on `sp_help*`, `sp_who[2]`, `sp_spaceused`, `sp_columns`, `sp_tables`, `sp_databases`, `sp_configure` (read form, no value), `sp_lock`, `sp_monitor`, `sp_readerrorlog`, with literal/numeric/`@param =` arguments only |

**Limitation, stated plainly:** SQL Server has no `READ ONLY` transaction mode.
The console relies on the syntactic guard (`guardTsql` in `drivers/mssql.ts`)
plus the rights of the registered login. Because T-SQL needs no `;` between
statements, the guard refuses any statement starter anywhere in the text
(`EXEC`, `KILL`, `SHUTDOWN`, `RECONFIGURE`, `WAITFOR`, `DBCC`, `BACKUP`/`RESTORE`,
`USE`, `DECLARE`, `SET`, `BEGIN`/`COMMIT`, `OPENROWSET`, `BULK`, `xp_*`, `sp_*`...),
not only the DML/DDL keywords. With `sa` the guard is the only barrier. For a
safe console, register the instance with a dedicated login:

```sql
CREATE LOGIN dbmon WITH PASSWORD = '...';
GRANT VIEW SERVER STATE, VIEW ANY DEFINITION, ALTER ANY CONNECTION TO dbmon;
-- per database to browse:
USE <db>; CREATE USER dbmon FOR LOGIN dbmon; ALTER ROLE db_datareader ADD MEMBER dbmon;
```

and keep "create database" for an instance registered with a stronger login.
Requests are bound by `requestTimeout` 5 s and `SET LOCK_TIMEOUT 5000`.

## SQLite (`sqlite`, files mounted in the pod)

No server. The instance's "database" field is the file path; it must sit under
one of `DBMON_SQLITE_ROOTS` (rendered by the chart from `sqlite.mounts` plus the
sample directory). Files are opened with `SQLITE_OPEN_READONLY`
(`node-sqlite3-wasm`, no native build), so there is no write path at all:
`PRAGMA x = y` is refused by the guard and a write through the handle fails
with `attempt to write a readonly database`.

Probe = file size, `page_count * page_size`, `journal_mode` (shown as role),
`quick_check`. Tabs: file + pragmas (+ full `integrity_check` on demand), tables
with row counts and columns, indexes, read-only console (`SELECT`, `WITH`,
`EXPLAIN`, read `PRAGMA`).

Mounting real files: add a `sqlite.mounts` entry (PVC or hostPath) in the chart;
the volume is mounted `readOnly: true`. The chart's `sqlite.sample: true`
creates `/data/sqlite/sample.db` in an emptyDir at pod start
(`scripts/sqlite-sample.cjs`) so the engine has a live testbed; it disappears
with the pod.
