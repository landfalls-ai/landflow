# Databases plugin (`databases`)

Postgres, MySQL, SQLite and Redis for Landflow, plus "New Row" poll triggers for Postgres and SQLite, written with the Go
SDK. Nodes follow n8n's names and parameter shapes.

```sh
go run .                                  # HTTP :7107, gRPC :7207, announces to LANDFLOW_REGISTRY_URL (default http://127.0.0.1:3000)
LANDFLOW_REGISTRY_URL=off go run .        # standalone, no announcing
go vet ./... && go test ./...             # no database servers or containers needed
```

`LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` override the ports. Drivers: `jackc/pgx/v5` (through `database/sql`),
`go-sql-driver/mysql`, `modernc.org/sqlite` (pure Go, no cgo) and `redis/go-redis/v9`.

## Nodes

All action nodes are in **Data & Storage** and **Development**, set `usableAsTool: true`, read parameters per item and pair
every output item with its input. Failures carry the database's own message (and Postgres' detail and hint), with credential
values masked; the host's **On Error: Continue** setting then keeps the flow going.

| Node (type) | Operations | Notes |
|---|---|---|
| **Postgres** (`databases.postgres`) | Execute Query, Select, Insert, Insert or Update, Update, Delete | Schema, table and column pickers via `information_schema`; `RETURNING *` for writes |
| **MySQL** (`databases.mySql`) | same | No schema picker (the database is the schema). No `RETURNING`: Insert returns the written values, Update and Delete return `{ success, affectedRows }` |
| **SQLite** (`databases.sqlite`) | same | Table and column pickers via `sqlite_master` / `pragma_table_info`; `RETURNING *` |
| **Postgres Trigger** (`databases.postgresTrigger`) | Event: New Row | Poll trigger, see below |
| **SQLite Trigger** (`databases.sqliteTrigger`) | Event: New Row | Poll trigger, see below |
| **Redis** (`databases.redis`) | Delete, Get, Increment, Info, Keys, List Length, Pop, Push, Publish, Set | See below |

### SQL operations

