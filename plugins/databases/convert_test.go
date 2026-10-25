package main

import (
	"fmt"
	"math"
	"reflect"
	"testing"
	"time"
)

func TestConvertValue(t *testing.T) {
	ts := time.Date(2026, 10, 25, 8, 0, 0, 0, time.FixedZone("x", 2*3600))
	cases := []struct {
		v      any
		dbType string
		system string
		want   any
	}{
		{nil, "TEXT", systemPostgres, nil},
		{ts, "TIMESTAMPTZ", systemPostgres, "2026-10-25T06:00:00Z"},
		{int64(42), "INT4", systemPostgres, int64(42)},
		{int64(1 << 60), "INT8", systemPostgres, "1152921504606846976"},
		{int64(-(1 << 60)), "INT8", systemPostgres, "-1152921504606846976"},
		{"3.14159265358979323846", "NUMERIC", systemPostgres, "3.14159265358979323846"},
		{[]byte{0, 1, 2}, "BYTEA", systemPostgres, "AAEC"},
		{[]byte(`[1,"a"]`), "JSONB", systemPostgres, []any{1.0, "a"}},
		{[]byte(`not json`), "JSON", systemPostgres, "not json"},
		{"plain", "TEXT", systemPostgres, "plain"},
		{math.NaN(), "FLOAT8", systemPostgres, "NaN"},
		{math.Inf(1), "FLOAT8", systemPostgres, "+Inf"},
		{float32(1.5), "FLOAT4", systemPostgres, 1.5},
		{true, "BOOL", systemPostgres, true},
		{[]byte("12"), "BIGINT", systemMySQL, int64(12)},
		{[]byte("-7"), "INT", systemMySQL, int64(-7)},
		{[]byte("2.5"), "DOUBLE", systemMySQL, 2.5},
		{[]byte("10.00"), "DECIMAL", systemMySQL, "10.00"},
		{[]byte("hello"), "VARCHAR", systemMySQL, "hello"},
		{[]byte("hello"), "TEXT", systemMySQL, "hello"},
		{[]byte{0xde, 0xad}, "VARBINARY", systemMySQL, "3q0="},
		{[]byte(`{"a":1}`), "JSON", systemMySQL, map[string]any{"a": 1.0}},
		{uint64(5), "UNSIGNED BIGINT", systemMySQL, int64(5)},
		{[]byte{1}, "", systemSQLite, "AQ=="},
		{int64(7), "DECIMAL(10,2)", systemSQLite, "7"},
		{2.5, "NUMERIC", systemSQLite, "2.5"},
		{`{"x":true}`, "JSON", systemSQLite, map[string]any{"x": true}},
		{fmt.Stringer(time.Second), "INTERVAL", systemPostgres, "1s"},
	}
	for _, c := range cases {
		if got := convertValue(c.v, c.dbType, c.system); !reflect.DeepEqual(got, c.want) {
			t.Errorf("convertValue(%#v, %s, %s) = %#v, want %#v", c.v, c.dbType, c.system, got, c.want)
		}
	}
}

func TestBind(t *testing.T) {
	pg, my := postgresDialect, mysqlDialect
	cases := []struct {
		d    *dialect
		v    any
		want any
	}{
		{pg, 5.0, "5"}, {pg, 2.5, "2.5"}, {pg, true, "true"}, {pg, "x", "x"}, {pg, nil, nil},
		{pg, map[string]any{"a": 1.0}, `{"a":1}`}, {pg, []any{1.0, "b"}, `[1,"b"]`}, {pg, int64(9), "9"},
		{my, 5.0, int64(5)}, {my, 2.5, 2.5}, {my, true, true}, {my, "x", "x"}, {my, []any{}, "[]"},
		{my, 1e300, 1e300},
	}
	for _, c := range cases {
		if got := c.d.bind(c.v); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s bind(%#v) = %#v, want %#v", c.d.system, c.v, got, c.want)
		}
	}
}

func TestQuoteIdentifiers(t *testing.T) {
	if got := postgresDialect.quote(`we"ird`); got != `"we""ird"` {
		t.Errorf("pg quote = %s", got)
	}
	if got := mysqlDialect.quote("we`ird"); got != "`we``ird`" {
		t.Errorf("mysql quote = %s", got)
	}
	if got := postgresDialect.table("s", "t"); got != `"s"."t"` {
		t.Errorf("pg table = %s", got)
	}
	if got := sqliteDialect.table("ignored", "t"); got != `"t"` {
		t.Errorf("sqlite table = %s", got)
	}
}

