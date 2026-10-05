# DB Monitor

Fleet console for heterogeneous databases: one UI to see and operate every
database server of the homelab (PostgreSQL, Redis, MySQL/MariaDB).

Successor of the 2023 docker-compose prototype (CloudBeaver + one container per
engine): the goal is the same, "several kinds of databases, managed easily at
the same time", now as a Kubernetes-deployed Next.js app that connects to the
real instances over the network.

- Prod: https://dbmon.ebaillon.fr (LAN only, single admin login, 5 failed logins per client IP = 15 min lock, doubling)
- Image: `git.ebaillon.fr/infra/db-monitor`, chart in `helm/`, ArgoCD app `db-monitor` (ns `projects`)

## What it does

| Area | Details |
|---|---|
| Registry | Add / edit / delete instances (type, host, port, credentials, default db, TLS, environment, tags). Test connection before saving. |
| Fleet overview | One card per instance: up/down, latency sparkline, version, uptime, role (primary/replica), connections used/max, total size or Redis memory vs maxmemory, last check, 24 h availability. Auto-refresh every 30 s. |
| Checks | In-process checker every 30 s, history kept 7 days (`Check` table). |
| PostgreSQL detail | Databases with sizes, roles, `pg_stat_activity` with terminate action, long queries (> 5 s), waiting/exclusive locks, top tables by size with dead-tuple ratio, settings of interest, installed extensions. |
| Redis detail | INFO sections, keyspace per db, memory, clients (CLIENT LIST), SLOWLOG, key browser via SCAN (never KEYS) with TTL and delete. FLUSHDB/FLUSHALL are not offered. |
| MySQL detail | Databases/sizes, processlist with KILL, variables and status. Built from the docs, untested against a live server (no MySQL in the homelab yet). |
| Actions | Postgres: create database (+ owner role with a generated password shown once), create role, terminate backend, read-only query, `pg_dump` to a streamed `.sql.gz`. Redis: scan keys, delete a key. All actions ask for confirmation and are written to the audit log. Restore is out of scope. |
| Alerts | Per-instance thresholds: connections > 80 %, down after 2 consecutive checks, Redis memory > 85 % of maxmemory. Fire/resolve e-mails via SMTP, and `/api/alerts` (session required) lists active and recently resolved alerts. |
| Audit | `/app/audit`: who, when, instance, action, parameters, result. Passwords are never written there. |

## How instances are stored

`Instance` rows live in the app's own Postgres database (CNPG, db `db_monitor`).
The password is stored in `secret` as an AES-256-GCM blob
(`v1.<iv>.<ciphertext>.<tag>`, random 96-bit IV per write) keyed by
`DBMON_ENCRYPTION_KEY` (32 bytes hex) which only exists in Vault and reaches
the pod as an environment variable through ExternalSecrets. Rotating the key
requires re-entering the passwords (there is no re-encryption job).

On first deploy the fleet is seeded from `DBMON_SEED_JSON` (Vault), an array of
`{name, type, host, port, username, password, database, tls, environment, tags}`.
The seed is additive and keyed by name: instances already present are left
untouched, so UI edits survive restarts.

## Roles and permissions needed per engine

**PostgreSQL (CNPG shared-postgres)**, role `dbmon`:

```sql
CREATE ROLE dbmon LOGIN PASSWORD '...' IN ROLE pg_monitor, pg_read_all_data, pg_signal_backend;
ALTER ROLE dbmon CREATEDB CREATEROLE;
GRANT CONNECT ON DATABASE <each> TO dbmon;   -- repeated for new databases
```

| Capability | Needs |
|---|---|
| Probe, sessions, locks, settings, sizes | `pg_monitor` + CONNECT |
| Top tables of a database | CONNECT on that database |
| Read-only query | CONNECT + SELECT (via `pg_read_all_data`) |
| Terminate backend | `pg_signal_backend` (not superuser backends) |
| Create database / role | `CREATEDB` / `CREATEROLE` |
| pg_dump | `pg_read_all_data` on the target database |

A database created later needs `GRANT CONNECT ON DATABASE x TO dbmon` unless
the app created it (it revokes PUBLIC, and the creating role keeps CONNECT).

Blast radius: `dbmon` reads every table of every database it may connect to
(29 in the homelab) and can create databases/roles. The console is therefore
a full-read path to the cluster behind one admin password; mitigations are the
per-IP login lock, the per-IP Traefik rate limits (chart middlewares
`db-monitor-ratelimit` and `-ratelimit-login`), the 8 h session, the audit log
and the LAN-only exposure. To shrink it: `ALTER ROLE dbmon NOCREATEDB
NOCREATEROLE` (disables the create actions) and `REVOKE CONNECT ON DATABASE x
FROM dbmon` for databases that must stay out of the console.

