package main

import (
	"context"
	"fmt"
	"strings"
	"testing"

	landflow "github.com/landflow/landflow/sdks/go"
)

// End-to-end behaviour of every SQL operation against a real SQLite file.

func where(conds ...[3]any) map[string]any {
	values := make([]any, len(conds))
	for i, c := range conds {
		values[i] = map[string]any{"column": c[0], "condition": c[1], "value": c[2]}
	}
	return map[string]any{"values": values}
}

func TestSQLiteSelect(t *testing.T) {
	creds, _ := newSQLite(t, usersSchema)

	// Where + sort + limit, and every type conversion.
	rows := ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "select", "table": "users",
		"where": where([3]any{"age", ">", "20"}),
		"sort":  map[string]any{"values": []any{map[string]any{"column": "age", "direction": "DESC"}}},
		"limit": 1.0,
	}})
	if len(rows) != 1 {
		t.Fatalf("rows = %+v", rows)
	}
	ada := rows[0].JSON
	if ada["name"] != "Ada" || num(ada["id"]) != 1 || num(ada["age"]) != 36 || ada["score"] != 9.5 {
		t.Errorf("ada = %+v", ada)
	}
	if ada["balance"] != "10.5" { // DECIMAL → string
		t.Errorf("balance = %#v", ada["balance"])
	}
	if ada["avatar"] != "AQIDBA==" { // BLOB → base64
		t.Errorf("avatar = %#v", ada["avatar"])
	}
	if ada["created_at"] != "2026-01-02T03:04:05Z" { // DATETIME → RFC 3339
		t.Errorf("created_at = %#v", ada["created_at"])
	}
	if m, _ := ada["meta"].(map[string]any); m["vip"] != true { // JSON → object
		t.Errorf("meta = %#v", ada["meta"])
	}
	if rows[0].PairedItem == nil || rows[0].PairedItem.Item != 0 {
		t.Errorf("pairedItem = %+v", rows[0].PairedItem)
	}

	// Return All, OR, IS NULL, LIKE, output columns, case-insensitive column names.
	rows = ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "select", "table": "users", "returnAll": true, "combineConditions": "OR",
		"where":   where([3]any{"AGE", "IS NULL", ""}, [3]any{"email", "LIKE", "bob@%"}),
		"sort":    map[string]any{"values": []any{map[string]any{"column": "id", "direction": "ASC"}}},
		"options": map[string]any{"outputColumns": "id, Name"},
	}})
	if len(rows) != 2 || rows[0].JSON["name"] != "Bob" || rows[1].JSON["name"] != "Cy" || len(rows[0].JSON) != 2 {
		t.Errorf("OR rows = %+v", rows)
	}

	// One select per input item, paired.
	rows = ok(t, call{node: "sqlite", creds: creds,
		items:      []map[string]any{{"e": "ada@example.com"}, {"e": "cy@example.com"}},
		params:     map[string]any{"operation": "select", "table": "users"},
		itemParams: []map[string]any{{"operation": "select", "table": "users", "where": where([3]any{"email", "equal", "ada@example.com"})}, {"operation": "select", "table": "users", "where": where([3]any{"email", "equal", "cy@example.com"})}},
	})
	if len(rows) != 2 || rows[1].JSON["name"] != "Cy" || rows[1].PairedItem.Item != 1 {
		t.Errorf("per item = %+v", rows)
	}

	// Views are selectable too.
	if rows := ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{"operation": "select", "table": "adults", "returnAll": true}}); len(rows) != 2 {
		t.Errorf("view rows = %+v", rows)
	}
}

