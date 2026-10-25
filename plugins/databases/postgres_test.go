package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/jackc/pgx/v5/pgconn"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Exact Postgres SQL and argument binding for every operation (sqlmock).

var pgCreds = map[string]any{"postgres": map[string]any{
	"host": "db.internal", "port": 5432.0, "database": "shop", "user": "app", "password": "s3cret-pg-pass", "ssl": "disable",
}}

const pgColumnsSQL = "SELECT column_name, data_type FROM information_schema.columns " +
	"WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position"

func expectPgColumns(mock sqlmock.Sqlmock, schema, table string, cols ...string) {
	rows := sqlmock.NewRows([]string{"column_name", "data_type"})
	for _, c := range cols {
		rows.AddRow(c, "text")
	}
	mock.ExpectQuery(pgColumnsSQL).WithArgs(schema, table).WillReturnRows(rows)
}

func TestPostgresSelectSQL(t *testing.T) {
	mock := withMock(t, postgresDialect)
	expectPgColumns(mock, "sales", "orders", "id", "status", "total", "created_at", "note")
	mock.ExpectQuery(`SELECT "id", "status" FROM "sales"."orders" WHERE "status" = $1 AND "total" >= $2 AND "note" IS NOT NULL `+
		`ORDER BY "created_at" DESC, "id" ASC LIMIT $3`).
		WithArgs("paid", "100", "10").
		WillReturnRows(sqlmock.NewRows([]string{"id", "status"}).AddRow(int64(7), "paid"))

	rows := ok(t, call{node: "postgres", creds: pgCreds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "select", "schema": "sales", "table": "orders", "limit": 10.0,
		"where": where([3]any{"status", "equal", "paid"}, [3]any{"total", ">=", 100.0}, [3]any{"note", "IS NOT NULL", "ignored"}),
		"sort": map[string]any{"values": []any{
			map[string]any{"column": "created_at", "direction": "DESC"}, map[string]any{"column": "id", "direction": "ASC"},
		}},
		"options": map[string]any{"outputColumns": "id,status"},
	}})
	if len(rows) != 1 || num(rows[0].JSON["id"]) != 7 {
		t.Errorf("rows = %+v", rows)
	}
}

func TestPostgresInsertUpsertSQL(t *testing.T) {
	mock := withMock(t, postgresDialect)
	expectPgColumns(mock, "public", "orders", "id", "status", "total", "meta")
	mock.ExpectQuery(`INSERT INTO "public"."orders" ("id", "status", "total", "meta") VALUES ($1, $2, $3, $4), ($5, $6, $7, $8) RETURNING *`).
		WithArgs("1", "paid", "9.5", `{"a":1}`, "2", "new", "true", nil).
		WillReturnRows(sqlmock.NewRows([]string{"id", "status"}).AddRow(int64(1), "paid").AddRow(int64(2), "new"))
	rows := ok(t, call{node: "postgres", creds: pgCreds, params: map[string]any{"operation": "insert", "table": "orders"},
		items: []map[string]any{
			{"id": 1.0, "status": "paid", "total": 9.5, "meta": map[string]any{"a": 1.0}, "ignored": "x"},
			{"id": 2.0, "status": "new", "total": true, "meta": nil},
		}})
	if len(rows) != 2 || rows[1].JSON["status"] != "new" || rows[1].PairedItem.Item != 1 {
		t.Errorf("insert rows = %+v", rows)
	}

	expectPgColumns(mock, "public", "orders", "id", "status", "total", "meta")
	mock.ExpectQuery(`INSERT INTO "public"."orders" ("id", "status") VALUES ($1, $2) `+
		`ON CONFLICT ("id") DO UPDATE SET "status" = EXCLUDED."status" RETURNING *`).
		WithArgs("1", "shipped").
		WillReturnRows(sqlmock.NewRows([]string{"id", "status"}).AddRow(int64(1), "shipped"))
	rows = ok(t, call{node: "postgres", creds: pgCreds, params: map[string]any{"operation": "upsert", "table": "orders", "columnsToMatchOn": "id"},
		items: []map[string]any{{"id": 1.0, "status": "shipped"}}})
	if len(rows) != 1 || rows[0].JSON["status"] != "shipped" {
		t.Errorf("upsert rows = %+v", rows)
	}

	// Two match columns and Return Rows off: Exec without RETURNING.
	expectPgColumns(mock, "public", "stock", "sku", "warehouse", "qty")
	mock.ExpectExec(`INSERT INTO "public"."stock" ("sku", "warehouse", "qty") VALUES ($1, $2, $3) `+
		`ON CONFLICT ("sku", "warehouse") DO UPDATE SET "qty" = EXCLUDED."qty"`).
		WithArgs("A-1", "north", "5").WillReturnResult(sqlmock.NewResult(0, 1))
	rows = ok(t, call{node: "postgres", creds: pgCreds, params: map[string]any{
		"operation": "upsert", "table": "stock", "columnsToMatchOn": "sku, warehouse", "options": map[string]any{"returnRows": false}},
		items: []map[string]any{{"sku": "A-1", "warehouse": "north", "qty": 5.0}}})
	if len(rows) != 1 || rows[0].JSON["qty"] != 5.0 {
		t.Errorf("upsert without returning = %+v", rows)
	}
}

