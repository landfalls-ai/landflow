package main

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"strconv"
	"time"

	"github.com/go-sql-driver/mysql"

	landflow "github.com/landflow/landflow/sdks/go"
)

// MySQL: go-sql-driver/mysql through a Config struct and a Connector, so no
// DSN string (which would carry the password) is ever built.

var mysqlCredential = landflow.CredentialType{
	Name:             "mySql",
	DisplayName:      "MySQL",
	Description:      "A MySQL or MariaDB server",
	DocumentationURL: "https://dev.mysql.com/doc/refman/8.4/en/connecting.html",
	Properties: []landflow.PropertyDescriptor{
		{Name: "host", DisplayName: "Host", Type: landflow.PropString, Default: "localhost", Required: true},
		{Name: "port", DisplayName: "Port", Type: landflow.PropNumber, Default: 3306},
		{Name: "database", DisplayName: "Database", Type: landflow.PropString, Default: "", Required: true},
		{Name: "user", DisplayName: "User", Type: landflow.PropString, Default: "root", Required: true},
		{Name: "password", DisplayName: "Password", Type: landflow.PropString, Default: "",
			TypeOptions: &landflow.TypeOptions{Password: true}},
		{Name: "ssl", DisplayName: "SSL", Type: landflow.PropOptions, Default: "false", Options: []landflow.PropertyOption{
			{Name: "Off", Value: "false", Description: "Plain TCP"},
			{Name: "On", Value: "true", Description: "TLS with certificate verification"},
			{Name: "Skip Verify", Value: "skip-verify", Description: "TLS without verifying the certificate"},
		}},
		{Name: "connectTimeout", DisplayName: "Connect Timeout (s)", Type: landflow.PropNumber, Default: 10,
			TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(1.0)}},
	},
	Test: func(ctx context.Context, data landflow.CredentialData) (bool, string) {
		return testSQL(ctx, mysqlDialect, data)
	},
}

var mysqlDialect = &dialect{
	system: systemMySQL, credential: "mySql", identQuote: "`", doubleQuotedStrings: true,
	open:     openMySQL,
	settings: mysqlSettings,
	server: func(c landflow.CredentialData) serverInfo {
		return serverInfo{address: c.StringOr("host", "localhost"), port: c.Int("port", 3306), namespace: c.String("database")}
	},
	tablesQuery: "SELECT table_name AS name, CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END AS kind " +
		"FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name",
	columnsQuery: "SELECT column_name AS name, data_type AS type FROM information_schema.columns " +
		"WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position",
}

var mysqlSSLModes = map[string]bool{"false": true, "true": true, "skip-verify": true}

func mysqlSettings(c landflow.CredentialData) []string {
	return settingsOf(c.String, "host", "port", "database", "user", "password", "ssl", "connectTimeout")
}

// mysqlConfig builds the driver config. Never call FormatDSN on it: the
// result would contain the password.
func mysqlConfig(c landflow.CredentialData) (*mysql.Config, error) {
	ssl := c.StringOr("ssl", "false")
	if !mysqlSSLModes[ssl] {
		return nil, fmt.Errorf("unsupported SSL mode %q (use false, true or skip-verify)", ssl)
	}
	cfg := mysql.NewConfig()
	cfg.User = c.StringOr("user", "root")
	cfg.Passwd = c.String("password")
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(c.StringOr("host", "localhost"), strconv.Itoa(c.Int("port", 3306)))
	cfg.DBName = c.String("database")
	cfg.TLSConfig = ssl
	cfg.Timeout = connectTimeout(c)
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	return cfg, nil
}

func openMySQL(c landflow.CredentialData) (*sql.DB, error) {
	cfg, err := mysqlConfig(c)
	if err != nil {
		return nil, err
	}
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, err
	}
	db := sql.OpenDB(connector)
	tunePool(db, 10)
	return db, nil
}

var mysqlNode = sqlNode{
	d: mysqlDialect, name: "mySql", displayName: "MySQL", product: "MySQL",
	icon: "file:icons/mysql.svg", color: "#00758F",
	docURL:   "https://dev.mysql.com/doc/refman/8.4/en/sql-statements.html",
	keywords: []string{"mysql", "mariadb", "sql", "database", "query", "rows"},
}
