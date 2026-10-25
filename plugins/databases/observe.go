package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Spans and metrics shared by every database (docs/observability.md):
//
//	span   "{operation} {table}" (client) per statement / command, via ctx.DBSpan
//	span   "db.transaction" around a transaction batch, with landflow.statements
//	metric landflow.db.query.duration (ms)   db.system, operation
//	metric landflow.db.rows                  db.system, operation, direction=read|written
//	metric landflow.db.errors                db.system, operation
//	metric landflow.db.pool.connections      db.system, state=in_use|idle
//	metric landflow.db.poll.new_rows         db.system
//
// Metric attributes stay low-cardinality: no table names, keys or ids.

// callContext is what a session runs in: an *ExecuteContext or a
// *LoadOptionsContext (both are context.Contexts that open DB spans and
// carry the metrics API).
type callContext interface {
	context.Context
	dbSpanner
	Metrics() *landflow.Metrics
}

// dbSpanner opens DB client spans: the call contexts and landflow.Span.
type dbSpanner interface {
	DBSpan(info landflow.DBSpanInfo, fn func(span landflow.Span) error) error
}

// observer records spans and metrics for one call against one database.
type observer struct {
	system  string
	server  serverInfo
	metrics *landflow.Metrics
}

// do runs fn inside a DB span and records the query metrics. fn reports the
// rows it read (returned) and wrote (affected).
func (o *observer) do(parent dbSpanner, op, collection, statement string, fn func(span landflow.Span) (read, written int64, err error)) error {
	start := time.Now()
	var read, written int64
	err := parent.DBSpan(landflow.DBSpanInfo{
		System: o.system, Operation: op, Collection: collection, Namespace: o.server.namespace,
		Statement: statement, ServerAddress: o.server.address, ServerPort: o.server.port,
	}, func(span landflow.Span) error {
		var err error
		read, written, err = fn(span)
		if read > 0 {
			span.SetAttribute("db.response.returned_rows", read)
		}
		if written > 0 {
			span.SetAttribute("landflow.db.affected_rows", written)
		}
		return err
	})
	attrs := landflow.Attrs{"db.system": o.system, "operation": op}
	o.metrics.Histogram("landflow.db.query.duration", landflow.WithUnit("ms"),
		landflow.WithDescription("Duration of database statements and commands")).
		Record(float64(time.Since(start))/float64(time.Millisecond), attrs)
	if err != nil {
		o.metrics.Counter("landflow.db.errors", landflow.WithDescription("Failed database statements and commands")).Add(1, attrs)
	}
	rows := o.metrics.Counter("landflow.db.rows", landflow.WithDescription("Rows (or Redis values) read and written"))
	if read > 0 {
		rows.Add(float64(read), landflow.Attrs{"db.system": o.system, "operation": op, "direction": "read"})
	}
	if written > 0 {
		rows.Add(float64(written), landflow.Attrs{"db.system": o.system, "operation": op, "direction": "written"})
	}
	return err
}

// recordPool sets landflow.db.pool.connections from the pools' stats.
func (o *observer) recordPool(p *poolCache) {
	inUse, idle := p.stats(o.system)
	g := o.metrics.Gauge("landflow.db.pool.connections", landflow.WithDescription("Pooled connections by state"))
	g.Set(float64(inUse), landflow.Attrs{"db.system": o.system, "state": "in_use"})
	g.Set(float64(idle), landflow.Attrs{"db.system": o.system, "state": "idle"})
}

// newRows counts rows a poll trigger found.
func (o *observer) newRows(n int) {
	if n > 0 {
		o.metrics.Counter("landflow.db.poll.new_rows", landflow.WithDescription("New rows found by poll triggers")).
			Add(float64(n), landflow.Attrs{"db.system": o.system})
	}
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// dbError turns a driver error into a NodeError carrying the database's
// message (and Postgres' detail and hint), with credential values masked.
// itemIndex < 0 means the failure is not tied to one item.
func dbError(ctx context.Context, itemIndex int, err error) error {
	var nodeErr *landflow.NodeError
	if errors.As(err, &nodeErr) {
		return err
	}
	msg, desc := landflow.RedactString(ctx, err.Error()), ""
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		var parts []string
		for _, p := range []string{pgErr.Detail, pgErr.Hint} {
			if p != "" {
				parts = append(parts, p)
			}
		}
		desc = landflow.RedactString(ctx, strings.Join(parts, " "))
	}
	var out *landflow.NodeError
	if itemIndex >= 0 {
		out = landflow.ItemError(itemIndex, "%s", msg)
	} else {
		out = landflow.NewNodeError("%s", msg)
	}
	if desc != "" {
		out = out.WithDescription(desc)
	}
	return out
}

// ---------------------------------------------------------------------------
// Credential tests
// ---------------------------------------------------------------------------

// testSpan wraps the query of a credential test in a DB client span. The
// SDK's DBSpan lives on the call contexts, and CredentialType.Test receives
// a plain context.Context, so this uses the tracer of the enclosing
// plugin.test_credentials span instead.
func testSpan(ctx context.Context, info landflow.DBSpanInfo, fn func(ctx context.Context) error) error {
	tracer := trace.SpanFromContext(ctx).TracerProvider().Tracer("github.com/landflow/landflow/plugins/databases")
	attrs := []attribute.KeyValue{attribute.String("db.system", info.System), attribute.String("db.operation.name", info.Operation)}
	if info.Statement != "" {
		attrs = append(attrs, attribute.String("db.query.text", info.Statement))
	}
	if info.Namespace != "" {
		attrs = append(attrs, attribute.String("db.namespace", info.Namespace))
	}
	if info.ServerAddress != "" {
		attrs = append(attrs, attribute.String("server.address", info.ServerAddress), attribute.Int("server.port", info.ServerPort))
	}
	ctx, span := tracer.Start(ctx, info.SpanName(), trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(attrs...))
	defer span.End()
	err := fn(ctx)
	if err != nil {
		span.SetStatus(codes.Error, landflow.RedactString(ctx, err.Error()))
	}
	return err
}
