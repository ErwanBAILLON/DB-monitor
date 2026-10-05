# Explorer: what is inside an instance

The "Explorer" and "Statistiques" tabs of an instance show its contents:
containers (databases, schemas, keyspaces, buckets, vhosts...), the objects
inside them (tables, views, collections, queues, prefixes...), their structure,
a paginated read-only view of their rows, a column profile and engine-specific
deep statistics. Both tabs appear only for engines registered in
`src/lib/explore/index.ts`.

Everything is read-only, goes through the engine's existing read-only path
(READ ONLY transaction, access mode READ, read-only token, 5 s timeout) and
is written to the audit log with the object and the *shape* of the request
(columns, operators, sort, page), never the values typed in filters nor the
data returned.

## Contract (`src/lib/explore/types.ts`)

One module per engine, `src/lib/explore/<engine>.ts`, exporting
`explorer: Explorer`:

```ts
type Explorer = {
  listContainers(conn: Conn): Promise<ExploreContainer[]>;
  listObjects(conn: Conn, container: string): Promise<ExploreObject[]>;
  describeObject(conn: Conn, container: string, object: string): Promise<ExploreDescription>;
  browseRows(conn: Conn, container: string, object: string, req: BrowseRequest): Promise<BrowseResult>;
  columnProfile(conn: Conn, container: string, object: string, column: string): Promise<ColumnProfile>;
  stats(conn: Conn, container?: string): Promise<ExploreStats>;
  caveats?: string[]; // French one-liners shown under the tree
};
```

| Type | Fields |
|---|---|
| `ExploreContainer` | `name`, `kind?`, `sizeBytes?`, `objectCount?`, `extra?` (free key/values) |
| `ExploreObject` | `name` (identifier sent back to describe/browse, unique in the container), `kind`, `estRows?`, `sizeBytes?`, `lastModified?` (ISO), `extra?` |
| `ExploreDescription` | `object`, `columns[]` (name, type, nullable, default, pk, extra), `indexes[]` (name, columns, unique, primary, sizeBytes, definition, extra), `constraints[]` (kind pk/fk/unique/check/exclusion/other, columns, refObject, refColumns, definition), `partitioning?`, `storage?` (free key/values), `sample?` (one row), `notes?` |
| `BrowseRequest` | `page` (1-based), `pageSize` (1..100), `sortColumn?`, `sortDir?`, `filters[]` of `{column, op, value?}` with `op` in `= != < <= > >= like "is null" "is not null"` |
| `BrowseResult` | `columns`, `rows` (plain: bigint/Date/objects as strings, cells truncated at 4 KiB), `page`, `pageSize`, `total` (null = unknown), `totalIsEstimate`, `durationMs`, `notes?` |
| `ColumnProfile` | `{unsupported: true, reason?}` or `column`, `sampleSize`, `nullPct`, `distinct` (+ `distinctIsEstimate`), `min`, `max`, `top[]` of `{value, count}`, `notes?` |
| `ExploreStats` | `container`, `sections[]` of `{key, title, description?, columns?, rows, unsupported?, note?}`, `durationMs` |

Rules every implementation follows:

- **Identifiers** (container, object, column, sort column) are validated with
  `assertExploreIdent` (`[A-Za-z_][A-Za-z0-9_$]{0,127}`), checked against the
  real column list of the object, then quoted in the engine's style. Anything
  else (`id; DROP`, `1=1`, names with dots, quotes or spaces) is refused
  before any query is built.
- **Values** are always bound parameters (`$1`, `?`, `:1`, `@p1`) or JSON
  operands, never interpolated. The shared composer lives in
  `src/lib/explore/sql.ts` (`composeBrowse`).
- **Pagination** is clamped server-side (`normalizeBrowseRequest`: page >= 1,
  pageSize 1..100, at most 10 filters, values <= 4096 chars).
- **Totals** are exact when cheap, otherwise an estimate flagged
  `totalIsEstimate` with a note.
- **Profiles** read at most 10 000 rows; engines where this is impossible
  return `{unsupported: true}`.
- **Cells** are truncated at 4 KiB on the server.

## HTTP API (`src/lib/explore/api.ts`)

`/api/instances/:id/explore/<op>` behind the same session guard as the
console (middleware + re-check in the handler):

| op | method | params |
|---|---|---|
| `containers` | GET | – |
| `objects` | GET | `container` |
| `describe` | GET | `container`, `object` |
| `browse` | POST | JSON `{container, object, page, pageSize, sortColumn, sortDir, filters}` |
| `profile` | GET | `container`, `object`, `column` |
| `stats` | GET | `container` (optional) |