func TestSQLiteExecuteQuery(t *testing.T) {
	creds, path := newSQLite(t, usersSchema)

	// Single query with bound parameters from a comma-separated list.
	rows := ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}, {}}, params: map[string]any{
		"operation": "executeQuery", "query": "SELECT name FROM users WHERE age > ? AND email LIKE ? ORDER BY id",
		"options": map[string]any{"queryReplacement": "20, %@example.com"},
	}})
	if len(rows) != 2 || rows[0].JSON["name"] != "Ada" || rows[1].JSON["name"] != "Bob" {
		t.Errorf("single = %+v", rows)
	}

	// Independently: once per item, parameters from an expression returning an array.
	rows = ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}, {}},
		params: map[string]any{"operation": "executeQuery", "query": "SELECT name FROM users WHERE id = ?", "options": map[string]any{"queryBatching": "independently"}},
		itemParams: []map[string]any{
			{"operation": "executeQuery", "query": "SELECT name FROM users WHERE id = ?", "options": map[string]any{"queryBatching": "independently", "queryReplacement": []any{1.0}}},
			{"operation": "executeQuery", "query": "SELECT name FROM users WHERE id = ?", "options": map[string]any{"queryBatching": "independently", "queryReplacement": []any{3.0}}},
		},
	})
	if len(rows) != 2 || rows[0].JSON["name"] != "Ada" || rows[1].JSON["name"] != "Cy" || rows[1].PairedItem.Item != 1 {
		t.Errorf("independently = %+v", rows)
	}

	// A statement without rows reports affectedRows.
	rows = ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "executeQuery", "query": "UPDATE users SET name = upper(name) WHERE age IS NOT NULL",
	}})
	if len(rows) != 1 || rows[0].JSON["success"] != true || num(rows[0].JSON["affectedRows"]) != 2 {
		t.Errorf("exec = %+v", rows)
	}
	// RETURNING makes a write return rows.
	rows = ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "executeQuery", "query": "UPDATE users SET name = 'Ada' WHERE id = ? RETURNING id, name",
		"options": map[string]any{"queryReplacement": "1"},
	}})
	if len(rows) != 1 || rows[0].JSON["name"] != "Ada" {
		t.Errorf("returning = %+v", rows)
	}

	// Transaction: the second item violates the unique email, so the first
	// insert is rolled back too.
	insert := "INSERT INTO users (email, name) VALUES (?, ?)"
	txParams := func(email string) map[string]any {
		return map[string]any{"operation": "executeQuery", "query": insert,
			"options": map[string]any{"queryBatching": "transaction", "queryReplacement": email + ", X"}}
	}
	e := fails(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}, {}}, params: txParams("new@example.com"),
		itemParams: []map[string]any{txParams("new@example.com"), txParams("ada@example.com")}})
	if e.ItemIndex == nil || *e.ItemIndex != 1 || !strings.Contains(e.Message, "UNIQUE") {
		t.Errorf("transaction error = %+v", e)
	}
	if got := sqliteQuery(t, path, "SELECT id FROM users WHERE email = 'new@example.com'"); len(got) != 0 {
		t.Errorf("rolled-back insert is visible: %+v", got)
	}
	// And a successful transaction commits every item.
	rows = ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}, {}}, params: txParams("t1@example.com"),
		itemParams: []map[string]any{txParams("t1@example.com"), txParams("t2@example.com")}})
	if len(rows) != 2 || len(sqliteQuery(t, path, "SELECT id FROM users WHERE email LIKE 't_@example.com'")) != 2 {
		t.Errorf("committed transaction = %+v", rows)
	}

	// Errors carry the database's message; an empty query is refused.
	if e := fails(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{"operation": "executeQuery", "query": "SELECT * FROM nope"}}); !strings.Contains(e.Message, "no such table") {
		t.Errorf("db error = %+v", e)
	}
	if e := fails(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{"operation": "executeQuery", "query": "  "}}); !strings.Contains(e.Message, "empty") {
		t.Errorf("empty query = %+v", e)
	}
}

