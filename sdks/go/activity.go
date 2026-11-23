package landflow

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Activity items: one change in an outside tool (a message, an edited
// document, a moved ticket, a held meeting) in the same shape whatever the
// tool, so one flow can take items from any integration trigger or List
// Changed Since operation. The schema is
// packages/protocol/activity-items/activity-item.schema.json; the TypeScript
// (activityItem) and Python (activity_item) SDKs build the same output, checked
// against the shared cases in packages/protocol/activity-items/cases.json.

const (
	ActivityTitleMax     = 200
	ActivitySummaryMax   = 600
	ActivityHintMax      = 200
	ActivityRawStringMax = 1000 // strings inside raw keep this many characters
	ActivityRawListMax   = 25   // lists inside raw keep this many entries
	ActivityRawDepthMax  = 5    // objects and lists this deep inside raw become "…"
	ellipsis             = "…"
)

var activityKind = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`)

// Activity is the input of ActivityItem.
type Activity struct {
	Source     string
	SourceID   string
	URL        string
	ActorEmail string
	// OccurredAt is a time.Time, an ISO 8601 string (a date alone, or a time
	// without an offset, is UTC), or epoch milliseconds (any number type).
	OccurredAt     any
	Kind           string
	Title          string
	Summary        string
	TeamHint       string
	InitiativeHint string
	CustomerHint   string
	// Raw is the tool's own object (a map, a struct, or JSON bytes); anything
	// that is not an object is kept as {"value": raw}.
	Raw any
	// Cursor nil: the item has no cursor field; a pointer to "": null.
	Cursor *string
}

// ActivityItemSchema is the JSON Schema of one activity item: a node's (or
// operation's) OutputSchema.
func ActivityItemSchema() map[string]any {
	str := func(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
	opt := func(desc string) map[string]any { return map[string]any{"type": []any{"string", "null"}, "description": desc} }
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"source":         str("The tool, lowercase: slack, google-drive, google-calendar, notion, …"),
			"sourceId":       str("Stable id of the change, '<source>:<tool ids>': the same change always has the same id, so a replay is recognised"),
			"url":            opt("Where a person opens it"),
			"actorEmail":     opt("Email of the person who made the change, lowercase; null when the tool doesn't say"),
			"occurredAt":     map[string]any{"type": "string", "format": "date-time", "description": "When it happened, ISO 8601 in UTC with milliseconds"},
			"kind":           map[string]any{"type": "string", "pattern": `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`, "description": "Suggested event kind, such as work.discussion or work.doc_edited; a flow may change it"},
			"title":          map[string]any{"type": "string", "maxLength": 200, "description": "One line: the document, ticket or meeting title, or the channel and first words"},
			"summary":        map[string]any{"type": "string", "maxLength": 600, "description": "The text, whitespace collapsed, at most 600 characters"},
			"teamHint":       opt("The team it seems to belong to, from the tool's own grouping, when there is one"),
			"initiativeHint": opt("The project or initiative it seems to belong to, when there is one"),
			"customerHint":   opt("The customer it is about, when there is one (a #customer-<name> channel, a CRM company…)"),
			"raw":            map[string]any{"type": "object", "description": "The tool's own object, trimmed: long strings clipped, long lists cut, deep nesting dropped"},
			"cursor":         opt("Pass it back as Since to continue after this item (List Changed Since operations)"),
		},
		"required":             []any{"source", "sourceId", "url", "actorEmail", "occurredAt", "kind", "title", "summary", "teamHint", "initiativeHint", "customerHint", "raw"},
		"additionalProperties": false,
	}
}

// ClipText keeps at most max characters (runes); a longer text ends in "…"
// within the limit.
func ClipText(text string, max int) string {
	if utf8.RuneCountInString(text) <= max {
		return text
	}
	runes := []rune(text)
	keep := max - 1
	if keep < 0 {
		keep = 0
	}
	return strings.TrimRightFunc(string(runes[:keep]), unicode.IsSpace) + ellipsis
}

// CollapseWhitespace turns runs of whitespace (newlines included) into one
// space and trims the ends.
func CollapseWhitespace(text string) string { return strings.Join(strings.Fields(text), " ") }

func activityLine(text string, max int) string { return ClipText(CollapseWhitespace(text), max) }

func activityOptional(text string, max int) any {
	if s := activityLine(text, max); s != "" {
		return s
	}
	return nil
}

// ToISOTime formats a time.Time, an ISO 8601 string or epoch milliseconds as
// ISO 8601 in UTC with milliseconds.
func ToISOTime(value any) (string, error) {
	var t time.Time
	switch v := value.(type) {
	case time.Time:
		t = v
	case *time.Time:
		if v == nil {
			return "", fmt.Errorf("occurredAt is not a time: null")
		}
		t = *v
	case string:
		parsed, ok := parseISOTime(strings.TrimSpace(v))
		if !ok {
			return "", fmt.Errorf("occurredAt is not a time: %q", v)
		}
		t = parsed
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			return "", fmt.Errorf("occurredAt is not a time: %q", v)
		}
		t = time.UnixMilli(int64(f))
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return "", fmt.Errorf("occurredAt is not a time: %v", v)
		}
		t = time.UnixMilli(int64(v))
	case int:
		t = time.UnixMilli(int64(v))
	case int64:
		t = time.UnixMilli(v)
	default:
		return "", fmt.Errorf("occurredAt is not a time: %v", value)
	}
	return t.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z"), nil
}

func parseISOTime(s string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02T15:04", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// TrimRaw makes a vendor object small: strings clipped, lists cut, deep
// nesting replaced by "…". Structs and other values are read through
// encoding/json first.
func TrimRaw(value any) any { return trimRaw(normalizeJSON(value), 0) }

func normalizeJSON(value any) any {
	switch v := value.(type) {
	case nil, string, bool, float64, map[string]any, []any:
		return v
	case json.RawMessage:
		var out any
		if json.Unmarshal(v, &out) != nil {
			return string(v)
		}
		return out
	case []byte:
		var out any
		if json.Unmarshal(v, &out) != nil {
			return string(v)
		}
		return out
	}
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	var out any
	_ = json.Unmarshal(data, &out)
	return out
}

func trimRaw(value any, depth int) any {
	switch v := value.(type) {
	case string:
		return ClipText(v, ActivityRawStringMax)
	case []any:
		if depth >= ActivityRawDepthMax {
			return ellipsis
		}
		n := min(len(v), ActivityRawListMax)
		out := make([]any, n)
		for i := 0; i < n; i++ {
			out[i] = trimRaw(normalizeJSON(v[i]), depth+1)
		}
		return out
	case map[string]any:
		if depth >= ActivityRawDepthMax {
			return ellipsis
		}
		out := make(map[string]any, len(v))
		for k, entry := range v {
			out[k] = trimRaw(normalizeJSON(entry), depth+1)
		}
		return out
	default:
		return v
	}
}

// ActivityItem builds one normalised activity item, the same output as the
// TypeScript and Python SDKs for the same input. It fails on a missing source
// or sourceId, a bad kind or time.
func ActivityItem(a Activity) (map[string]any, error) {
	source := strings.ToLower(strings.TrimSpace(a.Source))
	if source == "" {
		return nil, errors.New("source is required")
	}
	sourceID := strings.TrimSpace(a.SourceID)
	if sourceID == "" {
		return nil, errors.New("sourceId is required")
	}
	kind := strings.ToLower(strings.TrimSpace(a.Kind))
	if !activityKind.MatchString(kind) {
		return nil, fmt.Errorf("kind must be <namespace>.<name> in lowercase letters, digits and underscores (got %q)", a.Kind)
	}
	occurred, err := ToISOTime(a.OccurredAt)
	if err != nil {
		return nil, err
	}
	raw := normalizeJSON(a.Raw)
	if raw == nil {
		raw = map[string]any{}
	} else if _, ok := raw.(map[string]any); !ok {
		raw = map[string]any{"value": raw}
	}
	email := strings.ToLower(strings.TrimSpace(a.ActorEmail))
	title := activityLine(a.Title, ActivityTitleMax)
	if title == "" {
		title = ClipText(sourceID, ActivityTitleMax)
	}
	item := map[string]any{
		"source":         source,
		"sourceId":       sourceID,
		"url":            nil,
		"actorEmail":     nil,
		"occurredAt":     occurred,
		"kind":           kind,
		"title":          title,
		"summary":        activityLine(a.Summary, ActivitySummaryMax),
		"teamHint":       activityOptional(a.TeamHint, ActivityHintMax),
		"initiativeHint": activityOptional(a.InitiativeHint, ActivityHintMax),
		"customerHint":   activityOptional(a.CustomerHint, ActivityHintMax),
		"raw":            trimRaw(raw, 0),
	}
	if u := strings.TrimSpace(a.URL); u != "" {
		item["url"] = u
	}
	if strings.Contains(email, "@") {
		item["actorEmail"] = email
	}
	if a.Cursor != nil {
		if c := strings.TrimSpace(*a.Cursor); c != "" {
			item["cursor"] = c
		} else {
			item["cursor"] = nil
		}
	}
	return item, nil
}