func TestSanitizeStatement(t *testing.T) {
	cases := []struct {
		in, want string
		mysql    bool
	}{
		{"SELECT * FROM users WHERE email = 'ada@example.com' AND age > 30", "SELECT * FROM users WHERE email = ? AND age > ?", false},
		{"SELECT * FROM t WHERE id = $1 AND name = 'O''Brien'", "SELECT * FROM t WHERE id = $1 AND name = ?", false},
		{`SELECT "col1", t2.x FROM t2 WHERE y = -1.5e3 -- secret comment`, `SELECT "col1", t2.x FROM t2 WHERE y = -?`, false},
		{"SELECT $body$ s3cret $body$, $$x$$ /* note */ FROM t", "SELECT ?, ? FROM t", false},
		{`SELECT * FROM t WHERE a = "secret" AND b = ?`, "SELECT * FROM t WHERE a = ? AND b = ?", true},
		{`SELECT * FROM t WHERE a = 'it\'s' AND c IN (1, 2)`, "SELECT * FROM t WHERE a = ? AND c IN (?, ?)", true},
		{"SELECT `weird name` FROM t1", "SELECT `weird name` FROM t1", true},
		{"UPDATE t SET v = .5 WHERE id=10", "UPDATE t SET v = ? WHERE id=?", false},
	}
	for _, c := range cases {
		if got := sanitizeStatement(c.in, c.mysql); got != c.want {
			t.Errorf("sanitize(%q)\n got %q\nwant %q", c.in, got, c.want)
		}
	}
}

func TestStatementClassification(t *testing.T) {
	rows := []string{"SELECT 1", "  with x as (select 1) select * from x", "-- c\nSELECT 1", "/* c */ (SELECT 1)",
		"SHOW TABLES", "PRAGMA table_info(t)", "INSERT INTO t VALUES (1) RETURNING id", "explain select 1", "VALUES (1)"}
	for _, q := range rows {
		if !returnsRows(q) {
			t.Errorf("returnsRows(%q) = false", q)
		}
	}
	noRows := []string{"INSERT INTO t VALUES ('RETURNING')", "UPDATE t SET returning_x = 1", "CREATE TABLE t (id int)", "DELETE FROM t", ""}
	for _, q := range noRows {
		if returnsRows(q) {
			t.Errorf("returnsRows(%q) = true", q)
		}
	}
	for q, want := range map[string]string{"select 1": "SELECT", "  insert into t": "INSERT", "frobnicate": "OTHER", "": "OTHER", "VACUUM": "VACUUM"} {
		if got := operationName(q); got != want {
			t.Errorf("operationName(%q) = %q", q, got)
		}
	}
}

func TestParseQueryParameters(t *testing.T) {
	cases := []struct {
		in   any
		want []any
	}{
		{nil, nil},
		{"", nil},
		{"a, b ,c", []any{"a", "b", "c"}},
		{`"a, with comma", b`, []any{"a, with comma", "b"}},
		{`"say ""hi""", x`, []any{`say "hi"`, "x"}},
		{`[1, "two", null]`, []any{1.0, "two", nil}},
		{"[not json", []any{"[not json"}},
		{[]any{1.0, true}, []any{1.0, true}},
		{42.0, []any{42.0}},
		{"a,,b", []any{"a", "", "b"}},
	}
	for _, c := range cases {
		if got := parseQueryParameters(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("parseQueryParameters(%#v) = %#v, want %#v", c.in, got, c.want)
		}
	}
}

func TestUpsertClause(t *testing.T) {
	if got := postgresDialect.upsertClause([]string{"id"}, []string{"a", "b"}); got != ` ON CONFLICT ("id") DO UPDATE SET "a" = EXCLUDED."a", "b" = EXCLUDED."b"` {
		t.Errorf("pg = %s", got)
	}
	if got := mysqlDialect.upsertClause([]string{"id"}, []string{"a"}); got != " ON DUPLICATE KEY UPDATE `a` = VALUES(`a`)" {
		t.Errorf("mysql = %s", got)
	}
	if got := sqliteDialect.upsertClause([]string{"k1", "k2"}, nil); got != ` ON CONFLICT ("k1", "k2") DO UPDATE SET "k1" = EXCLUDED."k1"` {
		t.Errorf("sqlite = %s", got)
	}
}

func TestChunkSize(t *testing.T) {
	if chunkSize(3) != 500 || chunkSize(100) != 300 || chunkSize(50000) != 1 || chunkSize(0) != 500 {
		t.Errorf("chunk sizes %d %d %d", chunkSize(3), chunkSize(100), chunkSize(50000))
	}
}
