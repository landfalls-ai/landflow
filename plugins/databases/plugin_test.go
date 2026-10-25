package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	landflow "github.com/landflow/landflow/sdks/go"
)

func TestManifest(t *testing.T) {
	m := newPlugin().Manifest()
	const svg = "data:image/svg+xml;base64,"
	if m.Plugin.ID != "databases" || m.Plugin.Name != "Databases" || m.Plugin.Language != "go" || !strings.HasPrefix(m.Plugin.Icon, svg) {
		t.Errorf("plugin = %.200v", m.Plugin)
	}
	want := map[string]struct {
		cred    string
		trigger bool
		color   string
	}{
		"postgres": {"postgres", false, "#336791"}, "mySql": {"mySql", false, "#00758F"}, "sqlite": {"sqlite", false, "#0F80CC"},
		"redis": {"redis", false, "#DC382D"}, "postgresTrigger": {"postgres", true, "#336791"}, "sqliteTrigger": {"sqlite", true, "#0F80CC"},
	}
	if len(m.Nodes) != len(want) {
		t.Errorf("%d nodes", len(m.Nodes))
	}
	for _, d := range m.Nodes {
		w, ok := want[d.Name]
		if !ok {
			t.Errorf("unexpected node %q", d.Name)
			continue
		}
		if !strings.HasPrefix(d.Icon, svg) || d.Color != w.color || d.DocumentationURL == "" ||
			strings.Join(d.Categories, ",") != "Data & Storage,Development" {
			t.Errorf("%s branding = icon %.30q color %s doc %q categories %v", d.Name, d.Icon, d.Color, d.DocumentationURL, d.Categories)
		}
		if len(d.Credentials) != 1 || d.Credentials[0].Name != w.cred || !d.Credentials[0].Required {
			t.Errorf("%s credentials = %+v", d.Name, d.Credentials)
		}
		if w.trigger {
			if d.Kind != landflow.KindTrigger || d.TriggerSource != landflow.TriggerPoll || d.UsableAsTool {
				t.Errorf("%s trigger = %s/%s", d.Name, d.Kind, d.TriggerSource)
			}
			hasInterval := false
			for _, p := range d.Properties {
				hasInterval = hasInterval || p.Name == landflow.PollIntervalName
			}
			if !hasInterval {
				t.Errorf("%s has no pollInterval", d.Name)
			}
		} else if !d.UsableAsTool || d.ToolDescription == "" {
			t.Errorf("%s must be usable as a tool", d.Name)
		}
	}
	creds := map[string]landflow.CredentialTypeDescriptor{}
	for _, c := range m.CredentialTypes {
		creds[c.Name] = c
	}
	for _, name := range []string{"postgres", "mySql", "redis", "sqlite"} {
		c, ok := creds[name]
		if !ok || !c.Testable {
			t.Errorf("credential type %s = %+v", name, c)
		}
		for _, p := range c.Properties {
			if p.Name == "password" && (p.TypeOptions == nil || !p.TypeOptions.Password) {
				t.Errorf("%s.password must be a password field", name)
			}
		}
	}
	data, _ := json.Marshal(m)
	if strings.Contains(string(data), "file:icons") {
		t.Error("manifest must not leak file: icons")
	}
}

func TestSQLCredentialTests(t *testing.T) {
	_, path := newSQLite(t, usersSchema)
	if ok, msg := sqliteCredential.Test(context.Background(), landflow.CredentialData{"path": path}); !ok {
		t.Errorf("sqlite = %v %q", ok, msg)
	}
	if ok, msg := sqliteCredential.Test(context.Background(), landflow.CredentialData{"path": path + ".missing"}); ok || !strings.Contains(msg, "does not exist") {
		t.Errorf("missing sqlite file = %v %q", ok, msg)
	}
	// Nothing listens on port 1: both fail fast with the driver's reason and
	// never echo the password.
	for name, test := range map[string]func(context.Context, landflow.CredentialData) (bool, string){
		"postgres": postgresCredential.Test, "mySql": mysqlCredential.Test,
	} {
		start := time.Now()
		ok, msg := test(context.Background(), landflow.CredentialData{
			"host": "127.0.0.1", "port": 1.0, "database": "x", "user": "u", "password": "hunter2-secret", "connectTimeout": 2.0,
		})
		if ok || msg == "" || strings.Contains(msg, "hunter2") || time.Since(start) > 5*time.Second {
			t.Errorf("%s = %v %q after %v", name, ok, msg, time.Since(start))
		}
	}
	if ok, msg := postgresCredential.Test(context.Background(), landflow.CredentialData{"host": "h", "ssl": "bogus"}); ok || !strings.Contains(msg, "SSL mode") {
		t.Errorf("bad ssl = %v %q", ok, msg)
	}
}

