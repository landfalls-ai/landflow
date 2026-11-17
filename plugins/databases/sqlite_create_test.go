package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// AG06: Create If Missing on the SQLite credential.

func selectMaster() map[string]any {
	return map[string]any{"operation": "executeQuery", "query": "SELECT name FROM sqlite_master"}
}

func TestCreateIfMissingMakesTheFile(t *testing.T) {
	resetPools(t)
	path := filepath.Join(t.TempDir(), "new.db")
	creds := map[string]any{"sqlite": map[string]any{"path": path, "createIfMissing": true}}
	ok(t, call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: selectMaster()})
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the file was not created: %v", err)
	}
}

func TestCreateIfMissingCredentialTest(t *testing.T) {
	resetPools(t)
	dir := t.TempDir()
	on := filepath.Join(dir, "on.db")
	if good, msg := testSQL(context.Background(), sqliteDialect, map[string]any{"path": on, "createIfMissing": true}); !good {
		t.Fatalf("test with the option on failed: %s", msg)
	}
	if _, err := os.Stat(on); err != nil {
		t.Errorf("the credential test did not create the file: %v", err)
	}
	off := filepath.Join(dir, "off.db")
	good, msg := testSQL(context.Background(), sqliteDialect, map[string]any{"path": off})
	if good || !strings.Contains(msg, "Create If Missing") {
		t.Errorf("without the option = %v %q", good, msg)
	}
	if _, err := os.Stat(off); err == nil {
		t.Error("the file was created without the option")
	}
}

func TestCreateIfMissingErrors(t *testing.T) {
	resetPools(t)
	dir := t.TempDir()
	run := func(cred map[string]any) string {
		return fails(t, call{node: "sqlite", creds: map[string]any{"sqlite": cred}, items: []map[string]any{{}}, params: selectMaster()}).Message
	}
	if m := run(map[string]any{"path": filepath.Join(dir, "a.db")}); !strings.Contains(m, "Create If Missing") {
		t.Errorf("without the option = %q", m)
	}
	if m := run(map[string]any{"path": filepath.Join(dir, "b.db"), "createIfMissing": true, "readOnly": true}); !strings.Contains(m, "cannot be combined with Read Only") {
		t.Errorf("with read only = %q", m)
	}
	missing := filepath.Join(dir, "nofolder")
	if m := run(map[string]any{"path": filepath.Join(missing, "c.db"), "createIfMissing": true}); !strings.Contains(m, missing) {
		t.Errorf("missing folder = %q", m)
	}
}