func TestSQLiteInsert(t *testing.T) {
	creds, path := newSQLite(t, usersSchema)

	// Auto-map: fields that are not columns are ignored; RETURNING gives ids.
	rows := ok(t, call{node: "sqlite", creds: creds, params: map[string]any{"operation": "insert", "table": "users"},
		items: []map[string]any{
			{"email": "dee@example.com", "name": "Dee", "age": 41.0, "unrelated": "x"},
			{"email": "eve@example.com", "Name": "Eve", "meta": map[string]any{"tags": []any{"a"}}},
		}})
	if len(rows) != 2 || num(rows[0].JSON["id"]) != 4 || num(rows[1].JSON["id"]) != 5 || rows[1].JSON["name"] != "Eve" ||
		rows[0].PairedItem.Item != 0 || rows[1].PairedItem.Item != 1 {
		t.Fatalf("insert rows = %+v", rows)
	}
	if m, _ := rows[1].JSON["meta"].(map[string]any); m == nil || fmt.Sprint(m["tags"]) != "[a]" {
		t.Errorf("object stored as JSON text = %#v", rows[1].JSON["meta"])
	}
	if _, ok := rows[0].JSON["unrelated"]; ok {
		t.Error("non-column field must not be written")
	}

	// Manual mapping, and Return Rows off → the written values.
	rows = ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{"x": 1.0}}, params: map[string]any{
		"operation": "insert", "table": "users", "dataMode": "defineBelow",
		"valuesToSend": map[string]any{"values": []any{
			map[string]any{"column": "email", "value": "fay@example.com"},
			map[string]any{"column": "age", "value": "29"},
		}},
		"options": map[string]any{"returnRows": false},
	}})
	if len(rows) != 1 || rows[0].JSON["email"] != "fay@example.com" || rows[0].JSON["age"] != "29" {
		t.Errorf("manual insert output = %+v", rows)
	}
	if got := sqliteQuery(t, path, "SELECT age FROM users WHERE email = 'fay@example.com'"); len(got) != 1 || num(got[0]["age"]) != 29 {
		t.Errorf("stored age = %+v", got)
	}

	// Many rows: several multi-row statements in one transaction.
	var many []map[string]any
	for i := range 1100 {
		many = append(many, map[string]any{"email": fmt.Sprintf("bulk%d@example.com", i), "age": float64(i)})
	}
	rows = ok(t, call{node: "sqlite", creds: creds, params: map[string]any{"operation": "insert", "table": "users"}, items: many})
	if len(rows) != 1100 || rows[1099].PairedItem.Item != 1099 || rows[1099].JSON["email"] != "bulk1099@example.com" {
		t.Errorf("bulk insert: %d rows, last %+v", len(rows), rows[len(rows)-1])
	}
	// A failure in a later chunk rolls back the earlier ones.
	many = many[:0]
	for i := range 600 {
		many = append(many, map[string]any{"email": fmt.Sprintf("dup%d@example.com", i)})
	}
	many = append(many, map[string]any{"email": "ada@example.com"})
	fails(t, call{node: "sqlite", creds: creds, params: map[string]any{"operation": "insert", "table": "users"}, items: many})
	if got := sqliteQuery(t, path, "SELECT count(*) AS n FROM users WHERE email LIKE 'dup%'"); num(got[0]["n"]) != 0 {
		t.Errorf("partial bulk insert committed: %+v", got)
	}

	// Errors: no matching field, unknown manual column.
	if e := fails(t, call{node: "sqlite", creds: creds, params: map[string]any{"operation": "insert", "table": "users"}, items: []map[string]any{{"nothing": 1.0}}}); !strings.Contains(e.Message, "None of the fields") {
		t.Errorf("no match = %+v", e)
	}
	e := fails(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "insert", "table": "users", "dataMode": "defineBelow",
		"valuesToSend": map[string]any{"values": []any{map[string]any{"column": "nope", "value": "1"}}},
	}})
	if !strings.Contains(e.Message, `"nope" is not a column`) || !strings.Contains(e.Description, "email") {
		t.Errorf("unknown column = %+v", e)
	}
}