func TestPoolCache(t *testing.T) {
	c := newPoolCache(time.Minute)
	defer c.shutdown()
	opened := 0
	open := func() (*sql.DB, error) {
		opened++
		return sql.Open("sqlite", "file::memory:")
	}
	a := settingsOf(landflow.CredentialData{"path": "/a", "readOnly": false}.String, "path", "readOnly")
	b := settingsOf(landflow.CredentialData{"path": "/a", "readOnly": true}.String, "path", "readOnly")
	db1, rel1, _ := c.sqlDB(sqliteDialect, a, open)
	db2, rel2, _ := c.sqlDB(sqliteDialect, a, open)
	db3, rel3, _ := c.sqlDB(sqliteDialect, b, open)
	if db1 != db2 || db1 == db3 || opened != 2 || c.size() != 2 {
		t.Errorf("same settings must share a pool: opened %d, size %d", opened, c.size())
	}
	if poolKey("postgresql", []string{"password=a"}) == poolKey("postgresql", []string{"password=b"}) {
		t.Error("a changed password must give a new pool")
	}
	if strings.Contains(poolKey("postgresql", []string{"password=hunter2"}), "hunter2") {
		t.Error("pool keys are hashes")
	}
	// Pools in use are never evicted; idle ones are.
	rel3()
	if n := c.evictIdle(time.Now().Add(time.Hour)); n != 1 || c.size() != 1 {
		t.Errorf("evicted %d, size %d", n, c.size())
	}
	rel1()
	rel1() // release is idempotent
	if n := c.evictIdle(time.Now().Add(time.Hour)); n != 0 {
		t.Errorf("evicted a pool still held: %d", n)
	}
	rel2()
	if n := c.evictIdle(time.Now().Add(-time.Hour)); n != 0 {
		t.Error("a recently used pool must stay")
	}
	if n := c.evictIdle(time.Now().Add(time.Hour)); n != 1 || c.size() != 0 {
		t.Errorf("idle pool not evicted: %d", n)
	}
	if err := db1.Ping(); err == nil {
		t.Error("evicted pool must be closed")
	}
	c.sqlDB(sqliteDialect, a, open)
	c.closeAll()
	if c.size() != 0 {
		t.Error("closeAll")
	}
}

