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

## Cassandra / ScyllaDB (`cassandra`, CQL native protocol, default port 9042)

| Need | Permission |
|---|---|
| Probe (`system.local`, `system.peers`, `system.size_estimates`, Scylla `system.versions` / `system.runtime_info`) | any authenticated role (system keyspaces are readable by every role) |
| Clients tab | `system.clients` (Scylla) or `system_views.clients` (Cassandra 4+); absent on Cassandra 3 (tab says so) |
| Compaction / streams tab | `system_views.sstable_tasks`, `system_views.streaming` (Cassandra 4+), else `system.compaction_history` |
| Read-only console | `SELECT` on the keyspace; the role must not be a superuser for the console to be harmless |

Without `authenticator: PasswordAuthenticator` leave user/password empty.
Version: Scylla answers `release_version = 3.0.8` (Cassandra compatibility) in
`system.local`, the real version comes from `system.versions`; the probe shows
`scylla 6.1.5-…` or `cassandra 4.1.x`. Uptime: exact on Scylla
(`runtime_info` generic/uptime), approximated on Cassandra as
`now - gossip_generation` (the epoch second of the last start). Sizes are the
node's `system.size_estimates` (refreshed periodically, often 0 for tiny
tables): an estimate, not `nodetool tablestats`. Connections: no `max`
exposed through CQL.

Console: single `SELECT`, `INSERT/UPDATE/DELETE/TRUNCATE/DROP/ALTER/CREATE/
BATCH/GRANT/REVOKE/USE/LIST/DESCRIBE` refused anywhere, quoted-identifier
function calls refused, `LIMIT` forced to <= 200 (appended when missing, kept
before `ALLOW FILTERING`), `system_auth` (salted hashes) excluded, consistency
`LOCAL_ONE`, driver `readTimeout` 5 s, `prepare: false`. There is no
server-side read-only mode in CQL: the barrier is the guard plus the role's
grants. No action (no `nodetool`, no `TRUNCATE`) is offered.

The driver opens a short-lived `cassandra-driver` client per call (control
connection + one connection) with `RoundRobinPolicy` so no `localDataCenter`
is needed. TLS: `sslOptions` without CA verification, like the other engines.

## InfluxDB 2.x (`influxdb`, HTTP API, default port 8086)

The instance's **password field holds the API token** (user name ignored) and
the **database field holds the organisation name** used by the console and
the cardinality queries.

| Need | Token permission |
|---|---|
| Probe (`/health`, `/ready`, `GET /api/v2/orgs`, `GET /api/v2/buckets`) | `read:orgs`, `read:buckets` (`/health` and `/ready` need no token) |
| Buckets tab cardinality (`influxdb.cardinality(bucket, start: -30d)` through `/api/v2/query`) | `read:buckets` on each bucket (a read-only "all buckets" token is enough) |
| Tasks tab (`GET /api/v2/tasks`, `GET /api/v2/tasks/{id}/runs?limit=1`) | `read:tasks` |
| Flux console | `read:buckets` on the queried buckets |

Create a read-only token in the UI (Load Data > API Tokens > Custom: Read on
buckets, orgs, tasks) rather than registering the operator token: Flux has no
server-side read-only mode, the token's scopes are the real barrier.

Console guard (`guardFlux`): `range()` required unless the query is a schema
helper (`buckets()`, `schema.*`, `influxdb.cardinality`, `v1.*`); refused
anywhere: `to()`, `wideTo()`, `experimental`, `http`, `sql`, `secrets`,
`contrib`, `influxdb.api`, `monitor.notify/check`, every notification package
(`slack`, `pagerduty`, `discord`, `smtp`, `kafka`, `mqtt`...), `exec`;
`import "..."` only from an allowlist of pure packages (`strings`, `regexp`,
`math`, `date`, `json`, `array`, `dict`, `types`, `influxdata/influxdb`,
`/schema`, `/v1`, `join`, `table`, `interpolate`, `timezone`, `runtime`,
`sampledata`, `generate`, `profiler`). `|> limit(n: 200)` is appended, the
HTTP request is cut after 5 s (the server cancels on disconnect), results are
annotated CSV parsed into rows (several tables are concatenated with their
`table` index). Not covered: `/api/v2/delete`, `/api/v2/write` (never called).