Audit actions: `explore.describe`, `explore.browse`, `explore.profile`,
`explore.stats` (listing calls are not audited: catalog reads only).

## Adding an engine

1. `src/lib/explore/<engine>.ts` exporting `explorer: Explorer`. Reuse the
   driver's read-only executor (`readOnlyExec` in `drivers/postgres.ts` and
   `drivers/mysql.ts` are the models: one connection, read-only mode, timeout,
   rollback, several parametrised statements).
2. `src/lib/explore/index.ts`: add `reg("<engine>", () => import("./<engine>"));`
   (keep both lines on a merge conflict).
3. Unit tests of query composition in `tests/explore.test.ts`; live test
   `tests/integration/<engine>.explore.test.ts` skipped without
   `TEST_<ENGINE>_URL`, covering list, describe, browse with filter + sort,
   profile, stats, and the injection refusals.
4. A section below and the "Explorer" cell of the README support matrix.

## Per engine

### PostgreSQL (`postgres`)

- Containers: databases (`pg_database`, non-template) with size, owner, encoding.
  One connection per database (catalogs are per database).
- Objects: tables, partitioned tables, views, materialized views, foreign
  tables outside `pg_catalog`, `information_schema`, `pg_toast`; `reltuples`,
  `pg_total_relation_size`, last vacuum/analyze, dead rows.
- Structure: `pg_attribute` (type, nullable, default, PK, identity/generated,
  comment), indexes (`pg_index` + definition, size, method, scans, validity),
  constraints (`pg_constraint`, FK target table and columns), partitioning
  (`pg_partitioned_table` key and partition count, or the partition bound and
  parent), storage from `pg_stat_all_tables` (heap/index/toast sizes, live and
  dead rows, bloat %, last vacuum/analyze, seq/idx scans, ins/upd/del), one
  sample row.
- Données: `SELECT ... WHERE ... ORDER BY ... LIMIT $n OFFSET $m` inside
  `BEGIN READ ONLY` + `statement_timeout = 5000`. `LIKE` on non-text columns
  casts to text; other comparisons let the server type the parameter from the
  column. Total = `count(*)` under the same timeout; above 1 M estimated rows
  without filter it uses `reltuples`; if the count times out it asks the
  planner (`EXPLAIN (FORMAT JSON)`), both flagged as estimates.
- Profil: first 10 000 rows in physical order; `count(DISTINCT v::text)`,
  min/max native for ordered types, on the text form otherwise; top 10 by
  `GROUP BY v::text`.
- Statistiques (per database): `pg_stat_statements` top 20 by total time
  (unsupported when the extension is absent from that database), cache hit
  ratio (tables and indexes), vacuum/analyze candidates, unused indexes (0
  scans, not PK/unique), large tables read sequentially, biggest tables.
- Not shown: system schemas, TOAST internals, row-level security details.
  Needs `pg_read_all_data` on the browsed database (`pg_monitor` for stats).
- Tested against portable PG 16 with the fixture of
  `scripts/explore-seed-postgres.cjs` (`TEST_POSTGRES_URL`) and prod CNPG
  `shared-postgres`.

### MySQL / MariaDB (`mysql`)

- Containers: schemas except `information_schema`, `performance_schema`,
  `sys`; size (data + index) and table count from `information_schema.tables`.
- Objects: tables and views with engine, `table_rows` (InnoDB estimate), size,
  `data_free`, update/create time.
- Structure: `information_schema.columns` (column_type, nullable, default,
  PK, extra, collation, comment), indexes from `statistics` (grouped, with
  type, cardinality, prefix length), constraints from `table_constraints` +
  `key_column_usage` (+ `check_constraints` when the server has it),
  partitions, storage (engine, row format, data/index/free bytes,
  fragmentation %, avg row length, auto_increment, collation, timestamps),
  one sample row.
- Données: backtick-quoted identifiers, `?` parameters escaped by mysql2
  (text protocol), inside `SET SESSION TRANSACTION READ ONLY` +
  `max_execution_time` (MySQL) / `max_statement_time` (MariaDB) 5 s. Total =
  `count(*)`; on timeout `table_rows` is used without filter (flagged), null
  with filters.
- Profil: first 10 000 rows ordered by primary key (without it the optimizer
  may read a covering secondary index, which sorts the sample by that column).