func TestSQLiteUpsert(t *testing.T) {
	creds, path := newSQLite(t, usersSchema)
	rows := ok(t, call{node: "sqlite", creds: creds, params: map[string]any{"operation": "upsert", "table": "users", "columnsToMatchOn": "email"},
		items: []map[string]any{{"email": "ada@example.com", "name": "Ada L."}, {"email": "gus@example.com", "name": "Gus"}}})
	if len(rows) != 2 || num(rows[0].JSON["id"]) != 1 || rows[0].JSON["name"] != "Ada L." || rows[0].JSON["age"] == nil || rows[1].JSON["name"] != "Gus" {
		t.Errorf("upsert rows = %+v", rows)
	}
	if got := sqliteQuery(t, path, "SELECT count(*) AS n FROM users"); num(got[0]["n"]) != 4 {
		t.Errorf("row count = %+v", got)
	}
	// Only match columns given: the row is left as is but still returned.
	rows = ok(t, call{node: "sqlite", creds: creds, params: map[string]any{"operation": "upsert", "table": "users", "columnsToMatchOn": "email"},
		items: []map[string]any{{"email": "bob@example.com"}}})
	if len(rows) != 1 || rows[0].JSON["name"] != "Bob" {
		t.Errorf("match-only upsert = %+v", rows)
	}
	// The match column must be present and real.
	if e := fails(t, call{node: "sqlite", creds: creds, params: map[string]any{"operation": "upsert", "table": "users", "columnsToMatchOn": "email"},
		items: []map[string]any{{"name": "no email"}}}); !strings.Contains(e.Message, "no value for match column") {
		t.Errorf("missing match value = %+v", e)
	}
	if e := fails(t, call{node: "sqlite", creds: creds, params: map[string]any{"operation": "upsert", "table": "users", "columnsToMatchOn": "mail"},
		items: []map[string]any{{"email": "x@example.com"}}}); !strings.Contains(e.Message, "not a column") {
		t.Errorf("bad match column = %+v", e)
	}
}

func TestSQLiteUpdate(t *testing.T) {
	creds, path := newSQLite(t, usersSchema)
	// Auto-map: match on id from the item, set the other mapped columns.
	rows := ok(t, call{node: "sqlite", creds: creds, params: map[string]any{"operation": "update", "table": "users", "columnToMatchOn": "id"},
		items: []map[string]any{{"id": 2.0, "age": 26.0, "extra": true}, {"id": 99.0, "age": 1.0}}})
	if len(rows) != 1 || num(rows[0].JSON["age"]) != 26 || rows[0].JSON["name"] != "Bob" || rows[0].PairedItem.Item != 0 {
		t.Errorf("update rows = %+v", rows)
	}
	// Manual: match value from "Value of Column to Match On"; Return Rows off.
	rows = ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "update", "table": "users", "columnToMatchOn": "email", "dataMode": "defineBelow",
		"valueToMatchOn": "cy@example.com",
		"valuesToSend":   map[string]any{"values": []any{map[string]any{"column": "name", "value": "Cyrus"}}},
		"options":        map[string]any{"returnRows": false},
	}})
	if len(rows) != 1 || rows[0].JSON["success"] != true || num(rows[0].JSON["affectedRows"]) != 1 {
		t.Errorf("manual update = %+v", rows)
	}
	if got := sqliteQuery(t, path, "SELECT name FROM users WHERE id = 3"); got[0]["name"] != "Cyrus" {
		t.Errorf("stored name = %+v", got)
	}
	if e := fails(t, call{node: "sqlite", creds: creds, params: map[string]any{"operation": "update", "table": "users", "columnToMatchOn": "id"},
		items: []map[string]any{{"id": 1.0}}}); !strings.Contains(e.Message, "Nothing to update") {
		t.Errorf("nothing to update = %+v", e)
	}
	if e := fails(t, call{node: "sqlite", creds: creds, params: map[string]any{"operation": "update", "table": "users", "columnToMatchOn": "id"},
		items: []map[string]any{{"name": "x"}}}); !strings.Contains(e.Message, "no field for match column") {
		t.Errorf("missing match field = %+v", e)
	}
}