## Neo4j 5 (`neo4j`, Bolt, default port 7687)

| Need | Privilege / role |
|---|---|
| Probe (`dbms.components`, `SHOW DATABASES`, `dbms.queryJmx` for JVM uptime, `dbms.listConnections`, `SHOW SETTINGS`) | any user for components/JMX; `SHOW DATABASES` lists what the user may see; `dbms.listConnections` and `SHOW SETTINGS` need `admin` on Community (there is no finer RBAC without Enterprise) |
| Transactions tab (`SHOW TRANSACTIONS`) | own transactions for any user; all of them with `admin` (Enterprise: `SHOW TRANSACTION` privilege) |
| Graph, index and constraint tabs (`MATCH ... count`, `db.labels`, `SHOW INDEXES`, `SHOW CONSTRAINTS`) | `reader` role on the database |
| TERMINATE TRANSACTIONS | own transactions for any user, others with `admin` (Enterprise: `TERMINATE TRANSACTION` privilege) |
| Cypher console | `reader`; executed in a session with **access mode READ**, which the server enforces (`Neo.ClientError.Statement.AccessMode` on any write, verified in the integration test by bypassing the guard) |

Store sizes: the `neo4j.metrics:name=neo4j.<db>.store.size.total` JMX bean is
Enterprise-only; on Community the column reads `n/d` and the fleet size cell
stays empty. The TERMINATE action runs on the `system` database in a WRITE
session (administration command), which is why the registered user needs
`admin` to terminate other users' transactions on Community.

Console guard (`guardCypher`): single statement starting with MATCH /
OPTIONAL MATCH / WITH / UNWIND / RETURN / CALL / PROFILE / EXPLAIN; refused
anywhere: CREATE, MERGE, DELETE, DETACH, SET, REMOVE, DROP, FOREACH, LOAD
CSV, ALTER, GRANT/DENY/REVOKE, START/STOP DATABASE, TERMINATE, `CALL { } IN
TRANSACTIONS`; `CALL` only for `db.labels|relationshipTypes|propertyKeys|
schema.*|info|ping|stats.retrieve|index.fulltext.query*|index.vector.query*`,
`dbms.components|listConfig|queryJmx|showCurrentUser|info|listConnections`,
`tx.getMetaData`; `apoc.*` refused; SHOW/USE refused (tabs cover them); the
`system` database is never targeted. `LIMIT 200` appended after the final
RETURN or an existing LIMIT capped; transaction timeout 5 s set at
`beginTransaction` (server-side, `TransactionTimedOut`). Node and relationship
values are rendered as `(:Label {props})` / `[:TYPE {props}]`.

TLS: `bolt+ssc` (self-signed accepted) when the TLS flag is set.

## etcd v3 (`etcd`, gRPC-gateway HTTP `/v3/*`, default port 2379, read-only)

| Need | Permission (etcd RBAC, when `--auth-token` is enabled) |
|---|---|
| Probe (`/v3/maintenance/status`, `/v3/cluster/member/list`, `/v3/maintenance/alarm` GET) | any authenticated user (status, member list and alarm GET are not permission-gated) |
| Key counts (`/v3/kv/range` with `count_only` / `keys_only`) | role with **read** on the key range (`etcdctl role grant-permission <role> read "" "\0"` for the whole keyspace, or narrower prefixes) |

Without authentication leave user/password empty. With it, the driver calls
`/v3/auth/authenticate` and sends the token in `Authorization` (the gateway
does not take basic auth). The instance's "database" field holds the
configured `--quota-backend-bytes` (bytes) so that the dbSize gauge and the
fleet "% of quota" are right; empty = etcd's default 2 GiB.