func TestPostgresUpdateDeleteSQL(t *testing.T) {
	mock := withMock(t, postgresDialect)
	expectPgColumns(mock, "public", "orders", "id", "status", "total")
	mock.ExpectQuery(`UPDATE "public"."orders" SET "status" = $1 WHERE "id" = $2 RETURNING *`).
		WithArgs("void", "3").
		WillReturnRows(sqlmock.NewRows([]string{"id", "status"}).AddRow(int64(3), "void"))
	rows := ok(t, call{node: "postgres", creds: pgCreds, params: map[string]any{"operation": "update", "table": "orders", "columnToMatchOn": "id"},
		items: []map[string]any{{"id": 3.0, "status": "void"}}})
	if len(rows) != 1 || rows[0].JSON["status"] != "void" {
		t.Errorf("update rows = %+v", rows)
	}

	expectPgColumns(mock, "public", "orders", "id", "status", "total")
	mock.ExpectExec(`DELETE FROM "public"."orders" WHERE "status" = $1 OR "total" IS NULL`).
		WithArgs("void").WillReturnResult(sqlmock.NewResult(0, 4))
	rows = ok(t, call{node: "postgres", creds: pgCreds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "deleteTable", "table": "orders", "combineConditions": "OR",
		"where": where([3]any{"status", "equal", "void"}, [3]any{"total", "IS NULL", ""})}})
	if num(rows[0].JSON["affectedRows"]) != 4 {
		t.Errorf("delete = %+v", rows)
	}

	// The delete guard never reaches the database.
	expectPgColumns(mock, "public", "orders", "id")
	e := fails(t, call{node: "postgres", creds: pgCreds, items: []map[string]any{{}}, params: map[string]any{"operation": "deleteTable", "table": "orders"}})
	if !strings.Contains(e.Message, "Refusing") {
		t.Errorf("guard = %+v", e)
	}
	// Delete All Rows.
	expectPgColumns(mock, "public", "orders", "id")
	mock.ExpectExec(`DELETE FROM "public"."orders"`).WillReturnResult(sqlmock.NewResult(0, 9))
	ok(t, call{node: "postgres", creds: pgCreds, items: []map[string]any{{}}, params: map[string]any{"operation": "deleteTable", "table": "orders", "deleteAll": true}})
}

