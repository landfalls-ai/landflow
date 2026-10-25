package main

import (
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/landflow/landflow/plugins/google-workspace/internal/fakegoogle"
)

func TestCalendarCreate(t *testing.T) {
	h := newHarness(t)
	create := func(start, end string, fields map[string]any) map[string]any {
		t.Helper()
		return h.ok(h.exec("googleCalendar", map[string]any{
			"resource": "event", "operation": "create", "calendar": "primary", "start": start, "end": end, "additionalFields": fields,
		}, execOpts{}))[0]
	}

	// Local times get the calendar's zone (looked up once per execution).
	ev := create("2026-11-02T10:00:00", "2026-11-02T11:00", map[string]any{
		"summary": "Planning", "attendees": "ann@example.com, bob@example.com", "location": "Room 1", "sendUpdates": "all",
	})
	if ev["summary"] != "Planning" || ev["id"] == "" {
		t.Fatalf("event = %v", ev)
	}
	start := ev["start"].(map[string]any)
	if start["dateTime"] != "2026-11-02T10:00:00" || start["timeZone"] != "Europe/Berlin" {
		t.Errorf("start = %v", start)
	}
	if end := ev["end"].(map[string]any); end["dateTime"] != "2026-11-02T11:00:00" {
		t.Errorf("end = %v", end)
	}
	if attendees := ev["attendees"].([]any); len(attendees) != 2 || attendees[1].(map[string]any)["email"] != "bob@example.com" {
		t.Errorf("attendees = %v", attendees)
	}
	post := h.fake.Calls(http.MethodPost, "/calendar/v3/calendars/primary/events")
	if len(post) != 1 || post[0].Query.Get("sendUpdates") != "all" {
		t.Errorf("create call = %+v", post)
	}
	if n := len(h.fake.Calls(http.MethodGet, "/calendar/v3/calendars/primary")); n != 1 {
		t.Errorf("%d time zone lookups", n)
	}

	// Offsets are kept; an explicit time zone wins over the calendar's.
	ev = create("2026-11-02T10:00:00+01:00", "2026-11-02T10:30:00Z", nil)
	if ev["start"].(map[string]any)["dateTime"] != "2026-11-02T10:00:00+01:00" {
		t.Errorf("zoned start = %v", ev["start"])
	}
	ev = create("2026-11-02 09:00", "2026-11-02 10:00", map[string]any{"timezone": "America/New_York"})
	if ev["start"].(map[string]any)["timeZone"] != "America/New_York" {
		t.Errorf("explicit zone = %v", ev["start"])
	}

	// All-day: dates, and a same-day end becomes the (exclusive) next day.
	ev = create("2026-12-24", "2026-12-24", map[string]any{"allday": true, "summary": "Holiday"})
	if ev["start"].(map[string]any)["date"] != "2026-12-24" || ev["end"].(map[string]any)["date"] != "2026-12-25" {
		t.Errorf("all-day = %v / %v", ev["start"], ev["end"])
	}

	resp := h.exec("googleCalendar", map[string]any{"resource": "event", "operation": "create", "start": "next tuesday", "end": "x"}, execOpts{})
	if resp.Error == nil || resp.Error.Message != `"next tuesday" is not a date or time` {
		t.Errorf("bad date error = %+v", resp.Error)
	}
	resp = h.exec("googleCalendar", map[string]any{"resource": "event", "operation": "create", "calendar": "nope@example.com",
		"start": "2026-11-02T10:00:00Z", "end": "2026-11-02T11:00:00Z"}, execOpts{})
	if resp.Error == nil || resp.Error.Message != "Google Calendar API error 404: Not Found" ||
		!strings.Contains(resp.Error.Description, "share the spreadsheet, file or calendar") {
		t.Errorf("unknown calendar error = %+v", resp.Error)
	}
}