What is read: status (version, dbSize, dbSizeInUse, leader, raft term/index,
errors), members (id, name, learner, peer/client URLs), alarms (NOSPACE,
CORRUPT), the total key count, and the key **names** (never the values:
`keys_only: true`) paginated 1000 at a time and capped at 5000 keys to
discover the top-level prefixes, then one exact `count_only` range per prefix.
No write endpoint is ever called (`put`, `deleterange`, `compaction`, `defragment`,
`alarm DISARM`, `member/*` mutations are absent from the driver; the integration
test seeds its keys through the gateway directly).

### The Kubernetes etcd is deliberately not registered

The cluster's own etcd (`kube-system`, 127.0.0.1:2379 on the control-plane
node) only accepts client certificates (`/etc/kubernetes/pki/etcd/ca.crt`,
`healthcheck-client.crt/.key`) and is in a critical namespace. The driver has
no client-certificate option on purpose. To add it read-only one day:

1. Issue a dedicated client certificate from the etcd CA (`kubeadm certs` or
   `openssl` against `/etc/kubernetes/pki/etcd/ca.crt|key`) with CN `dbmon`,
   mount it in the pod through a Secret, and extend `Conn` with
   `clientCert/clientKey/ca` passed to `httpRequest` (`https.request` options
   `cert`, `key`, `ca`).
2. Enable etcd RBAC (`etcdctl auth enable`) and grant `dbmon` a role with
   **read** on `/registry` only (count-only is still a read).
3. Expose 2379 to the pod: a headless Service/Endpoints to the node IP in
   `kube-system` plus an egress entry in `networkPolicy.egress`; note that
   `/registry` holds Secrets, so even `keys_only` leaks Secret **names**: keep
   the scan to `count_only` for that instance.

Until then the probe and tabs are validated on a standalone etcd only.

## RabbitMQ (`rabbitmq`, management HTTP API, default port 15672, category broker)

| Need | User tag |
|---|---|
| Everything the driver reads (`/api/overview`, `/api/nodes`, `/api/queues`, `/api/connections`, `/api/channels`, `/api/vhosts`, `/api/exchanges`) | `monitoring` (sees all vhosts, read-only) ; `management` only shows the vhosts the user has permissions on |

```
rabbitmqctl add_user dbmon '<password>'
rabbitmqctl set_user_tags dbmon monitoring
```

The driver only issues GETs: no purge, delete, publish or policy change exists
in the code (the integration test seeds its queue through the API directly).
The fleet card shows memory used vs the node's `mem_limit`
(`vm_memory_high_watermark`), so the "memory > 85 %" alert applies to brokers
too; `connMax` is the node's `sockets_total`. The "database" field may hold a
URL prefix (reverse proxy). Queues are the first 200 sorted by `messages`.

## MinIO / S3-compatible (`s3`, S3 API, default port 9000, category object store)

Access key in the user field, secret key in the password field, optional
region in the database field (`us-east-1` default; MinIO ignores it). Path-style
addressing (`forcePathStyle`), one attempt, 5 s timeouts (20 s for the
buckets tab).

| Need | IAM action |
|---|---|
| Probe (`ListBuckets`) | `s3:ListAllMyBuckets` |
| Buckets tab (`ListObjectsV2`, `GetBucketLocation`, `GetBucketVersioning`) | `s3:ListBucket`, `s3:GetBucketLocation`, `s3:GetBucketVersioning` on `arn:aws:s3:::*` |

The homelab MinIO is registered with a dedicated user carrying exactly that
policy (`dbmon-readonly-list`, created with `mc admin policy create` +
`mc admin user add` + `mc admin policy attach` from the MinIO pod); the
integration test verifies that a `PutObject` with that key is refused
(`Access Denied`). No `GetObject`: object contents are never readable from the
console, only names are listed while counting. Counting stops after 5000
objects per bucket (`>=` prefix), so a huge bucket is a lower bound: use the
MinIO console or `mc du` for exact figures.

Version: S3 has no version call; the `Server` response header of an
unauthenticated `GET /` (`MinIO`, `AmazonS3`...) is shown instead.
