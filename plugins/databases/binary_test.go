package main

import (
	"bytes"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	landflow "github.com/landflow/landflow/sdks/go"
)

// hostStore is a fake host binary API (GET /api/binary/{id}, POST /api/binary).
func hostStore(t *testing.T, files map[string][]byte) (*landflow.BinaryAccess, map[string][]byte) {
	stored := map[string][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			data, _ := io.ReadAll(r.Body)
			id := "ex_1.s" + string(rune('a'+len(stored)))
			stored[id] = data
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"` + id + `","mimeType":"` + r.Header.Get("Content-Type") + `","fileSize":` + string(rune('0'+len(data)%10)) + `}`))
			return
		}
		data, ok := files[strings.TrimPrefix(r.URL.Path, "/api/binary/")]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(srv.Close)
	return &landflow.BinaryAccess{URL: srv.URL + "/api/binary", Token: "tok"}, stored
}

// unb64 decodes a column scanRows returned as base64.
func unb64(v any) []byte {
	b, _ := base64.StdEncoding.DecodeString(v.(string))
	return b
}

func inline(name string, data []byte) landflow.BinaryRef {
	return landflow.BinaryRef{FileName: name, FileSize: int64(len(data)), Data: base64.StdEncoding.EncodeToString(data)}
}

func TestSQLiteBinaryColumns(t *testing.T) {
	creds, path := newSQLite(t, usersSchema)
	png := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0xff}
	big := bytes.Repeat([]byte{0xAA, 0x55}, landflow.MaxInlineBinaryBytes)
	access, stored := hostStore(t, map[string][]byte{"ex_1.big": big})

	// Insert: a column takes the bytes of a binary property; JSON never carries them.
	items := ok(t, call{node: "sqlite", creds: creds, access: access,
		items:  []map[string]any{{"email": "dee@example.com", "name": "Dee"}, {"email": "eve@example.com", "name": "Eve"}},
		binary: []map[string]landflow.BinaryRef{{"photo": inline("dee.png", png)}, {"photo": {ID: "ex_1.big", FileName: "eve.bin", FileSize: int64(len(big))}}},
		params: map[string]any{"operation": "insert", "table": "users", "options": map[string]any{"returnRows": false},
			"binaryOptions": map[string]any{"inputColumns": "avatar=photo"}},
	})
	if len(items) != 2 || items[0].JSON["avatar"] != nil || items[0].JSON["name"] != "Dee" {
		t.Fatalf("insert items = %+v", items)
	}
	rows := sqliteQuery(t, path, "SELECT name, avatar FROM users WHERE email IN ('dee@example.com','eve@example.com') ORDER BY name")
	if !bytes.Equal(unb64(rows[0]["avatar"]), png) || !bytes.Equal(unb64(rows[1]["avatar"]), big) {
		t.Errorf("stored avatars: %d and %d bytes", len(unb64(rows[0]["avatar"])), len(unb64(rows[1]["avatar"])))
	}

	// Update from a bare column name (the property has the same name).
	ok(t, call{node: "sqlite", creds: creds, access: access, items: []map[string]any{{"email": "bob@example.com"}},
		binary: []map[string]landflow.BinaryRef{{"avatar": inline("bob.bin", []byte{9, 8, 7})}},
		params: map[string]any{"operation": "update", "table": "users", "columnToMatchOn": "email", "options": map[string]any{"returnRows": false},
			"binaryOptions": map[string]any{"inputColumns": "avatar"}}})
	if got := sqliteQuery(t, path, "SELECT avatar FROM users WHERE name = 'Bob'"); !bytes.Equal(unb64(got[0]["avatar"]), []byte{9, 8, 7}) {
		t.Errorf("updated avatar = %v", got[0]["avatar"])
	}

	// Select: the BLOB becomes a file named from another column (type sniffed); rows without bytes have none.
	out := ok(t, call{node: "sqlite", creds: creds, access: access, items: []map[string]any{{}},
		params: map[string]any{"operation": "select", "table": "users", "returnAll": true,
			"sort":          map[string]any{"values": []any{map[string]any{"column": "id", "direction": "ASC"}}},
			"binaryOptions": map[string]any{"outputColumns": "avatar=photo", "fileNameColumn": "name"}}})
	if len(out) != 5 {
		t.Fatalf("rows = %d", len(out))
	}
	ada := out[0]
	if _, still := ada.JSON["avatar"]; still || ada.Binary["photo"].FileName != "Ada" || ada.Binary["photo"].MimeType != "application/octet-stream" {
		t.Errorf("ada = %+v", ada)
	}
	if data, _ := base64.StdEncoding.DecodeString(ada.Binary["photo"].Data); !bytes.Equal(data, []byte{1, 2, 3, 4}) {
		t.Errorf("ada photo = %v", data)
	}
	var dee, eve landflow.Item
	for _, it := range out {
		switch it.JSON["name"] {
		case "Dee":
			dee = it
		case "Eve":
			eve = it
		}
	}
	if dee.Binary["photo"].MimeType != "image/png" {
		t.Errorf("dee mime = %q", dee.Binary["photo"].MimeType)
	}
	if ref := eve.Binary["photo"]; ref.ID == "" || !bytes.Equal(stored[ref.ID], big) {
		t.Errorf("eve photo = %+v (stored %d bytes)", ref, len(stored[ref.ID]))
	}
	for _, it := range out {
		if it.JSON["name"] == "Cy" && len(it.Binary) != 0 {
			t.Errorf("a NULL column produced a file: %+v", it.Binary)
		}
	}

	// Execute Query with a result column alias, case-insensitively.
	q := ok(t, call{node: "sqlite", creds: creds, access: access, items: []map[string]any{{}},
		params: map[string]any{"operation": "executeQuery", "query": "SELECT avatar AS Doc FROM users WHERE name = 'Ada'",
			"binaryOptions": map[string]any{"outputColumns": "doc"}}})
	if len(q) != 1 || q[0].Binary["doc"].FileSize != 4 || len(q[0].JSON) != 0 {
		t.Errorf("query items = %+v", q)
	}

	// Errors name the problem.
	e := fails(t, call{node: "sqlite", creds: creds, access: access, items: []map[string]any{{"email": "z@example.com"}},
		params: map[string]any{"operation": "insert", "table": "users", "binaryOptions": map[string]any{"inputColumns": "avatar=nope"}}})
	if !strings.Contains(e.Message, `no binary file "nope"`) {
		t.Errorf("missing property error = %+v", e)
	}
	e = fails(t, call{node: "sqlite", creds: creds, access: access, items: []map[string]any{{}},
		params: map[string]any{"operation": "select", "table": "users", "binaryOptions": map[string]any{"outputColumns": "ghost"}}})
	if !strings.Contains(e.Message, `no column "ghost"`) {
		t.Errorf("missing column error = %+v", e)
	}
}

// A bytea column round-trips through binary files on a real Postgres
// (LANDFLOW_INTEGRATION=postgres go test -run IntegrationPostgresBinary .).
func TestIntegrationPostgresBinary(t *testing.T) {
	creds, _, db, schema := pgIntegration(t)
	execAll(t, db, `CREATE TABLE `+schema+`.docs (id int PRIMARY KEY, name text, body bytea)`)
	pdf := append([]byte("%PDF-1.4 "), 0, 1, 2, 0xfe, 0xff)
	access, _ := hostStore(t, nil)
	ok(t, call{node: "postgres", creds: creds, access: access, items: []map[string]any{{"id": 1, "name": "invoice.pdf"}},
		binary: []map[string]landflow.BinaryRef{{"file": inline("invoice.pdf", pdf)}},
		params: map[string]any{"operation": "insert", "schema": schema, "table": "docs",
			"binaryOptions": map[string]any{"inputColumns": "body=file", "outputColumns": "body=copy", "fileNameColumn": "name"}}})
	out := ok(t, call{node: "postgres", creds: creds, access: access, items: []map[string]any{{}},
		params: map[string]any{"operation": "select", "schema": schema, "table": "docs", "returnAll": true,
			"binaryOptions": map[string]any{"outputColumns": "body=copy", "fileNameColumn": "name"}}})
	if len(out) != 1 {
		t.Fatalf("rows = %+v", out)
	}
	ref := out[0].Binary["copy"]
	if data, _ := base64.StdEncoding.DecodeString(ref.Data); ref.FileName != "invoice.pdf" || ref.MimeType != "application/pdf" || !bytes.Equal(data, pdf) {
		t.Errorf("copy = %+v (%q)", ref, data)
	}
}