- **Execute Query**: your SQL with `$1, $2…` (Postgres) or `?` (MySQL, SQLite) placeholders. *Options → Query Parameters*
  takes a comma-separated list (double quotes for values with commas), a JSON array or an expression returning an array.
  *Query Batching*: **Single Query** (once, with the first item's parameters), **Independently** (once per item) or
  **Transaction** (once per item, all in one transaction; any failure rolls back every item). Statements that return rows
  (`SELECT`, `WITH`, `SHOW`, `PRAGMA`, `EXPLAIN`, `VALUES`, `… RETURNING`) output the rows; others output
  `{ success, affectedRows }`.
- **Select**: *Select Rows* conditions (`=`, `!=`, `>`, `<`, `>=`, `<=`, `LIKE`, `IS NULL`, `IS NOT NULL`) combined with AND or
  OR, Return All or Limit (default 50), Sort, and *Options → Output Columns*.
- **Insert** / **Insert or Update**: *Map Each Column Automatically* uses item fields that match a column (others are ignored);
  *Map Each Column Below* takes column/value pairs. Rows with the same columns go into multi-row `INSERT`s (up to 500 rows,
  and at most ~30,000 parameters per statement); several statements run in one transaction. *Insert or Update* takes the
  columns to match on: `ON CONFLICT (…) DO UPDATE` on Postgres and SQLite (those columns need a unique constraint),
  `ON DUPLICATE KEY UPDATE` on MySQL (which matches **any** unique key or the primary key, not just the listed columns).
- **Update**: *Column to Match On* plus the new values; returns the updated rows, or `{ success, affectedRows }` on MySQL or
  with *Return Rows* off.
- **Delete**: *Select Rows* conditions. With no conditions the node refuses to run unless **Delete All Rows** is on.

Column fields inside *Select Rows*, *Sort* and *Columns to Match On* are text fields, not pickers: the editor sends only the
collection entry (not the node's table) when loading options inside a fixed collection, and does not load multi-select options.
The names are still checked against the table's real columns (see below).

### Poll triggers ("New Row")

Both triggers watch one table for rows whose **Tracking Column** (an id, serial or `created_at` that only grows) is greater
than any value seen. Poll state is `{ lastValue }`, stored as text.

- **First poll** (or state without `lastValue`): `SELECT CAST(MAX(col) AS TEXT)` becomes the baseline; nothing is emitted, so
  activating a workflow does not replay the table.
- **Later polls**: `SELECT * … WHERE col > $1 ORDER BY col ASC LIMIT n` (*Max Rows per Poll*, default 100, max 10,000); the
  last row's value becomes the new `lastValue`. Rows inserted while the workflow was off are picked up, up to the limit per poll.
- **Execute in the editor** (manual): the latest 5 rows, oldest first; state is unchanged.
- The column must strictly increase. Rows that share the last value but commit after a poll are missed, and so are rows
  inserted with a lower value (e.g. a sequence value allocated earlier by a transaction that commits later). A timestamp column
  with coarse precision makes ties more likely; a serial or identity id is the safest choice.

n8n's Postgres Trigger uses `LISTEN/NOTIFY` and installs a trigger function in the database. Polling was chosen instead: it
needs only `SELECT` on the table, no functions, triggers or extra privileges, works the same on SQLite, and catches rows
added while Landflow was down. The node shows a notice saying so.

### Redis

| Operation | Behaviour |
|---|---|
| **Get** | Reads a key into *Property Name* (dot notation unless turned off). *Key Type* Automatic uses `TYPE`; string, hash, list and set are read with `GET` / `HGETALL` / `LRANGE` / `SMEMBERS`. A missing key gives `null` |
| **Set** | *Key Type* Automatic stores an object as a hash, an array as a list and anything else as a string; hash, list and set writes run in `MULTI/EXEC` (a list is replaced, a set added to). Optional *Expire* with TTL |
| **Delete**, **Increment** | `DEL`; `INCR` with optional expiry, output `{ <key>: <new value> }` |
| **Keys** | `SCAN` with `MATCH` (never `KEYS`, which blocks the server), Return All or Limit, sorted; with *Get Values* each key's value, otherwise `{ keys: [...] }` |
| **Info** | `INFO` parsed into an object (numbers as numbers, `db0` as `{ keys, expires, avg_ttl }`) |
| **List Length**, **Push**, **Pop** | `LLEN`; `LPUSH` / `RPUSH` and `LPOP` / `RPOP` (*Tail* switch, as in n8n); popped JSON is parsed |
| **Publish** | `PUBLISH` to a channel |

## Credentials

| Type | Fields | Test |
|---|---|---|
| `databases.postgres` | host, port (5432), database, user, password, SSL (disable / allow / require / verify-full), connect timeout | connect + `SELECT 1` |
| `databases.mySql` | host, port (3306), database, user, password, SSL (off / on / skip-verify), connect timeout | connect + `SELECT 1` |
| `databases.sqlite` | database file path, read only | open the file + `SELECT 1` |
| `databases.redis` | host, port (6379), user (ACL), password, database number, TLS | `PING` |

Passwords are `password` fields: masked in the UI and redacted from logs, spans and error messages. Each test uses a throwaway
connection with a timeout and returns the server's reason on failure (`password authentication failed for user …`,
`connection refused`, `SQLite database file … does not exist`). Connection settings are built as driver config structs, never
as a DSN string that contains the password, so nothing that might be logged carries it.

**SQLite file access.** The SQLite credential opens **any file the plugin process can read** (and write, unless *Read Only*
is on). Whoever can create a credential can therefore read and change any SQLite file the plugin's OS user can reach. Run the
plugin as a user that can only see the intended files. The path must be an existing file (directories and missing files are
rejected, so a typo does not create an empty database). Read-only credentials open the file with `mode=ro` and
`PRAGMA query_only`.

## Safety

- **Values are always bound parameters**, never put into SQL text: conditions, inserted and updated values, match values,
  poll cursors and limits. Postgres receives scalars as text and lets the server convert them to the column type; MySQL and
  SQLite receive whole numbers as integers. Objects and arrays are sent as JSON text.
- **Identifiers are validated, then quoted.** Schema, table and column names must exist (looked up in the catalogue, exact
  match first, then a unique case-insensitive one) and are quoted with the dialect's quote character (`"` or `` ` ``,
  doubled when it appears in the name). A name that does not exist is an error, not SQL.