func TestPostgresExecuteQuerySQL(t *testing.T) {
	mock := withMock(t, postgresDialect)
	// Comma-separated parameters, bound as text.
	mock.ExpectQuery(`SELECT * FROM orders WHERE status = $1 AND total > $2`).WithArgs("paid", "100").
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(1)))
	ok(t, call{node: "postgres", creds: pgCreds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "executeQuery", "query": "SELECT * FROM orders WHERE status = $1 AND total > $2",
		"options": map[string]any{"queryReplacement": "paid, 100"}}})

	// An array from an expression; an UPDATE without RETURNING is an Exec.
	mock.ExpectExec(`UPDATE orders SET note = $1 WHERE id = $2`).WithArgs(`{"by":"bot"}`, "5").
		WillReturnResult(sqlmock.NewResult(0, 1))
	rows := ok(t, call{node: "postgres", creds: pgCreds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "executeQuery", "query": "UPDATE orders SET note = $1 WHERE id = $2",
		"options": map[string]any{"queryReplacement": []any{map[string]any{"by": "bot"}, 5.0}}}})
	if rows[0].JSON["success"] != true || num(rows[0].JSON["affectedRows"]) != 1 {
		t.Errorf("exec output = %+v", rows)
	}

	// Transaction: BEGIN, one statement per item, COMMIT.
	mock.ExpectBegin()
	mock.ExpectExec(`INSERT INTO log (msg) VALUES ($1)`).WithArgs("a").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO log (msg) VALUES ($1)`).WithArgs("b").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	tx := func(v string) map[string]any {
		return map[string]any{"operation": "executeQuery", "query": "INSERT INTO log (msg) VALUES ($1)",
			"options": map[string]any{"queryBatching": "transaction", "queryReplacement": v}}
	}
	ok(t, call{node: "postgres", creds: pgCreds, items: []map[string]any{{}, {}}, params: tx("a"), itemParams: []map[string]any{tx("a"), tx("b")}})

	// A failing statement rolls the transaction back and reports the item
	// with Postgres' detail and hint.
	mock.ExpectBegin()
	mock.ExpectExec(`INSERT INTO log (msg) VALUES ($1)`).WithArgs("a").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO log (msg) VALUES ($1)`).WithArgs("b").
		WillReturnError(&pgconn.PgError{Severity: "ERROR", Code: "23505", Message: "duplicate key value violates unique constraint", Detail: "Key (msg)=(b) already exists.", Hint: "Use upsert."})
	mock.ExpectRollback()
	e := fails(t, call{node: "postgres", creds: pgCreds, items: []map[string]any{{}, {}}, params: tx("a"), itemParams: []map[string]any{tx("a"), tx("b")}})
	if e.ItemIndex == nil || *e.ItemIndex != 1 || !strings.Contains(e.Message, "duplicate key") || !strings.Contains(e.Description, "already exists") || !strings.Contains(e.Description, "Use upsert") {
		t.Errorf("rollback error = %+v", e)
	}
}

func TestPostgresTypeConversion(t *testing.T) {
	mock := withMock(t, postgresDialect)
	ts := time.Date(2026, 10, 25, 10, 30, 0, 123456000, time.UTC)
	rows := sqlmock.NewRowsWithColumnDefinition(
		sqlmock.NewColumn("id").OfType("INT8", int64(0)),
		sqlmock.NewColumn("big").OfType("INT8", int64(0)),
		sqlmock.NewColumn("price").OfType("NUMERIC", ""),
		sqlmock.NewColumn("raw").OfType("BYTEA", []byte{}),
		sqlmock.NewColumn("at").OfType("TIMESTAMPTZ", time.Time{}),
		sqlmock.NewColumn("doc").OfType("JSONB", []byte{}),
		sqlmock.NewColumn("ok").OfType("BOOL", false),
		sqlmock.NewColumn("ratio").OfType("FLOAT8", 0.0),
		sqlmock.NewColumn("uid").OfType("UUID", ""),
		sqlmock.NewColumn("none").OfType("TEXT", ""),
	).AddRow(int64(42), int64(9007199254740993), "12345678901234567890.123", []byte("hi"), ts, []byte(`{"k":[1,2]}`), true, 0.25,
		"0b9e2c5e-2f3a-4b8c-9d1e-123456789abc", nil)
	mock.ExpectQuery("SELECT * FROM t").WillReturnRows(rows)
	got := ok(t, call{node: "postgres", creds: pgCreds, items: []map[string]any{{}}, params: map[string]any{"operation": "executeQuery", "query": "SELECT * FROM t"}})[0].JSON
	want := map[string]any{
		"id": int64(42), "big": "9007199254740993", "price": "12345678901234567890.123", "raw": "aGk=",
		"at": "2026-10-25T10:30:00.123456Z", "ok": true, "ratio": 0.25, "uid": "0b9e2c5e-2f3a-4b8c-9d1e-123456789abc", "none": nil,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %#v, want %#v", k, got[k], v)
		}
	}
	if doc, _ := got["doc"].(map[string]any); doc == nil || len(doc["k"].([]any)) != 2 {
		t.Errorf("doc = %#v", got["doc"])
	}
}

