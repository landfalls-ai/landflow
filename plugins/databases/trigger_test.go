package main

import (
	"database/sql"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Poll trigger semantics (SQLite end to end, Postgres SQL with sqlmock).

const eventsSchema = `
CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT, created_at TEXT);
INSERT INTO events (id, name, created_at) VALUES
	(1, 'a', '2026-10-25 10:00:01'), (2, 'b', '2026-10-25 10:00:02'), (3, 'c', '2026-10-25 10:00:03'),
	(4, 'd', '2026-10-25 10:00:04'), (5, 'e', '2026-10-25 10:00:05'), (6, 'f', '2026-10-25 10:00:06'),
	(7, 'g', '2026-10-25 10:00:07');
`

func insertEvents(t *testing.T, path string, stmts ...string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatal(err)
		}
	}
}

func poll(t *testing.T, creds map[string]any, params map[string]any, mode landflow.ExecutionMode, state map[string]any) *landflow.ExecuteResponse {
	t.Helper()
	resp := execute(t, call{node: "sqliteTrigger", creds: creds, params: params, mode: mode, state: state})
	if resp.Error != nil {
		t.Fatalf("poll: %+v", resp.Error)
	}
	return resp
}

func ids(items []landflow.Item) []float64 {
	out := make([]float64, len(items))
	for i, it := range items {
		out[i] = num(it.JSON["id"])
	}
	return out
}

func TestSQLiteTrigger(t *testing.T) {
	creds, path := newSQLite(t, eventsSchema)
	params := map[string]any{"table": "events", "trackingColumn": "id", "pollInterval": 10.0}

	// Manual: the latest 5 rows, oldest first, no state, no cursor column.
	resp := poll(t, creds, params, landflow.ModeManual, nil)
	if got := ids(resp.Outputs[0]); len(got) != 5 || got[0] != 3 || got[4] != 7 {
		t.Errorf("manual ids = %v", got)
	}
	if resp.PollState != nil {
		t.Errorf("manual returned state %v", resp.PollState)
	}
	if _, leaked := resp.Outputs[0][0].JSON[cursorAlias]; leaked {
		t.Error("cursor column leaked into the output")
	}

	// First poll: baseline only.
	resp = poll(t, creds, params, landflow.ModePoll, nil)
	if len(resp.Outputs[0]) != 0 || resp.PollState["lastValue"] != "7" {
		t.Fatalf("first poll = %+v state %v", resp.Outputs, resp.PollState)
	}
	state := resp.PollState

	// Nothing new: no items, same state.
	resp = poll(t, creds, params, landflow.ModePoll, state)
	if len(resp.Outputs[0]) != 0 || resp.PollState["lastValue"] != "7" {
		t.Errorf("idle poll = %+v state %v", resp.Outputs, resp.PollState)
	}

	// New rows, oldest first; the state advances.
	insertEvents(t, path, "INSERT INTO events (id, name) VALUES (8, 'h'), (9, 'i'), (10, 'j')")
	resp = poll(t, creds, map[string]any{"table": "events", "trackingColumn": "id", "limit": 2.0}, landflow.ModePoll, state)
	if got := ids(resp.Outputs[0]); len(got) != 2 || got[0] != 8 || got[1] != 9 || resp.PollState["lastValue"] != "9" {
		t.Errorf("limited poll ids = %v state %v", got, resp.PollState)
	}
	if resp.Outputs[0][0].JSON["name"] != "h" {
		t.Errorf("row = %+v", resp.Outputs[0][0].JSON)
	}
	resp = poll(t, creds, params, landflow.ModePoll, resp.PollState)
	if got := ids(resp.Outputs[0]); len(got) != 1 || got[0] != 10 || resp.PollState["lastValue"] != "10" {
		t.Errorf("next poll ids = %v state %v", got, resp.PollState)
	}
	// Numbers compare as numbers ("10" > "9" would fail as text).
	insertEvents(t, path, "INSERT INTO events (id, name) VALUES (11, 'k')")
	resp = poll(t, creds, params, landflow.ModePoll, map[string]any{"lastValue": "9"})
	if got := ids(resp.Outputs[0]); len(got) != 2 || got[0] != 10 || got[1] != 11 {
		t.Errorf("numeric comparison ids = %v", got)
	}

	// A state without lastValue sets a new baseline.
	resp = poll(t, creds, params, landflow.ModePoll, map[string]any{"other": 1})
	if len(resp.Outputs[0]) != 0 || resp.PollState["lastValue"] != "11" {
		t.Errorf("rebaseline = %+v %v", resp.Outputs, resp.PollState)
	}
}