// Spans and metrics of a run: DB spans per statement with the parameterised
// statement only, the db.transaction span, and the landflow.db.* metrics.
func TestTelemetry(t *testing.T) {
	creds, _ := newSQLite(t, usersSchema+eventsSchema)
	p := newPlugin()
	rec := tracetest.NewSpanRecorder()
	reader := sdkmetric.NewManualReader()
	var logs bytes.Buffer
	tel, err := p.SetupTelemetry(context.Background(), landflow.TelemetryOptions{
		SpanProcessors: []sdktrace.SpanProcessor{rec}, MetricReaders: []sdkmetric.Reader{reader}, LogWriter: &logs, NoOTLP: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer tel.Shutdown(context.Background())
	run := func(c call) *landflow.ExecuteResponse {
		t.Helper()
		resp, err := p.Execute(context.Background(), c.request())
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	run(call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{
		"operation": "select", "table": "users", "where": where([3]any{"email", "equal", "ada@example.com"})}})
	tx := func(email string) map[string]any {
		return map[string]any{"operation": "executeQuery", "query": "INSERT INTO users (email, name) VALUES (?, 'Literal Name')",
			"options": map[string]any{"queryBatching": "transaction", "queryReplacement": email}}
	}
	run(call{node: "sqlite", creds: creds, items: []map[string]any{{}, {}}, params: tx("t1@example.com"), itemParams: []map[string]any{tx("t1@example.com"), tx("t2@example.com")}})
	run(call{node: "sqlite", creds: creds, items: []map[string]any{{}}, params: map[string]any{"operation": "executeQuery", "query": "SELECT * FROM missing"}})
	trig := map[string]any{"table": "events", "trackingColumn": "id"}
	run(call{node: "sqliteTrigger", creds: creds, params: trig, mode: landflow.ModePoll, state: map[string]any{"lastValue": "5"}})

	spans := map[string][]sdktrace.ReadOnlySpan{}
	for _, s := range rec.Ended() {
		spans[s.Name()] = append(spans[s.Name()], s)
	}
	attr := func(s sdktrace.ReadOnlySpan, key string) string {
		for _, kv := range s.Attributes() {
			if string(kv.Key) == key {
				return kv.Value.Emit()
			}
		}
		return ""
	}
	sel := spans["SELECT users"]
	if len(sel) != 1 || attr(sel[0], "db.system") != "sqlite" || attr(sel[0], "db.collection.name") != "users" ||
		attr(sel[0], "db.query.text") != `SELECT * FROM "users" WHERE "email" = ? LIMIT ?` || attr(sel[0], "db.namespace") != "test.db" {
		t.Errorf("SELECT users spans = %d %v", len(sel), sel)
	}
	for _, s := range rec.Ended() {
		for _, kv := range s.Attributes() {
			if strings.Contains(kv.Value.Emit(), "ada@example.com") || strings.Contains(kv.Value.Emit(), "Literal Name") || strings.Contains(kv.Value.Emit(), "t1@example.com") {
				t.Errorf("span %s attribute %s carries a value: %s", s.Name(), kv.Key, kv.Value.Emit())
			}
		}
	}
	txs := spans["db.transaction"]
	if len(txs) != 1 || attr(txs[0], "landflow.statements") != "2" {
		t.Fatalf("db.transaction spans = %v", txs)
	}
	inserts := spans["INSERT"]
	if len(inserts) != 2 || inserts[0].Parent().SpanID() != txs[0].SpanContext().SpanID() ||
		attr(inserts[0], "db.query.text") != "INSERT INTO users (email, name) VALUES (?, ?)" {
		t.Errorf("INSERT spans = %v", inserts)
	}
	if failed := spans["SELECT"]; len(failed) != 1 || failed[0].Status().Code.String() != "Error" {
		t.Errorf("failed SELECT span = %v", failed)
	}

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	type point struct {
		attrs map[string]string
		value float64
	}
	metrics := map[string][]point{}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			switch data := m.Data.(type) {
			case metricdata.Sum[float64]:
				for _, dp := range data.DataPoints {
					metrics[m.Name] = append(metrics[m.Name], point{attrMap(dp.Attributes.ToSlice()), dp.Value})
				}
			case metricdata.Gauge[float64]:
				for _, dp := range data.DataPoints {
					metrics[m.Name] = append(metrics[m.Name], point{attrMap(dp.Attributes.ToSlice()), dp.Value})
				}
			case metricdata.Histogram[float64]:
				for _, dp := range data.DataPoints {
					metrics[m.Name] = append(metrics[m.Name], point{attrMap(dp.Attributes.ToSlice()), float64(dp.Count)})
				}
			}
		}
	}
	find := func(name string, match map[string]string) float64 {
		total := 0.0
		for _, p := range metrics[name] {
			okay := true
			for k, v := range match {
				okay = okay && p.attrs[k] == v
			}
			if okay {
				total += p.value
			}
		}
		return total
	}
	if find("landflow.db.query.duration", map[string]string{"db.system": "sqlite", "operation": "INSERT"}) != 2 {
		t.Errorf("query.duration INSERT = %v", metrics["landflow.db.query.duration"])
	}
	if find("landflow.db.rows", map[string]string{"db.system": "sqlite", "operation": "INSERT", "direction": "written"}) != 2 {
		t.Errorf("rows written = %v", metrics["landflow.db.rows"])
	}
	if find("landflow.db.rows", map[string]string{"operation": "SELECT", "direction": "read"}) < 1 {
		t.Errorf("rows read = %v", metrics["landflow.db.rows"])
	}
	if find("landflow.db.errors", map[string]string{"db.system": "sqlite", "operation": "SELECT"}) != 1 {
		t.Errorf("errors = %v", metrics["landflow.db.errors"])
	}
	if find("landflow.db.poll.new_rows", map[string]string{"db.system": "sqlite"}) != 2 {
		t.Errorf("poll.new_rows = %v", metrics["landflow.db.poll.new_rows"])
	}
	if len(metrics["landflow.db.pool.connections"]) == 0 || find("landflow.db.pool.connections", map[string]string{"state": "idle"}) < 0 {
		t.Errorf("pool gauge = %v", metrics["landflow.db.pool.connections"])
	}
	for name, points := range metrics {
		if !strings.HasPrefix(name, "landflow.db.") {
			continue
		}
		for _, p := range points {
			for k := range p.attrs {
				if strings.Contains(k, "collection") || strings.Contains(k, "table") {
					t.Errorf("%s has high-cardinality attribute %s", name, k)
				}
			}
		}
	}
}

func attrMap(kvs []attribute.KeyValue) map[string]string {
	out := map[string]string{}
	for _, kv := range kvs {
		out[string(kv.Key)] = kv.Value.Emit()
	}
	return out
}
