package landflow

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// The activity item cases shared with the TypeScript and Python SDKs
// (packages/protocol/activity-items/cases.json).

func activityDir(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	dir := filepath.Join(filepath.Dir(file), "..", "..", "packages", "protocol", "activity-items")
	if _, err := os.Stat(filepath.Join(dir, "cases.json")); err != nil {
		t.Skipf("activity item cases not found at %s: %v", dir, err)
	}
	return dir
}

var (
	repeatPlaceholder = regexp.MustCompile(`(?s)^\{\{repeat:(.):(\d+)\}\}(.*)$`)
	rangePlaceholder  = regexp.MustCompile(`^\{\{range:(\d+)\}\}$`)
)

// expandActivity: "{{repeat:c:n}}rest" is c n times then rest; "{{range:n}}" is [0, …, n-1].
func expandActivity(v any) any {
	switch x := v.(type) {
	case string:
		if m := repeatPlaceholder.FindStringSubmatch(x); m != nil {
			n, _ := strconv.Atoi(m[2])
			return strings.Repeat(m[1], n) + m[3]
		}
		if m := rangePlaceholder.FindStringSubmatch(x); m != nil {
			n, _ := strconv.Atoi(m[1])
			out := make([]any, n)
			for i := range out {
				out[i] = float64(i)
			}
			return out
		}
		return x
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = expandActivity(e)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = expandActivity(e)
		}
		return out
	}
	return v
}

func activityFromJSON(in map[string]any) Activity {
	s := func(k string) string { v, _ := in[k].(string); return v }
	a := Activity{
		Source: s("source"), SourceID: s("sourceId"), URL: s("url"), ActorEmail: s("actorEmail"),
		OccurredAt: in["occurredAt"], Kind: s("kind"), Title: s("title"), Summary: s("summary"),
		TeamHint: s("teamHint"), InitiativeHint: s("initiativeHint"), CustomerHint: s("customerHint"), Raw: in["raw"],
	}
	if c, ok := in["cursor"]; ok {
		cs, _ := c.(string)
		a.Cursor = &cs
	}
	return a
}

// roundTrip compares as JSON does (numbers as float64).
func roundTrip(t *testing.T, v any) any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestActivityItemCases(t *testing.T) {
	dir := activityDir(t)
	data, err := os.ReadFile(filepath.Join(dir, "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Kit   string `json:"kit"`
		Cases []struct {
			ID     string         `json:"id"`
			Input  map[string]any `json:"input"`
			Output map[string]any `json:"output"`
			Error  string         `json:"error"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Kit != "landflow.activity-items/v1" || len(fixture.Cases) < 8 {
		t.Fatalf("unexpected fixture: kit %q, %d cases", fixture.Kit, len(fixture.Cases))
	}
	for _, c := range fixture.Cases {
		t.Run(c.ID, func(t *testing.T) {
			got, err := ActivityItem(activityFromJSON(expandActivity(c.Input).(map[string]any)))
			if c.Error != "" {
				if err == nil || !strings.Contains(err.Error(), c.Error) {
					t.Fatalf("want an error containing %q, got %v", c.Error, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := roundTrip(t, expandActivity(c.Output))
			if have := roundTrip(t, got); !reflect.DeepEqual(have, want) {
				gotJSON, _ := json.Marshal(have)
				wantJSON, _ := json.Marshal(want)
				t.Fatalf("got  %s\nwant %s", gotJSON, wantJSON)
			}
		})
	}
}

func TestActivityItemSchemaMatchesPublished(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(activityDir(t), "activity-item.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var published map[string]any
	if err := json.Unmarshal(data, &published); err != nil {
		t.Fatal(err)
	}
	ours := roundTrip(t, ActivityItemSchema()).(map[string]any)
	for _, key := range []string{"properties", "required", "additionalProperties"} {
		if !reflect.DeepEqual(ours[key], published[key]) {
			t.Fatalf("%s differs from activity-item.schema.json", key)
		}
	}
}

func TestActivityItemExtras(t *testing.T) {
	if got := ClipText("😀😀😀", 2); got != "😀…" {
		t.Fatalf("ClipText = %q", got)
	}
	type vendor struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	item, err := ActivityItem(Activity{Source: "s", SourceID: "i", Kind: "work.x", OccurredAt: int64(0), Raw: vendor{ID: "1", Name: "n"}})
	if err != nil {
		t.Fatal(err)
	}
	if item["occurredAt"] != "1970-01-01T00:00:00.000Z" || !reflect.DeepEqual(item["raw"], map[string]any{"id": "1", "name": "n"}) {
		t.Fatalf("item = %v", item)
	}
	if _, ok := item["cursor"]; ok {
		t.Fatal("no Cursor: no cursor field")
	}
}