func TestSQLiteTriggerTimestampsAndEmptyTable(t *testing.T) {
	creds, path := newSQLite(t, eventsSchema+"CREATE TABLE empty (id INTEGER PRIMARY KEY, v TEXT);")

	// A created_at text column.
	params := map[string]any{"table": "events", "trackingColumn": "created_at"}
	resp := poll(t, creds, params, landflow.ModePoll, nil)
	if resp.PollState["lastValue"] != "2026-10-25 10:00:07" {
		t.Fatalf("baseline = %v", resp.PollState)
	}
	insertEvents(t, path, "INSERT INTO events (id, name, created_at) VALUES (20, 'late', '2026-10-25 10:00:08')")
	resp = poll(t, creds, params, landflow.ModePoll, resp.PollState)
	if got := ids(resp.Outputs[0]); len(got) != 1 || got[0] != 20 || resp.PollState["lastValue"] != "2026-10-25 10:00:08" {
		t.Errorf("timestamp poll = %v %v", got, resp.PollState)
	}

	// An empty table: the baseline is null, then every new row counts.
	params = map[string]any{"table": "empty", "trackingColumn": "id"}
	resp = poll(t, creds, params, landflow.ModePoll, nil)
	if v, present := resp.PollState["lastValue"]; !present || v != nil {
		t.Fatalf("empty baseline = %#v", resp.PollState)
	}
	insertEvents(t, path, "INSERT INTO empty (id, v) VALUES (1, 'first')")
	resp = poll(t, creds, params, landflow.ModePoll, resp.PollState)
	if got := ids(resp.Outputs[0]); len(got) != 1 || resp.PollState["lastValue"] != "1" {
		t.Errorf("first row after empty baseline = %v %v", got, resp.PollState)
	}

	// Bad parameters fail without an item index.
	e := fails(t, call{node: "sqliteTrigger", creds: creds, mode: landflow.ModePoll, params: map[string]any{"table": "events", "trackingColumn": "nope"}})
	if !strings.Contains(e.Message, "not a column") || e.ItemIndex != nil {
		t.Errorf("bad column = %+v", e)
	}
	e = fails(t, call{node: "sqliteTrigger", creds: creds, mode: landflow.ModePoll, params: map[string]any{"table": "missing", "trackingColumn": "id"}})
	if !strings.Contains(e.Message, "does not exist") || e.ItemIndex != nil {
		t.Errorf("bad table = %+v", e)
	}
}

func TestPostgresTriggerSQL(t *testing.T) {
	mock := withMock(t, postgresDialect)
	params := map[string]any{"schema": "public", "table": "orders", "trackingColumn": "id", "limit": 50.0}

	expectPgColumns(mock, "public", "orders", "id", "status")
	mock.ExpectQuery(`SELECT CAST(MAX("id") AS TEXT) AS "__landflow_cursor" FROM "public"."orders"`).
		WillReturnRows(sqlmock.NewRows([]string{"__landflow_cursor"}).AddRow("41"))
	resp := execute(t, call{node: "postgresTrigger", creds: pgCreds, params: params, mode: landflow.ModePoll})
	if resp.Error != nil || resp.PollState["lastValue"] != "41" || len(resp.Outputs[0]) != 0 {
		t.Fatalf("baseline = %+v", resp)
	}

	expectPgColumns(mock, "public", "orders", "id", "status")
	mock.ExpectQuery(`SELECT *, CAST("id" AS TEXT) AS "__landflow_cursor" FROM "public"."orders" WHERE "id" > $1 ORDER BY "id" ASC LIMIT $2`).
		WithArgs("41", "50").
		WillReturnRows(sqlmock.NewRows([]string{"id", "status", "__landflow_cursor"}).AddRow(int64(42), "new", "42").AddRow(int64(43), "new", "43"))
	resp = execute(t, call{node: "postgresTrigger", creds: pgCreds, params: params, mode: landflow.ModePoll, state: resp.PollState})
	if resp.Error != nil || len(resp.Outputs[0]) != 2 || resp.PollState["lastValue"] != "43" {
		t.Fatalf("poll = %+v", resp)
	}
	if _, leaked := resp.Outputs[0][1].JSON[cursorAlias]; leaked || num(resp.Outputs[0][1].JSON["id"]) != 43 {
		t.Errorf("row = %+v", resp.Outputs[0][1].JSON)
	}

	expectPgColumns(mock, "public", "orders", "id", "status")
	mock.ExpectQuery(`SELECT *, CAST("id" AS TEXT) AS "__landflow_cursor" FROM "public"."orders" WHERE "id" IS NOT NULL ORDER BY "id" DESC LIMIT $1`).
		WithArgs("5").
		WillReturnRows(sqlmock.NewRows([]string{"id", "__landflow_cursor"}).AddRow(int64(43), "43").AddRow(int64(42), "42"))
	resp = execute(t, call{node: "postgresTrigger", creds: pgCreds, params: params, mode: landflow.ModeManual})
	if resp.Error != nil || resp.PollState != nil || num(resp.Outputs[0][0].JSON["id"]) != 42 {
		t.Errorf("manual = %+v", resp)
	}
}