- Execute Query is the one place where SQL is free-form, as in n8n. Use its parameters for values.
- Delete without conditions needs the explicit *Delete All Rows* switch.

## Types

| Database value | Item value |
|---|---|
| integers within ±2^53 | number |
| larger integers (`BIGINT`, `INT8`) | string, so no precision is lost |
| `NUMERIC` / `DECIMAL` | string (exact) |
| floats | number (`NaN` / `Infinity` as strings) |
| timestamps, dates | RFC 3339 string (`TIMESTAMP` without zone as UTC) |
| `JSON` / `JSONB` | parsed object or array |
| `BYTEA`, `BLOB`, binary | base64 string |
| booleans | boolean |
| everything else | string |

## Connection pools

One pool per credential, keyed by a SHA-256 hash of the connection settings (an edited credential gets a fresh pool). Pools
are shared across executions, closed after 10 minutes unused (checked every minute) and on shutdown. Postgres and MySQL
pools hold up to 10 connections; SQLite uses one connection per file with a 5 s busy timeout and foreign keys on.

## Observability

Every statement and Redis command runs in a client span from the SDK's `DBSpan`: name `{operation} {table}` (`SELECT
customers`, `HSET customer`), attributes `db.system`, `db.operation.name`, `db.collection.name`, `db.namespace`,
`db.query.text`, `server.address`, `server.port`, `db.response.returned_rows` and `landflow.db.affected_rows`.
`db.query.text` never contains values: generated SQL only has placeholders, Execute Query text has its literals replaced by
`?` and comments dropped, and Redis commands are recorded as `GET ?`, `MULTI; HSET ? ?…; EXPIRE ? ?; EXEC`. For Redis the
"collection" is the key prefix before the first `:`. Multi-statement work (batched inserts, Transaction batching) is wrapped
in a `db.transaction` span with `landflow.statements` and `landflow.db.rolled_back`. Credential tests get a span too.

Metrics (low-cardinality attributes only: no table names, keys or ids):

| Metric | Type | Attributes |
|---|---|---|
| `landflow.db.query.duration` (ms) | histogram | `db.system`, `operation` |
| `landflow.db.rows` | counter | `db.system`, `operation`, `direction` (`read` / `written`); Redis counts values: fields or elements read, keys written |
| `landflow.db.errors` | counter | `db.system`, `operation` |
| `landflow.db.pool.connections` | gauge | `db.system`, `state` (`in_use` / `idle`) |
| `landflow.db.poll.new_rows` | counter | `db.system` |

`operation` is the statement verb from a fixed list (`SELECT`, `INSERT`, …, `OTHER`) or the Redis command name. The SDK adds
`landflow.plugin_id`, `landflow.node_type` and `landflow.workflow_id`.

## Tests

43 tests, all without a database server:

- **SQLite** end to end on temporary files: every operation, identifier injection attempts, the delete guard, read-only
  credentials, pickers, and the trigger (baseline, new rows, timestamps, empty tables, manual runs).
- **Postgres** and **MySQL**: the exact SQL and bound arguments for every operation and picker with `go-sqlmock`, type
  conversion, and that the password never appears in a DSN or error.
- **MySQL** end to end against `dolthub/go-mysql-server` in process (real wire protocol and driver): pickers, conversions,
  insert, upsert, update, delete, server errors and the credential test.
- **Redis**: every operation and the credential test (including ACL users) against `alicebob/miniredis`.
- Manifest, pool cache (sharing, eviction, shutdown) and telemetry (spans and metrics through the SDK's test exporters).

The Postgres and Postgres Trigger nodes have not been run against a real PostgreSQL server in this repository's tests.