func TestSQLiteDeleteGuard(t *testing.T) {
	creds, path := newSQLite(t, usersSchema)
	count := func() float64 { return num(sqliteQuery(t, path, "SELECT count(*) AS n FROM users")[0]["n"]) }

	// No conditions and no "Delete All Rows": refused, nothing deleted.
	e := fails(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{"operation": "deleteTable", "table": "users"}})
	if !strings.Contains(e.Message, "Refusing to delete every row") || count() != 3 {
		t.Errorf("guard = %+v, count %v", e, count())
	}
	// A blank condition does not count as a condition.
	e = fails(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{"operation": "deleteTable", "table": "users",
		"where": where([3]any{"", "equal", "x"})}})
	if !strings.Contains(e.Message, "no column") || count() != 3 {
		t.Errorf("blank condition = %+v", e)
	}
	// With a condition.
	rows := ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{"operation": "deleteTable", "table": "users",
		"where": where([3]any{"email", "equal", "cy@example.com"})}})
	if num(rows[0].JSON["affectedRows"]) != 1 || count() != 2 {
		t.Errorf("delete one = %+v", rows)
	}
	// Delete All Rows.
	rows = ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{"operation": "deleteTable", "table": "users", "deleteAll": true}})
	if num(rows[0].JSON["affectedRows"]) != 2 || count() != 0 {
		t.Errorf("delete all = %+v", rows)
	}
}

func TestSQLiteIdentifierInjection(t *testing.T) {
	creds, path := newSQLite(t, usersSchema)
	alive := func() {
		t.Helper()
		if got := sqliteQuery(t, path, "SELECT count(*) AS n FROM users"); num(got[0]["n"]) != 3 {
			t.Fatalf("users table changed: %+v", got)
		}
	}
	sel := func(extra map[string]any) map[string]any {
		p := map[string]any{"operation": "select", "table": "users", "returnAll": true}
		for k, v := range extra {
			p[k] = v
		}
		return p
	}
	attacks := []struct {
		name   string
		params map[string]any
		want   string
	}{
		{"table", sel(map[string]any{"table": `users"; DROP TABLE users; --`}), "does not exist"},
		{"where column", sel(map[string]any{"where": where([3]any{`id" = 1 OR 1=1; --`, "equal", "1"})}), "not a column"},
		{"sort column", sel(map[string]any{"sort": map[string]any{"values": []any{map[string]any{"column": "id; DROP TABLE users", "direction": "ASC"}}}}), "not a column"},
		{"sort direction", sel(map[string]any{"sort": map[string]any{"values": []any{map[string]any{"column": "id", "direction": "ASC; DROP TABLE users"}}}}), ""},
		{"operator", sel(map[string]any{"where": where([3]any{"id", "= 1 OR 1=1 --", "1"})}), "Unknown operator"},
		{"output column", sel(map[string]any{"options": map[string]any{"outputColumns": "* FROM users; DROP TABLE users; --"}}), "not a column"},
		{"delete column", map[string]any{"operation": "deleteTable", "table": "users", "where": where([3]any{"1=1 OR email", "equal", "x"})}, "not a column"},
	}
	for _, a := range attacks {
		resp := execute(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: a.params})
		if a.want == "" {
			if resp.Error != nil { // an unknown direction falls back to ASC
				t.Errorf("%s: %+v", a.name, resp.Error)
			}
		} else if resp.Error == nil || !strings.Contains(resp.Error.Message, a.want) {
			t.Errorf("%s: want error containing %q, got %+v", a.name, a.want, resp.Error)
		}
		alive()
	}

	// Values are bound: a classic injection string matches nothing.
	rows := ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: sel(map[string]any{
		"where": where([3]any{"email", "equal", "' OR '1'='1"})})})
	if len(rows) != 0 {
		t.Errorf("value injection returned rows: %+v", rows)
	}
	ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{"operation": "deleteTable", "table": "users",
		"where": where([3]any{"email", "equal", "x' OR '1'='1"})}})
	alive()
	// An item field named like an injection is simply not a column.
	ok(t, call{node: "sqlite", creds: creds, params: map[string]any{"operation": "insert", "table": "users"},
		items: []map[string]any{{"email": "z@example.com", `name") VALUES ('x'); DROP TABLE users; --`: "boom"}}})
	if got := sqliteQuery(t, path, "SELECT count(*) AS n FROM users"); num(got[0]["n"]) != 4 {
		t.Errorf("after insert: %+v", got)
	}
}