func TestCalendarGetUpdateDelete(t *testing.T) {
	h := newHarness(t)
	ev := h.ok(h.exec("googleCalendar", map[string]any{"resource": "event", "operation": "create",
		"start": "2026-11-03T09:00:00Z", "end": "2026-11-03T10:00:00Z", "additionalFields": map[string]any{"summary": "1:1"}}, execOpts{}))[0]
	id := ev["id"].(string)

	got := h.ok(h.exec("googleCalendar", map[string]any{"resource": "event", "operation": "get", "eventId": id}, execOpts{}))[0]
	if got["summary"] != "1:1" {
		t.Errorf("get = %v", got)
	}
	upd := h.ok(h.exec("googleCalendar", map[string]any{"resource": "event", "operation": "update", "eventId": id,
		"updateFields": map[string]any{"summary": "1:1 (moved)", "start": "2026-11-03T15:00:00Z", "end": "2026-11-03T16:00:00Z"}}, execOpts{}))[0]
	if upd["summary"] != "1:1 (moved)" || upd["start"].(map[string]any)["dateTime"] != "2026-11-03T15:00:00Z" {
		t.Errorf("update = %v", upd)
	}
	patch := h.fake.Calls(http.MethodPatch, "/calendar/v3/calendars/primary/events/"+id)
	if body := jsonBody(t, patch[0]); len(body) != 3 || body["description"] != nil {
		t.Errorf("patch body = %v (only the given fields are sent)", body)
	}
	resp := h.exec("googleCalendar", map[string]any{"resource": "event", "operation": "update", "eventId": id, "updateFields": map[string]any{}}, execOpts{})
	if resp.Error == nil || resp.Error.Message != "Nothing to update" {
		t.Errorf("empty update error = %+v", resp.Error)
	}

	del := h.ok(h.exec("googleCalendar", map[string]any{"resource": "event", "operation": "delete", "eventId": id}, execOpts{}))[0]
	if del["success"] != true || len(h.fake.Events("primary")) != 0 {
		t.Errorf("delete = %v, events left %d", del, len(h.fake.Events("primary")))
	}
}

func TestCalendarGetAll(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	base := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	cal := &fakegoogle.Calendar{ID: "team@group.calendar.google.com", Summary: "Team", TimeZone: "UTC"}
	for k := 9; k >= 0; k-- { // stored newest first, so ordering is visible
		s := base.Add(time.Duration(k) * 24 * time.Hour)
		cal.Events = append(cal.Events, map[string]any{
			"id": fmt.Sprintf("e%d", k), "summary": fmt.Sprintf("Standup %d", k),
			"start": map[string]any{"dateTime": s.Format(time.RFC3339)}, "end": map[string]any{"dateTime": s.Add(15 * time.Minute).Format(time.RFC3339)},
		})
	}
	h.fake.AddCalendar(cal)
	h.fake.PageSize = 4

	list := func(extra map[string]any) []string {
		t.Helper()
		p := map[string]any{"resource": "event", "operation": "getAll", "calendar": cal.ID}
		for k, v := range extra {
			p[k] = v
		}
		var ids []string
		for _, ev := range h.ok(h.exec("googleCalendar", p, execOpts{})) {
			ids = append(ids, ev["id"].(string))
		}
		return ids
	}
	if ids := list(map[string]any{"returnAll": true}); len(ids) != 10 {
		t.Errorf("returnAll = %v", ids)
	}
	spans := tel.spansNamed("google.calendar.events.list")
	if pages, _ := spanAttr(spans[len(spans)-1], "google.pages"); pages != "3" {
		t.Errorf("google.pages = %s", pages)
	}
	ids := list(map[string]any{"returnAll": true, "timeMin": "2026-11-03T00:00:00Z", "timeMax": "2026-11-06",
		"options": map[string]any{"orderBy": "startTime"}})
	if !slices.Equal(ids, []string{"e2", "e3", "e4"}) {
		t.Errorf("window ordered by start = %v", ids)
	}
	last := h.fake.Calls(http.MethodGet, "/calendar/v3/calendars/"+cal.ID+"/events")
	if q := last[len(last)-1].Query; q.Get("singleEvents") != "true" || q.Get("timeMax") != "2026-11-06T00:00:00Z" {
		t.Errorf("list query = %v", q)
	}
	if ids := list(map[string]any{"limit": 5}); len(ids) != 5 {
		t.Errorf("limit 5 = %v", ids)
	}
	if ids := list(map[string]any{"returnAll": true, "options": map[string]any{"query": "standup 7"}}); !slices.Equal(ids, []string{"e7"}) {
		t.Errorf("query = %v", ids)
	}

	opts := h.loadOptions("googleCalendar", "calendars", map[string]any{}, nil)
	var names []string
	for _, o := range opts {
		names = append(names, o.Name)
	}
	if !slices.Equal(names, []string{"Primary Calendar", "Me (primary)", "Team"}) {
		t.Errorf("calendar options = %v", names)
	}
}
