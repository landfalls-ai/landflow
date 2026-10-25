package main

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Postgres: pgx through database/sql. The connection string handed to pgx
// never contains the password; it is set on the parsed config instead.

var postgresCredential = landflow.CredentialType{
	Name:             "postgres",
	DisplayName:      "Postgres",
	Description:      "A PostgreSQL server (also Supabase, Neon, RDS, CockroachDB…)",
	DocumentationURL: "https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-PARAMKEYWORDS",
	Properties: []landflow.PropertyDescriptor{
		{Name: "host", DisplayName: "Host", Type: landflow.PropString, Default: "localhost", Required: true},
		{Name: "port", DisplayName: "Port", Type: landflow.PropNumber, Default: 5432},
		{Name: "database", DisplayName: "Database", Type: landflow.PropString, Default: "postgres", Required: true},
		{Name: "user", DisplayName: "User", Type: landflow.PropString, Default: "postgres", Required: true},
		{Name: "password", DisplayName: "Password", Type: landflow.PropString, Default: "",
			TypeOptions: &landflow.TypeOptions{Password: true}},
		{Name: "ssl", DisplayName: "SSL", Type: landflow.PropOptions, Default: "disable", Options: []landflow.PropertyOption{
			{Name: "Disable", Value: "disable", Description: "Plain TCP"},
			{Name: "Allow", Value: "allow", Description: "Try plain TCP first, then TLS"},
			{Name: "Require", Value: "require", Description: "TLS without verifying the certificate"},
			{Name: "Verify (Full)", Value: "verify-full", Description: "TLS with certificate and host name verification"},
		}},
		{Name: "connectTimeout", DisplayName: "Connect Timeout (s)", Type: landflow.PropNumber, Default: 10,
			TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(1.0)}},
	},
	Test: func(ctx context.Context, data landflow.CredentialData) (bool, string) {
		return testSQL(ctx, postgresDialect, data)
	},
}

var postgresDialect = &dialect{
	system: systemPostgres, credential: "postgres", hasSchemas: true, returning: true,
	dollarParams: true, identQuote: `"`,
	open:     openPostgres,
	settings: postgresSettings,
	server: func(c landflow.CredentialData) serverInfo {
		return serverInfo{address: c.StringOr("host", "localhost"), port: c.Int("port", 5432), namespace: c.StringOr("database", "postgres")}
	},
	schemasQuery: "SELECT schema_name, '' FROM information_schema.schemata " +
		"WHERE schema_name NOT IN ('pg_catalog', 'information_schema') AND schema_name NOT LIKE 'pg\\_toast%' " +
		"AND schema_name NOT LIKE 'pg\\_temp%' ORDER BY schema_name",
	tablesQuery: "SELECT table_name, CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END " +
		"FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
	columnsQuery: "SELECT column_name, data_type FROM information_schema.columns " +
		"WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
}

var postgresSSLModes = map[string]bool{"disable": true, "allow": true, "require": true, "verify-full": true}

func postgresSettings(c landflow.CredentialData) []string {
	return settingsOf(c.String, "host", "port", "database", "user", "password", "ssl", "connectTimeout")
}

// postgresConfig builds the pgx config: a URL without the password, parsed,
// then the password set on the struct.
func postgresConfig(c landflow.CredentialData) (*pgx.ConnConfig, error) {
	ssl := c.StringOr("ssl", "disable")
	if !postgresSSLModes[ssl] {
		return nil, fmt.Errorf("unsupported SSL mode %q (use disable, allow, require or verify-full)", ssl)
	}
	u := url.URL{
		Scheme:   "postgres",
		User:     url.User(c.StringOr("user", "postgres")),
		Host:     net.JoinHostPort(c.StringOr("host", "localhost"), strconv.Itoa(c.Int("port", 5432))),
		Path:     "/" + c.StringOr("database", "postgres"),
		RawQuery: url.Values{"sslmode": {ssl}, "connect_timeout": {strconv.Itoa(int(connectTimeout(c).Seconds()))}}.Encode(),
	}
	cfg, err := pgx.ParseConfig(u.String())
	if err != nil {
		return nil, err
	}
	cfg.Password = c.String("password")
	return cfg, nil
}

func openPostgres(c landflow.CredentialData) (*sql.DB, error) {
	cfg, err := postgresConfig(c)
	if err != nil {
		return nil, err
	}
	db := stdlib.OpenDB(*cfg)
	tunePool(db, 10)
	return db, nil
}

// connectTimeout reads the credential's connect timeout (default 10 s).
func connectTimeout(c landflow.CredentialData) time.Duration {
	s := c.Int("connectTimeout", 10)
	if s <= 0 {
		s = 10
	}
	return time.Duration(s) * time.Second
}

// tunePool sets the pool limits shared by the networked databases.
func tunePool(db *sql.DB, maxOpen int) {
	db.SetMaxOpenConns(maxOpen)
	db.SetMaxIdleConns(2)
	db.SetConnMaxIdleTime(5 * time.Minute)
	db.SetConnMaxLifetime(time.Hour)
}

var postgresNode = sqlNode{
	d: postgresDialect, name: "postgres", displayName: "Postgres", product: "PostgreSQL",
	icon: "file:icons/postgres.svg", color: "#336791",
	docURL:   "https://www.postgresql.org/docs/current/sql-commands.html",
	keywords: []string{"postgresql", "sql", "database", "supabase", "query", "rows"},
}