func TestPostgresLoadOptionsSQL(t *testing.T) {
	mock := withMock(t, postgresDialect)
	mock.ExpectQuery(postgresDialect.schemasQuery).WillReturnRows(sqlmock.NewRows([]string{"schema_name", "x"}).AddRow("public", "").AddRow("sales", ""))
	mock.ExpectQuery(postgresDialect.tablesQuery).WithArgs("sales").
		WillReturnRows(sqlmock.NewRows([]string{"table_name", "kind"}).AddRow("orders", "table").AddRow("v_orders", "view"))
	expectPgColumns(mock, "sales", "orders", "id", "status")
	p := newPlugin()
	load := func(method string, params map[string]any) []landflow.PropertyOption {
		resp, err := p.LoadOptions(context.Background(), &landflow.LoadOptionsRequest{NodeType: "databases.postgres", Method: method, Parameters: params, Credentials: pgCreds})
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		return resp.Options
	}
	if s := load("getSchemas", nil); len(s) != 2 || s[1].Value != "sales" {
		t.Errorf("schemas = %+v", s)
	}
	if tb := load("getTables", map[string]any{"schema": "sales"}); len(tb) != 2 || tb[1].Description != "view" {
		t.Errorf("tables = %+v", tb)
	}
	if c := load("getColumns", map[string]any{"schema": "sales", "table": "orders"}); len(c) != 2 || c[1].Value != "status" {
		t.Errorf("columns = %+v", c)
	}
}

func TestPostgresConfigKeepsPasswordOutOfDSN(t *testing.T) {
	data := landflow.CredentialData(pgCreds["postgres"].(map[string]any))
	data["ssl"] = "verify-full"
	cfg, err := postgresConfig(data)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "db.internal" || cfg.Port != 5432 || cfg.Database != "shop" || cfg.User != "app" ||
		cfg.Password != "s3cret-pg-pass" || cfg.TLSConfig == nil || cfg.ConnectTimeout != 10*time.Second {
		t.Errorf("config = %+v", cfg.Config)
	}
	if strings.Contains(cfg.ConnString(), "s3cret") {
		t.Errorf("the connection string contains the password: %s", cfg.ConnString())
	}
	data["ssl"] = "prefer'; DROP"
	if _, err := postgresConfig(data); err == nil {
		t.Error("an unknown SSL mode must be rejected")
	}
}

// A driver error that echoes a credential value is masked before it reaches
// the node error.
func TestErrorsAreRedacted(t *testing.T) {
	mock := withMock(t, postgresDialect)
	mock.ExpectQuery("SELECT 1").WillReturnError(errors.New("auth failed for password s3cret-pg-pass"))
	e := fails(t, call{node: "postgres", creds: pgCreds, items: []map[string]any{{}}, params: map[string]any{"operation": "executeQuery", "query": "SELECT 1"}})
	if strings.Contains(e.Message, "s3cret") || !strings.Contains(e.Message, landflow.Redacted) {
		t.Errorf("error = %+v", e)
	}
}
