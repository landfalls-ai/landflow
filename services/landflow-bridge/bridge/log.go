package bridge

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"time"
)

// ServiceName is the service field of every log line.
const ServiceName = "landflow-bridge"

// NewLogger returns a logger in the Landflow log format (docs/observability.md §3; the Go SDK's logging.go): one JSON
// object per line, {"ts":…,"level":…,"service":"landflow-bridge","msg":…, …attributes}, or with format "pretty"
// (LANDFLOW_LOG_FORMAT) a human line. level is debug | info | warn | error (LANDFLOW_LOG_LEVEL, default info).
func NewLogger(w io.Writer, level, format string) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn", "warning":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	replace := func(_ []string, a slog.Attr) slog.Attr {
		switch a.Key {
		case slog.TimeKey:
			return slog.String("ts", a.Value.Time().UTC().Format(time.RFC3339Nano))
		case slog.LevelKey:
			return slog.String("level", strings.ToLower(a.Value.String()))
		}
		return a
	}
	var handler slog.Handler
	if strings.EqualFold(strings.TrimSpace(format), "pretty") {
		handler = &prettyHandler{w: w, level: lvl}
	} else {
		handler = slog.NewJSONHandler(w, &slog.HandlerOptions{Level: lvl, ReplaceAttr: replace})
	}
	return slog.New(handler).With("service", ServiceName)
}

// prettyHandler writes "HH:MM:SS level msg k=v …".
type prettyHandler struct {
	w     io.Writer
	level slog.Level
	attrs []slog.Attr
}

func (h *prettyHandler) Enabled(_ context.Context, l slog.Level) bool { return l >= h.level }

func (h *prettyHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	c := *h
	c.attrs = append(append([]slog.Attr(nil), h.attrs...), attrs...)
	return &c
}

func (h *prettyHandler) WithGroup(string) slog.Handler { return h }

func (h *prettyHandler) Handle(_ context.Context, r slog.Record) error {
	var b strings.Builder
	b.WriteString(r.Time.Format("15:04:05"))
	b.WriteByte(' ')
	b.WriteString(strings.ToLower(r.Level.String()))
	b.WriteByte(' ')
	b.WriteString(r.Message)
	write := func(a slog.Attr) bool {
		if a.Key == "service" {
			return true
		}
		b.WriteByte(' ')
		b.WriteString(a.Key)
		b.WriteByte('=')
		b.WriteString(a.Value.String())
		return true
	}
	for _, a := range h.attrs {
		write(a)
	}
	r.Attrs(write)
	b.WriteByte('\n')
	_, err := io.WriteString(h.w, b.String())
	return err
}
