package main

import (
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Exact MySQL SQL and argument binding for every operation (sqlmock):
// backticks, ? placeholders, ON DUPLICATE KEY UPDATE and no RETURNING.

var myCreds = map[string]any{"mySql": map[string]any{
	"host": "mysql.internal", "port": 3307.0, "database": "shop", "user": "app", "password": "s3cret-my-pass", "ssl": "skip-verify",
}}

const myColumnsSQL = "SELECT column_name AS name, data_type AS type FROM information_schema.columns " +
	"WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position"

func expectMyColumns(mock sqlmock.Sqlmock, table string, cols ...string) {
	rows := sqlmock.NewRows([]string{"name", "type"})
	for _, c := range cols {
		rows.AddRow(c, "varchar")
	}
	mock.ExpectQuery(myColumnsSQL).WithArgs(table).WillReturnRows(rows)
}

func TestMySQLSelectSQL(t *testing.T) {
	mock := withMock(t, mysqlDialect)
	expectMyColumns(mock, "orders", "id", "status", "total")
	mock.ExpectQuery("SELECT * FROM `orders` WHERE `status` != ? AND `total` < ? ORDER BY `id` DESC LIMIT ?").
		WithArgs("void", int64(100), int64(50)).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(1)))
	ok(t, call{node: "mySql", creds: myCreds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "select", "table": "orders",
		"where": where([3]any{"status", "!=", "void"}, [3]any{"total", "<", 100.0}),
		"sort":  map[string]any{"values": []any{map[string]any{"column": "id", "direction": "DESC"}}},
	}})

	// Return All: no LIMIT. A backtick in a name never reaches the SQL: it is
	// not a column.
	expectMyColumns(mock, "orders", "id")
	mock.ExpectQuery("SELECT * FROM `orders`").WillReturnRows(sqlmock.NewRows([]string{"id"}))
	ok(t, call{node: "mySql", creds: myCreds, items: []map[string]any{{}}, params: map[string]any{"operation": "select", "table": "orders", "returnAll": true}})
	expectMyColumns(mock, "orders", "id")
	e := fails(t, call{node: "mySql", creds: myCreds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "select", "table": "orders", "where": where([3]any{"id` = 1 OR `1", "equal", "1"})}})
	if !strings.Contains(e.Message, "not a column") {
		t.Errorf("backtick column = %+v", e)
	}
}

func TestMySQLWritesSQL(t *testing.T) {
	mock := withMock(t, mysqlDialect)
	// Insert: no RETURNING, so the written values come back.
	expectMyColumns(mock, "orders", "id", "status", "total", "meta")
	mock.ExpectExec("INSERT INTO `orders` (`status`, `total`, `meta`) VALUES (?, ?, ?), (?, ?, ?)").
		WithArgs("paid", 9.5, `{"a":1}`, "new", int64(3), nil).
		WillReturnResult(sqlmock.NewResult(10, 2))
	rows := ok(t, call{node: "mySql", creds: myCreds, params: map[string]any{"operation": "insert", "table": "orders"},
		items: []map[string]any{{"status": "paid", "total": 9.5, "meta": map[string]any{"a": 1.0}}, {"status": "new", "total": 3.0, "meta": nil}}})
	if len(rows) != 2 || rows[0].JSON["status"] != "paid" || rows[1].PairedItem.Item != 1 {
		t.Errorf("insert output = %+v", rows)
	}

	// Upsert: ON DUPLICATE KEY UPDATE for the non-match columns.
	expectMyColumns(mock, "orders", "id", "status", "total")
	mock.ExpectExec("INSERT INTO `orders` (`id`, `status`, `total`) VALUES (?, ?, ?) "+
		"ON DUPLICATE KEY UPDATE `status` = VALUES(`status`), `total` = VALUES(`total`)").
		WithArgs(int64(1), "paid", true).WillReturnResult(sqlmock.NewResult(0, 2))
	ok(t, call{node: "mySql", creds: myCreds, params: map[string]any{"operation": "upsert", "table": "orders", "columnsToMatchOn": "id"},
		items: []map[string]any{{"id": 1.0, "status": "paid", "total": true}}})

	// Upsert with only the key: a no-op assignment keeps the statement valid.
	expectMyColumns(mock, "orders", "id", "status")
	mock.ExpectExec("INSERT INTO `orders` (`id`) VALUES (?) ON DUPLICATE KEY UPDATE `id` = VALUES(`id`)").
		WithArgs(int64(1)).WillReturnResult(sqlmock.NewResult(0, 0))
	ok(t, call{node: "mySql", creds: myCreds, params: map[string]any{"operation": "upsert", "table": "orders", "columnsToMatchOn": "id"},
		items: []map[string]any{{"id": 1.0}}})

	// Update: {success, affectedRows}.
	expectMyColumns(mock, "orders", "id", "status")
	mock.ExpectExec("UPDATE `orders` SET `status` = ? WHERE `id` = ?").
		WithArgs("void", "7").WillReturnResult(sqlmock.NewResult(0, 1))
	rows = ok(t, call{node: "mySql", creds: myCreds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "update", "table": "orders", "columnToMatchOn": "id", "dataMode": "defineBelow", "valueToMatchOn": "7",
		"valuesToSend": map[string]any{"values": []any{map[string]any{"column": "status", "value": "void"}}}}})
	if rows[0].JSON["success"] != true || num(rows[0].JSON["affectedRows"]) != 1 {
		t.Errorf("update output = %+v", rows)
	}

	// Delete with LIKE.
	expectMyColumns(mock, "orders", "id", "status")
	mock.ExpectExec("DELETE FROM `orders` WHERE `status` LIKE ?").WithArgs("test%").WillReturnResult(sqlmock.NewResult(0, 3))
	ok(t, call{node: "mySql", creds: myCreds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "deleteTable", "table": "orders", "where": where([3]any{"status", "LIKE", "test%"})}})
}