**Redis**: no ACL needed for `PING`, `INFO`, `SCAN`, `TYPE`, `PTTL`, `DEL`;
`CONFIG GET maxclients`, `CLIENT LIST` and `SLOWLOG GET` are optional (the UI
degrades when they are renamed/disabled). Password per instance when
`requirepass` is set.

**MySQL/MariaDB**: `PROCESS`, `SHOW DATABASES`, `SELECT` on
`information_schema`; `CONNECTION_ADMIN`/`SUPER` for KILL on other users'
threads.

## Read-only query guard

`src/lib/sqlguard.ts` accepts a single `SELECT`/`WITH`/`EXPLAIN`/`SHOW`/`VALUES`
statement, rejects DML/DDL keywords anywhere (data-modifying CTEs, `EXPLAIN
ANALYZE DELETE`, `SELECT INTO`, `FOR UPDATE`), side-effect functions
(`pg_terminate_backend`, `pg_sleep`, `setval`, `pg_read_file`, `pg_notify`,
`pg_stat_reset*`, ...), multiple statements, and any function call through a
quoted identifier (`"pg_sleep"(1)`, `pg_catalog."pg_terminate_backend"(1)`) or
`U&"..."` identifier, since quoting would otherwise hide the name from the
denylist. It is a denylist: a side-effect function not listed and called
unquoted still passes, and `dbmon` keeps `pg_signal_backend` for the explicit
terminate action, so the guard is the only thing standing between the console
and `pg_terminate_backend`. The driver then runs the statement in `BEGIN READ ONLY` with
`statement_timeout = 5 s` and caps the result at 500 rows. Both layers are
tested (`tests/unit.test.ts`, `tests/integration/postgres.test.ts`).

## Configuration (Vault `secret/db-monitor/main`)

| Key | Required | Role |
|---|---|---|
| `DATABASE_URL` | yes | app state (Prisma) |
| `AUTH_SECRET` | yes | next-auth JWT |
| `DBMON_ENCRYPTION_KEY` | yes | 32 bytes hex, credentials at rest |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | yes | the only login |
| `DBMON_SEED_JSON` | no | first-deploy fleet |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`, `ALERT_EMAIL` | no | alert e-mails (without SMTP, alerts are UI + `/api/alerts` only) |
| `CHECKER_DISABLED` | no | `true` to stop the in-process checker |

Network: the cluster CNI is flannel, which does **not** enforce
NetworkPolicy, so the chart's policy (`helm/templates/networkpolicy.yaml`) is
declared intent only. The effective control is in the application: the chart
renders the same `networkPolicy.egress` list into `DBMON_ALLOWED_TARGETS`
(`.<ns>.svc.cluster.local:<ports>,...`, plus `networkPolicy.extraTargets`) and
`src/lib/targets.ts` refuses any instance whose host:port is outside it on
create, edit and test. Add a line to `networkPolicy.egress` to monitor a
database in another namespace. Unset variable = everything allowed (local dev).

## Development

```bash
pnpm install
# portable Postgres on 5490 (see .env), then:
pnpm exec prisma migrate dev
pnpm test                 # unit: crypto, SQL guard, thresholds, parsers
pnpm test:integration     # needs TEST_PG_URL or the local 5490 server
pnpm build && PORT=3140 pnpm start
PLAYWRIGHT=<path to playwright module> node scripts/e2e.cjs            # local full flow
BASE=https://dbmon.ebaillon.fr RESOLVE_IP=192.168.1.150 READONLY=1 INSTANCE=shared-postgres \
  ADMIN_PASSWORD=... node scripts/e2e.cjs                               # prod, read-only
```

Deploy: push to `main` -> Gitea Actions builds and pushes the image, bumps
`helm/values.yaml` (`[skip ci]`), ArgoCD syncs `db-monitor`.

## Limits

- Single pod, single admin, no RBAC: it is a homelab console on the LAN.
- The login lock is in-memory (lost on pod restart) and keyed by client IP
  (`X-Forwarded-For` first hop, set by Traefik in hostNetwork).
- NetworkPolicy is not enforced by flannel; see "Network" above.
- TLS to databases is accepted without CA verification (internal CNPG CA);
  pin the CA before using it outside the cluster.
- MySQL driver untested against a live server; MongoDB and SQLite not implemented.
- Restore, FLUSH, DROP DATABASE are deliberately absent.
- `pg_dump` runs with the app's role: tables it cannot read are skipped with an error in the audit row.
- Rotating `DBMON_ENCRYPTION_KEY` invalidates stored passwords.
