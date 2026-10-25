package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // pure-Go driver "sqlite", no cgo

	landflow "github.com/landflow/landflow/sdks/go"
)

// SQLite: a database file on the plugin's machine, opened with the pure-Go
// modernc.org/sqlite driver. The plugin can open any file its process can
// read (and write, unless "Read Only" is on); run it as a user that can only
// reach the files workflows should use.

var sqliteCredential = landflow.CredentialType{
	Name:             "sqlite",
	DisplayName:      "SQLite",
	Description:      "A SQLite database file on the plugin's machine. The plugin can open any file its process can access.",
	DocumentationURL: "https://www.sqlite.org/lang.html",
	Properties: []landflow.PropertyDescriptor{
		{Name: "path", DisplayName: "Database File", Type: landflow.PropString, Default: "", Required: true,
			Placeholder: "/var/lib/landflow/app.db",
			Description: "Path of an existing database file on the machine running the databases plugin (relative paths " +
				"start from the plugin's working directory). The plugin can open any file its process can access."},
		{Name: "readOnly", DisplayName: "Read Only", Type: landflow.PropBoolean, Default: false,
			Description: "Open the file read-only: writes fail"},
	},
	Test: func(ctx context.Context, data landflow.CredentialData) (bool, string) {
		return testSQL(ctx, sqliteDialect, data)
	},
}

var sqliteDialect = &dialect{
	system: systemSQLite, credential: "sqlite", returning: true, identQuote: `"`,
	open:     openSQLite,
	settings: func(c landflow.CredentialData) []string { return settingsOf(c.String, "path", "readOnly") },
	server: func(c landflow.CredentialData) serverInfo {
		return serverInfo{namespace: filepath.Base(c.String("path"))}
	},
	tablesQuery: "SELECT name, CASE WHEN type = 'view' THEN 'view' ELSE 'table' END FROM sqlite_master " +
		"WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
	columnsQuery: "SELECT name, type FROM pragma_table_info(?) ORDER BY cid",
}

// sqliteDSN builds the file: URI. mode=rw (or ro) means the file must
// already exist, so a typo in the path fails instead of creating an empty
// database.
func sqliteDSN(c landflow.CredentialData) (string, error) {
	path := c.String("path")
	if path == "" {
		return "", errors.New("the SQLite credential has no database file path")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "", fmt.Errorf("SQLite database file %s does not exist", abs)
	case err != nil:
		return "", err
	case info.IsDir():
		return "", fmt.Errorf("%s is a directory, not a SQLite database file", abs)
	}
	q := url.Values{"_busy_timeout": {"5000"}, "_foreign_keys": {"1"}}
	if c.Bool("readOnly", false) {
		q.Set("mode", "ro")
		q.Set("_query_only", "1")
	} else {
		q.Set("mode", "rw")
	}
	return "file:" + (&url.URL{Path: abs}).EscapedPath() + "?" + q.Encode(), nil
}

func openSQLite(c landflow.CredentialData) (*sql.DB, error) {
	dsn, err := sqliteDSN(c)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection: SQLite allows one writer anyway, and this rules out
	// SQLITE_BUSY between the plugin's own connections.
	db.SetMaxOpenConns(1)
	return db, nil
}

var sqliteNode = sqlNode{
	d: sqliteDialect, name: "sqlite", displayName: "SQLite", product: "a SQLite database file",
	icon: "file:icons/sqlite.svg", color: "#0F80CC",
	docURL:   "https://www.sqlite.org/lang.html",
	keywords: []string{"sqlite", "sql", "database", "file", "query", "rows"},
}