func TestMySQLExecuteQuerySQL(t *testing.T) {
	mock := withMock(t, mysqlDialect)
	mock.ExpectQuery("SELECT * FROM orders WHERE id = ? AND status = ?").WithArgs(int64(5), "paid").
		WillReturnRows(sqlmock.NewRowsWithColumnDefinition(
			sqlmock.NewColumn("id").OfType("INT", []byte{}),
			sqlmock.NewColumn("total").OfType("DECIMAL", []byte{}),
			sqlmock.NewColumn("name").OfType("VARCHAR", []byte{}),
			sqlmock.NewColumn("blob").OfType("BLOB", []byte{}),
			sqlmock.NewColumn("at").OfType("DATETIME", time.Time{}),
			sqlmock.NewColumn("doc").OfType("JSON", []byte{}),
			sqlmock.NewColumn("big").OfType("UNSIGNED BIGINT", []byte{}),
		).AddRow([]byte("5"), []byte("19.90"), []byte("Ada"), []byte{0xff}, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), []byte(`{"x":1}`), []byte("18446744073709551615")))
	rows := ok(t, call{node: "mySql", creds: myCreds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "executeQuery", "query": "SELECT * FROM orders WHERE id = ? AND status = ?",
		"options": map[string]any{"queryReplacement": []any{5.0, "paid"}}}})
	got := rows[0].JSON
	if got["id"] != int64(5) || got["total"] != "19.90" || got["name"] != "Ada" || got["blob"] != "/w==" ||
		got["at"] != "2026-01-02T03:04:05Z" || got["big"] != "18446744073709551615" {
		t.Errorf("converted = %#v", got)
	}
	if doc, _ := got["doc"].(map[string]any); doc["x"] != 1.0 {
		t.Errorf("doc = %#v", got["doc"])
	}

	mock.ExpectExec("DELETE FROM sessions WHERE expires < NOW()").WillReturnResult(sqlmock.NewResult(0, 12))
	rows = ok(t, call{node: "mySql", creds: myCreds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "executeQuery", "query": "DELETE FROM sessions WHERE expires < NOW()"}})
	if num(rows[0].JSON["affectedRows"]) != 12 {
		t.Errorf("exec = %+v", rows)
	}
}

func TestMySQLConfig(t *testing.T) {
	data := landflow.CredentialData(myCreds["mySql"].(map[string]any))
	cfg, err := mysqlConfig(data)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != "mysql.internal:3307" || cfg.DBName != "shop" || cfg.User != "app" || cfg.Passwd != "s3cret-my-pass" ||
		cfg.TLSConfig != "skip-verify" || !cfg.ParseTime || cfg.Timeout != 10*time.Second || cfg.Net != "tcp" {
		t.Errorf("config = %+v", cfg)
	}
	if _, err := openMySQL(data); err != nil {
		t.Errorf("connector: %v", err)
	}
	data2 := landflow.CredentialData{"host": "h", "ssl": "maybe"}
	if _, err := mysqlConfig(data2); err == nil {
		t.Error("an unknown SSL mode must be rejected")
	}
}
