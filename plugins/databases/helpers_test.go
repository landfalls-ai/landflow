package main

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	landflow "github.com/landflow/landflow/sdks/go"
)

// call describes one Execute request for the test helpers.
type call struct {
	node   string
	mode   landflow.ExecutionMode
	params map[string]any
	creds  map[string]any // credential type → data
	items  []map[string]any
	state  map[string]any
	// itemParams overrides params per item (expressions resolved by the host).
	itemParams []map[string]any
	// continueOnFail is the node's "On Error: Continue" setting.
	continueOnFail bool
	// binary are the items' files by item; access is the host's binary API.
	binary []map[string]landflow.BinaryRef
	access *landflow.BinaryAccess
}

func (c call) request() *landflow.ExecuteRequest {
	mode := c.mode
	if mode == "" {
		mode = landflow.ModeManual
	}
	req := &landflow.ExecuteRequest{
		Protocol: landflow.ProtocolVersion, ExecutionID: "ex", WorkflowID: "wf", Mode: mode,
		Node:       landflow.NodeRef{ID: "n", Name: "N", Type: "databases." + c.node, TypeVersion: 1},
		Parameters: c.params, Credentials: c.creds, PollState: c.state,
		Inputs: [][]landflow.Item{{}}, ContinueOnFail: c.continueOnFail, BinaryAccess: c.access,
	}
	for i, it := range c.items {
		item := landflow.Item{JSON: it}
		if i < len(c.binary) {
			item.Binary = c.binary[i]
		}
		req.Inputs[0] = append(req.Inputs[0], item)
		p := c.params
		if i < len(c.itemParams) && c.itemParams[i] != nil {
			p = c.itemParams[i]
		}
		req.ItemParameters = append(req.ItemParameters, p)
	}
	return req
}

func execute(t *testing.T, c call) *landflow.ExecuteResponse {
	t.Helper()
	resp, err := newPlugin().Execute(context.Background(), c.request())
	if err != nil {
		t.Fatalf("%s: %v", c.node, err)
	}
	return resp
}

// ok executes c and fails the test on a node error; it returns output 0.
func ok(t *testing.T, c call) []landflow.Item {
	t.Helper()
	resp := execute(t, c)
	if resp.Error != nil {
		t.Fatalf("%s: unexpected error %+v", c.node, resp.Error)
	}
	if len(resp.Outputs) == 0 {
		return nil
	}
	return resp.Outputs[0]
}

// fails executes c and returns the node error, failing when there is none.
func fails(t *testing.T, c call) *landflow.NodeErrorPayload {
	t.Helper()
	resp := execute(t, c)
	if resp.Error == nil {
		t.Fatalf("%s: expected an error, got outputs %+v", c.node, resp.Outputs)
	}
	return resp.Error
}

// resetPools closes the cached pools after the test.
func resetPools(t *testing.T) {
	t.Helper()
	pools.closeAll()
	t.Cleanup(pools.closeAll)
}

// ---------------------------------------------------------------------------
// SQLite fixtures
// ---------------------------------------------------------------------------

const usersSchema = `
CREATE TABLE users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	email TEXT UNIQUE NOT NULL,
	name TEXT,
	age INTEGER,
	score REAL,
	balance DECIMAL(10,2),
	avatar BLOB,
	created_at DATETIME,
	meta JSON
);
INSERT INTO users (email, name, age, score, balance, avatar, created_at, meta) VALUES
	('ada@example.com', 'Ada', 36, 9.5, '10.50', x'01020304', '2026-01-02 03:04:05', '{"vip":true}'),
	('bob@example.com', 'Bob', 25, 7.25, '3', NULL, '2026-02-03 04:05:06', '{"vip":false}'),
	('cy@example.com', 'Cy', NULL, NULL, NULL, NULL, NULL, NULL);
CREATE VIEW adults AS SELECT id, name FROM users WHERE age >= 18;
`

// newSQLite creates a database file with the users table and returns the
// credential map for it.
func newSQLite(t *testing.T, schema string) (map[string]any, string) {
	t.Helper()
	resetPools(t)
	path := filepath.Join(t.TempDir(), "test.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return map[string]any{"sqlite": map[string]any{"path": path}}, path
}

// sqliteQuery reads rows straight from the file, bypassing the plugin.
func sqliteQuery(t *testing.T, path, query string, args ...any) []map[string]any {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(query, args...)
	if err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	defer rows.Close()
	out, err := scanRows(rows, systemSQLite)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// ---------------------------------------------------------------------------
// sqlmock fixtures
// ---------------------------------------------------------------------------

// withMock makes dialect d open a sqlmock database that matches SQL
// exactly, and checks every expectation was met at the end of the test.
func withMock(t *testing.T, d *dialect) sqlmock.Sqlmock {
	t.Helper()
	resetPools(t)
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherEqual))
	if err != nil {
		t.Fatal(err)
	}
	orig := d.open
	d.open = func(landflow.CredentialData) (*sql.DB, error) { return db, nil }
	t.Cleanup(func() {
		d.open = orig
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Errorf("sqlmock: %v", err)
		}
	})
	return mock
}

func num(v any) float64 {
	switch t := v.(type) {
	case int64:
		return float64(t)
	case float64:
		return t
	case int:
		return float64(t)
	}
	return -1
}
