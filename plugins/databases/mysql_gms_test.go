package main

import (
	"context"
	"io"
	"net"
	"strings"
	"testing"

	sqle "github.com/dolthub/go-mysql-server"
	"github.com/dolthub/go-mysql-server/memory"
	"github.com/dolthub/go-mysql-server/server"
	gmssql "github.com/dolthub/go-mysql-server/sql"
	"github.com/go-sql-driver/mysql"
	"github.com/sirupsen/logrus"

	landflow "github.com/landflow/landflow/sdks/go"
)

// MySQL end to end: the node, the real go-sql-driver connector and the
// credential test against go-mysql-server, an in-process MySQL-compatible
// server (no MySQL installation or container needed).

func startMySQL(t *testing.T) map[string]any {
	t.Helper()
	resetPools(t)
	logrus.SetOutput(io.Discard)
	_ = mysql.SetLogger(log0{})
	db := memory.NewDatabase("shop")
	db.BaseDatabase.EnablePrimaryKeyIndexes()
	pro := memory.NewDBProvider(db)
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := lis.Addr().(*net.TCPAddr)
	lis.Close()
	srv, err := server.NewServer(server.Config{Protocol: "tcp", Address: addr.String()}, sqle.NewDefault(pro), gmssql.NewContext, memory.NewSessionBuilder(pro), nil)
	if err != nil {
		t.Fatal(err)
	}
	go srv.Start()
	t.Cleanup(func() { srv.Close() })

	creds := landflow.CredentialData{"host": "127.0.0.1", "port": float64(addr.Port), "database": "shop", "user": "root", "password": ""}
	conn, err := openMySQL(creds)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	for _, s := range []string{
		"CREATE TABLE products (id INT PRIMARY KEY AUTO_INCREMENT, sku VARCHAR(20) UNIQUE, name VARCHAR(100), price DECIMAL(10,2), stock INT, added DATETIME)",
		"INSERT INTO products (sku, name, price, stock, added) VALUES ('A-1', 'Anvil', 19.99, 3, '2026-01-02 03:04:05'), ('B-2', 'Bolt', 0.25, 500, NULL)",
	} {
		if _, err := conn.Exec(s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
	return map[string]any{"mySql": map[string]any(creds)}
}

type log0 struct{}

func (log0) Print(...any) {}

func TestMySQLEndToEnd(t *testing.T) {
	creds := startMySQL(t)
	data := landflow.CredentialData(creds["mySql"].(map[string]any))
	if ok, msg := mysqlCredential.Test(context.Background(), data); !ok {
		t.Fatalf("credential test = %v %q", ok, msg)
	}

	// Pickers through information_schema.
	resp, err := newPlugin().LoadOptions(context.Background(), &landflow.LoadOptionsRequest{NodeType: "databases.mySql", Method: "getColumns",
		Parameters: map[string]any{"table": "products"}, Credentials: creds})
	if err != nil || len(resp.Options) != 6 || resp.Options[1].Value != "sku" {
		t.Fatalf("columns = %+v %v", resp, err)
	}
	if resp, err := newPlugin().LoadOptions(context.Background(), &landflow.LoadOptionsRequest{NodeType: "databases.mySql", Method: "getTables", Credentials: creds}); err != nil || len(resp.Options) != 1 || resp.Options[0].Value != "products" {
		t.Errorf("tables = %+v %v", resp, err)
	}

	// Select with conversion: DECIMAL → string, DATETIME → RFC 3339, INT → number.
	rows := ok(t, call{node: "mySql", creds: creds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "select", "table": "products", "where": where([3]any{"price", ">", "1"})}})
	if len(rows) != 1 || rows[0].JSON["name"] != "Anvil" || rows[0].JSON["price"] != "19.99" ||
		rows[0].JSON["added"] != "2026-01-02T03:04:05Z" || num(rows[0].JSON["stock"]) != 3 {
		t.Errorf("select = %+v", rows)
	}

	// Insert (written values), upsert on the unique key, update, delete.
	rows = ok(t, call{node: "mySql", creds: creds, params: map[string]any{"operation": "insert", "table": "products"},
		items: []map[string]any{{"sku": "C-3", "name": "Cog", "price": 2.5, "stock": 10.0, "colour": "ignored"}}})
	if len(rows) != 1 || rows[0].JSON["sku"] != "C-3" {
		t.Errorf("insert = %+v", rows)
	}
	ok(t, call{node: "mySql", creds: creds, params: map[string]any{"operation": "upsert", "table": "products", "columnsToMatchOn": "sku"},
		items: []map[string]any{{"sku": "A-1", "name": "Anvil XL", "stock": 4.0}, {"sku": "D-4", "name": "Drill", "stock": 1.0}}})
	rows = ok(t, call{node: "mySql", creds: creds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "executeQuery", "query": "SELECT sku, name, stock FROM products WHERE sku IN (?, ?) ORDER BY sku",
		"options": map[string]any{"queryReplacement": "A-1, D-4"}}})
	if len(rows) != 2 || rows[0].JSON["name"] != "Anvil XL" || num(rows[0].JSON["stock"]) != 4 || rows[1].JSON["name"] != "Drill" {
		t.Errorf("after upsert = %+v", rows)
	}
	rows = ok(t, call{node: "mySql", creds: creds, params: map[string]any{"operation": "update", "table": "products", "columnToMatchOn": "sku"},
		items: []map[string]any{{"sku": "B-2", "stock": 499.0}}})
	if num(rows[0].JSON["affectedRows"]) != 1 {
		t.Errorf("update = %+v", rows)
	}
	e := fails(t, call{node: "mySql", creds: creds, items: []map[string]any{{}}, params: map[string]any{"operation": "deleteTable", "table": "products"}})
	if !strings.Contains(e.Message, "Refusing") {
		t.Errorf("delete guard = %+v", e)
	}
	rows = ok(t, call{node: "mySql", creds: creds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "deleteTable", "table": "products", "where": where([3]any{"stock", "<", "2"})}})
	if num(rows[0].JSON["affectedRows"]) != 1 {
		t.Errorf("delete = %+v", rows)
	}

	// The server's error message reaches the node error.
	e = fails(t, call{node: "mySql", creds: creds, items: []map[string]any{{}}, params: map[string]any{"operation": "executeQuery", "query": "SELECT * FROM nope"}})
	if !strings.Contains(strings.ToLower(e.Message), "nope") {
		t.Errorf("server error = %+v", e)
	}

	// A wrong database name fails the credential test with the server's reason.
	bad := landflow.CredentialData{}
	for k, v := range data {
		bad[k] = v
	}
	bad["database"] = "missing_db"
	if ok, msg := mysqlCredential.Test(context.Background(), bad); ok || msg == "" {
		t.Errorf("bad database = %v %q", ok, msg)
	}
}