- Statistiques (per schema): `performance_schema` digests top 20 (MariaDB
  ships it OFF: section empty or unsupported), InnoDB buffer pool (size, hit
  ratio, pages, wait_free, row lock waits), unused indexes
  (`table_io_waits_summary_by_index_usage`), tables without primary key,
  fragmented tables (> 10 % and > 10 MiB free), biggest tables.
- Not shown: identifiers outside `[A-Za-z0-9_$]` (refused, not quoted),
  `mysql.*` system tables are listed but need `SELECT` on them.
- Tested live against `dbmon-test-mariadb` (mariadb:11.4) by
  `tests/integration/mysql.explore.test.ts` (`TEST_MARIADB_URL` /
  `TEST_MYSQL_URL`).

### SQLite (`sqlite`)

- Containers: one per file, named `main` (file size, table + view count,
  journal mode, encoding, page size). Attached databases are not explored:
  the driver opens the file alone, read-only.
- Objects: tables, virtual tables and views of `sqlite_master` (`sqlite_%`
  internal tables hidden) with an exact `count(*)` (full scan: slow on very
  large files), `dbstat` size when the build includes
  `SQLITE_ENABLE_DBSTAT_VTAB` (null otherwise), `WITHOUT ROWID` / `STRICT`
  flags, virtual table module; last modified = file mtime.
- Structure: `PRAGMA table_xinfo` (declared type = affinity, nullable,
  default, PK, hidden/generated columns; `INTEGER PRIMARY KEY` shown as not
  nullable since it aliases the rowid), `index_list` + `index_xinfo`
  (columns, unique, origin CREATE INDEX / UNIQUE / PRIMARY KEY, partial,
  `sqlite_stat1` row when ANALYZE ran), constraints: PK, UNIQUE (from the
  implicit indexes), FK from `foreign_key_list` (grouped per id, with ON
  UPDATE / ON DELETE), CHECK clauses parsed from the `CREATE TABLE` text.
  Storage: rows, dbstat table/index bytes, without_rowid, strict, file size
  and mtime, whether ANALYZE ran; one sample row; the full definition in the
  notes.
- Données: `SELECT "cols" FROM "table" WHERE ... ORDER BY ... LIMIT ? OFFSET ?`
  bound through node-sqlite3-wasm on the handle opened
  `SQLITE_OPEN_READONLY` (library-enforced). Column affinity applies to the
  bound text value (`amount >= "100"` compares numerically on a REAL
  column). Total = exact `count(*)`. No server-side timeout exists: SQLite
  runs inside the pod, pages are capped at 100 rows.
- Profil: first 10 000 rows in storage order (rowid), `count(DISTINCT)`,
  min/max, top 10.
- Statistiques (file-wide, container ignored): file + pragmas (page_size,
  page_count, freelist and its %, journal_mode, auto_vacuum, encoding,
  user/schema version, cache/mmap, quick_check), tables (rows, columns,
  indexes, size, without_rowid, strict), indexes with `sqlite_stat1`,
  tables without a declared PK, `PRAGMA foreign_key_check` violations
  (first 50; SQLite does not enforce FKs unless `foreign_keys` is ON),
  version + selected compile options.
- Deliberately not shown: attached databases, `sqlite_%` internal tables,
  BLOB contents beyond the 4 KiB cell truncation. `dbstat` and
  `sqlite_stat1` sections degrade to null / empty rather than failing.
- Tested against: node-sqlite3-wasm (SQLite 3.x bundled) by
  `tests/integration/sqlite.explore.test.ts`, which builds its own temporary
  fixture (3 tables, 10 000 orders, a WITHOUT ROWID table, a view) and always
  runs; `TEST_SQLITE_URL=file:/path.db` adds a smoke run on an existing file.
  In prod the registered instance `sample-sqlite` (`/data/sqlite/sample.db`,
  written at pod start) is the one shown in the Explorer tab.

### Template for the other engines

```
### <Engine> (`<key>`)

- Containers: ...
- Objects: ... (kind, estimated count, size, last modified when available)
- Structure: ... (columns / fields / schema, indexes, constraints, sharding, storage, sample)
- Données: ... (read-only path used, pagination, how identifiers are quoted and values bound, total exact or estimated)
- Profil: ... or `{unsupported}` and why
- Statistiques: ... (sections)
- Deliberately not shown: ... and why (e.g. etcd values never read, S3 preview text only <= 4 KiB, RabbitMQ peek with ack_requeue_true)
- Tested against: <image:tag> by tests/integration/<engine>.explore.test.ts (TEST_<ENGINE>_URL)
```
