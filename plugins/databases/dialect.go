package main

import (
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// dialect is everything that differs between the SQL databases: placeholder
// and quoting rules, upsert syntax, RETURNING support, the catalogue queries
// behind the pickers, and how to open a connection pool from a credential.
// The operations in sqlnode.go are written once against it.
type dialect struct {
	// system is db.system: postgresql | mysql | sqlite.
	system string
	// credential is the credential type's local name.
	credential string
	// hasSchemas shows the schema picker (Postgres).
	hasSchemas bool
	// returning: INSERT/UPDATE … RETURNING * is available.
	returning bool
	// dollarParams: placeholders are $1, $2… instead of ?.
	dollarParams bool
	// identQuote is the identifier quote character (" or `).
	identQuote string
	// doubleQuotedStrings: "…" is a string literal, not an identifier (MySQL).
	doubleQuotedStrings bool

	// open builds a connection pool from the credential; settings returns the
	// values that identify that pool (hashed into the cache key), and server
	// the address/port/database put on spans.
	open     func(creds landflow.CredentialData) (*sql.DB, error)
	settings func(creds landflow.CredentialData) []string
	server   func(creds landflow.CredentialData) serverInfo

	// Catalogue queries. Each takes the bound arguments listed.
	schemasQuery string // no arguments
	tablesQuery  string // (schema) when hasSchemas, else none; columns: name, kind
	columnsQuery string // (schema, table) when hasSchemas, else (table); columns: name, type
}

// serverInfo is what DB spans report about the server.
type serverInfo struct {
	address   string
	port      int
	namespace string
}

// placeholder returns the n-th (1-based) bind placeholder.
func (d *dialect) placeholder(n int) string {
	if d.dollarParams {
		return "$" + strconv.Itoa(n)
	}
	return "?"
}

// quote quotes an identifier, doubling any quote character inside it, so
// even a hostile name cannot break out of the identifier.
func (d *dialect) quote(ident string) string {
	q := d.identQuote
	return q + strings.ReplaceAll(ident, q, q+q) + q
}

// table returns the quoted, optionally schema-qualified table name.
func (d *dialect) table(schema, table string) string {
	if d.hasSchemas && schema != "" {
		return d.quote(schema) + "." + d.quote(table)
	}
	return d.quote(table)
}

// upsertClause is the conflict clause appended to an INSERT: ON CONFLICT …
// DO UPDATE for Postgres and SQLite, ON DUPLICATE KEY UPDATE for MySQL
// (which matches on any unique key, so match only drops those columns from
// the update list).
func (d *dialect) upsertClause(match, update []string) string {
	if d.system == systemMySQL {
		if len(update) == 0 {
			update = match[:1] // a no-op assignment keeps the statement valid
		}
		sets := make([]string, len(update))
		for i, c := range update {
			sets[i] = d.quote(c) + " = VALUES(" + d.quote(c) + ")"
		}
		return " ON DUPLICATE KEY UPDATE " + strings.Join(sets, ", ")
	}
	quoted := make([]string, len(match))
	for i, c := range match {
		quoted[i] = d.quote(c)
	}
	if len(update) == 0 {
		// DO UPDATE rather than DO NOTHING so RETURNING still yields every row.
		update = match[:1]
	}
	sets := make([]string, len(update))
	for i, c := range update {
		sets[i] = d.quote(c) + " = EXCLUDED." + d.quote(c)
	}
	return " ON CONFLICT (" + strings.Join(quoted, ", ") + ") DO UPDATE SET " + strings.Join(sets, ", ")
}

// bind converts a JSON value from an item or a parameter into a driver
// argument. Values are always bound, never spliced into SQL.
//
//   - Postgres: every scalar is sent as text (pgx sends strings in text
//     format), so the server parses it into whatever type the column or
//     placeholder has: "42" works for an int, a numeric, a text or a jsonb.
//   - MySQL and SQLite: whole numbers become int64, other scalars pass through.
//   - Objects and arrays become JSON text everywhere.
func (d *dialect) bind(v any) any {
	switch t := v.(type) {
	case nil:
		return nil
	case map[string]any, []any:
		data, _ := json.Marshal(t)
		return string(data)
	case float64:
		if d.dollarParams {
			return strconv.FormatFloat(t, 'f', -1, 64)
		}
		if t == float64(int64(t)) && t >= -1<<53 && t <= 1<<53 {
			return int64(t)
		}
		return t
	case bool:
		if d.dollarParams {
			return strconv.FormatBool(t)
		}
		return t
	case string:
		return t
	case []byte:
		return t // a file's bytes (bytea / BLOB columns)
	case json.Number:
		if d.dollarParams {
			return t.String()
		}
		if i, err := t.Int64(); err == nil {
			return i
		}
		f, _ := t.Float64()
		return f
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32:
		if d.dollarParams {
			return landflow.Stringify(t)
		}
		return t
	}
	data, err := json.Marshal(v)
	if err != nil {
		return landflow.Stringify(v)
	}
	return string(data)
}

const (
	systemPostgres = "postgresql"
	systemMySQL    = "mysql"
	systemSQLite   = "sqlite"
	systemRedis    = "redis"
)