func TestSQLiteReadOnlyAndLoadOptions(t *testing.T) {
	creds, path := newSQLite(t, usersSchema)
	ro := map[string]any{"sqlite": map[string]any{"path": path, "readOnly": true}}
	if rows := ok(t, call{node: "sqlite", creds: ro, items: []map[string]any{{}}, params: map[string]any{"operation": "select", "table": "users", "returnAll": true}}); len(rows) != 3 {
		t.Errorf("read-only select = %d rows", len(rows))
	}
	e := fails(t, call{node: "sqlite", creds: ro, items: []map[string]any{{"email": "w@example.com"}}, params: map[string]any{"operation": "insert", "table": "users"}})
	if !strings.Contains(strings.ToLower(e.Message), "readonly") && !strings.Contains(strings.ToLower(e.Message), "read-only") {
		t.Errorf("read-only insert error = %+v", e)
	}

	p := newPlugin()
	load := func(method string, params map[string]any) []landflow.PropertyOption {
		t.Helper()
		resp, err := p.LoadOptions(context.Background(), &landflow.LoadOptionsRequest{NodeType: "databases.sqlite", Method: method, Parameters: params, Credentials: creds})
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		return resp.Options
	}
	tables := load("getTables", nil)
	if len(tables) != 2 || tables[0].Value != "adults" || tables[0].Description != "view" || tables[1].Value != "users" {
		t.Errorf("tables = %+v", tables)
	}
	cols := load("getColumns", map[string]any{"table": "users"})
	if len(cols) != 9 || cols[0].Value != "id" || cols[0].Description != "integer" || cols[8].Value != "meta" {
		t.Errorf("columns = %+v", cols)
	}
	if cols := load("getColumns", map[string]any{}); len(cols) != 0 {
		t.Errorf("columns without a table = %+v", cols)
	}
	if _, err := p.LoadOptions(context.Background(), &landflow.LoadOptionsRequest{NodeType: "databases.sqliteTrigger", Method: "getTables"}); err == nil {
		t.Error("loadOptions without credentials must fail")
	}
}

func TestMissingCredentialAndFile(t *testing.T) {
	resetPools(t)
	e := fails(t, call{node: "sqlite", items: []map[string]any{{}}, params: map[string]any{"operation": "select", "table": "users"}})
	if !strings.Contains(e.Message, "Credentials") {
		t.Errorf("no credentials = %+v", e)
	}
	e = fails(t, call{node: "sqlite", creds: map[string]any{"sqlite": map[string]any{"path": "/nonexistent/dir/x.db"}},
		items: []map[string]any{{}}, params: map[string]any{"operation": "select", "table": "users"}})
	if !strings.Contains(e.Message, "does not exist") {
		t.Errorf("missing file = %+v", e)
	}
	e = fails(t, call{node: "sqlite", creds: map[string]any{"sqlite": map[string]any{"path": t.TempDir()}},
		items: []map[string]any{{}}, params: map[string]any{"operation": "select", "table": "users"}})
	if !strings.Contains(e.Message, "directory") {
		t.Errorf("directory = %+v", e)
	}
}
