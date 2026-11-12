package fakegoogle

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Calendar holds events as raw Events resources.
type Calendar struct {
	ID, Summary, TimeZone string
	Primary               bool
	Events                []map[string]any
	// Deleted keeps deleted events (status cancelled) for incremental sync.
	Deleted []map[string]any
}

// UpsertEvent adds an event to a calendar, or replaces the one with its id;
// "updated" defaults to now.
func (s *Server) UpsertEvent(calendarID string, ev map[string]any) {
	s.Do(func() { s.upsertEvent(calendarID, ev) })
}

func (s *Server) upsertEvent(calendarID string, ev map[string]any) bool {
	c := s.calendarByID(calendarID)
	if c == nil {
		return false
	}
	if _, ok := ev["updated"]; !ok {
		ev["updated"] = time.Now().UTC().Format(time.RFC3339Nano)
	}
	for k, old := range c.Events {
		if old["id"] == ev["id"] {
			c.Events[k] = ev
			return true
		}
	}
	c.Events = append(c.Events, ev)
	return true
}

func eventUpdated(ev map[string]any) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, asString(ev["updated"]))
	return t
}

// AddCalendar stores a calendar.
func (s *Server) AddCalendar(c *Calendar) { s.Do(func() { s.Calendars[c.ID] = c }) }

// Events returns a copy of a calendar's events.
func (s *Server) Events(calendarID string) []map[string]any {
	var out []map[string]any
	s.Do(func() {
		if c := s.calendarByID(calendarID); c != nil {
			out = append(out, c.Events...)
		}
	})
	return out
}

func (s *Server) calendarByID(id string) *Calendar {
	if id == "primary" {
		for _, c := range s.Calendars {
			if c.Primary {
				return c
			}
		}
	}
	return s.Calendars[id]
}

func (s *Server) calendar(w http.ResponseWriter, r *http.Request, segs []string, body []byte) {
	if hasPrefix(segs, "users", "me", "calendarList") && r.Method == http.MethodGet {
		var items []any
		ids := make([]string, 0, len(s.Calendars))
		for id := range s.Calendars {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			c := s.Calendars[id]
			items = append(items, map[string]any{"id": c.ID, "summary": c.Summary, "timeZone": c.TimeZone, "primary": c.Primary, "accessRole": "owner"})
		}
		writeJSON(w, http.StatusOK, map[string]any{"kind": "calendar#calendarList", "items": items})
		return
	}
	if len(segs) < 2 || segs[0] != "calendars" {
		writeError(w, http.StatusNotFound, "unknown Calendar call")
		return
	}
	c := s.calendarByID(segs[1])
	if c == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}
	switch {
	case len(segs) == 2 && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"id": c.ID, "summary": c.Summary, "timeZone": c.TimeZone})
	case len(segs) == 3 && segs[2] == "events" && r.Method == http.MethodPost:
		var ev map[string]any
		if err := json.Unmarshal(body, &ev); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		for _, key := range []string{"start", "end"} {
			if msg := checkEventTime(ev[key], key); msg != "" {
				writeError(w, http.StatusBadRequest, msg)
				return
			}
		}
		ev["id"] = s.id("evt")
		ev["status"] = "confirmed"
		ev["htmlLink"] = "https://www.google.com/calendar/event?eid=" + ev["id"].(string)
		ev["created"] = time.Now().UTC().Format(time.RFC3339)
		ev["updated"] = time.Now().UTC().Format(time.RFC3339Nano)
		c.Events = append(c.Events, ev)
		writeJSON(w, http.StatusOK, ev)
	case len(segs) == 3 && segs[2] == "events" && r.Method == http.MethodGet:
		s.listEvents(w, r, c)
	case len(segs) == 4 && segs[2] == "events":
		k := -1
		for idx, ev := range c.Events {
			if ev["id"] == segs[3] {
				k = idx
			}
		}
		if k < 0 {
			writeError(w, http.StatusNotFound, "Not Found")
			return
		}
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, c.Events[k])
		case http.MethodPatch:
			var patch map[string]any
			if err := json.Unmarshal(body, &patch); err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			for key, v := range patch {
				c.Events[k][key] = v
			}
			c.Events[k]["updated"] = time.Now().UTC().Format(time.RFC3339Nano)
			writeJSON(w, http.StatusOK, c.Events[k])
		case http.MethodDelete:
			gone := map[string]any{"id": c.Events[k]["id"], "status": "cancelled", "updated": time.Now().UTC().Format(time.RFC3339Nano)}
			c.Deleted = append(c.Deleted, gone)
			c.Events = append(c.Events[:k], c.Events[k+1:]...)
			w.WriteHeader(http.StatusNoContent)
		default:
			writeError(w, http.StatusNotFound, "unknown events call")
		}
	default:
		writeError(w, http.StatusNotFound, "unknown Calendar call")
	}
}

// checkEventTime mirrors Google's validation of EventDateTime.
func checkEventTime(v any, key string) string {
	m, ok := v.(map[string]any)
	if !ok {
		return "Missing " + key + " time."
	}
	if d, ok := m["date"].(string); ok {
		if _, err := time.Parse(time.DateOnly, d); err != nil {
			return "Invalid " + key + " date."
		}
		return ""
	}
	dt, _ := m["dateTime"].(string)
	if _, err := time.Parse(time.RFC3339, dt); err == nil {
		return ""
	}
	if _, err := time.Parse("2006-01-02T15:04:05", dt); err == nil {
		if tz, _ := m["timeZone"].(string); tz != "" {
			return ""
		}
		return "Missing time zone definition for " + key + " time."
	}
	return "Invalid " + key + " time."
}

func eventStart(ev map[string]any, key string) time.Time {
	m, _ := ev[key].(map[string]any)
	if dt, ok := m["dateTime"].(string); ok {
		if t, err := time.Parse(time.RFC3339, dt); err == nil {
			return t
		}
		if loc, err := time.LoadLocation(asString(m["timeZone"])); err == nil {
			if t, err := time.ParseInLocation("2006-01-02T15:04:05", dt, loc); err == nil {
				return t
			}
		}
	}
	if d, ok := m["date"].(string); ok {
		t, _ := time.Parse(time.DateOnly, d)
		return t
	}
	return time.Time{}
}

func (s *Server) listEvents(w http.ResponseWriter, r *http.Request, c *Calendar) {
	q := r.URL.Query()
	syncToken := q.Get("syncToken")
	var since time.Time
	if syncToken != "" {
		for _, key := range []string{"iCalUID", "orderBy", "privateExtendedProperty", "q", "sharedExtendedProperty", "timeMin", "timeMax", "updatedMin"} {
			if q.Has(key) {
				writeError(w, http.StatusBadRequest, "The syncToken parameter cannot be combined with "+key+".")
				return
			}
		}
		t, err := time.Parse(time.RFC3339Nano, strings.TrimPrefix(syncToken, "sync-"))
		if err != nil {
			writeError(w, http.StatusGone, "Sync token is no longer valid, a full sync is required.")
			return
		}
		since = t
	}
	var updatedMin time.Time
	if v := q.Get("updatedMin"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "Bad Request: updatedMin must be RFC 3339")
			return
		}
		updatedMin = t
	}
	if q.Get("orderBy") == "startTime" && q.Get("singleEvents") != "true" {
		writeError(w, http.StatusBadRequest, "The requested ordering is not available for the particular query.")
		return
	}
	var tMin, tMax time.Time
	for key, dst := range map[string]*time.Time{"timeMin": &tMin, "timeMax": &tMax} {
		if v := q.Get(key); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				writeError(w, http.StatusBadRequest, "Bad Request: "+key+" must be RFC 3339")
				return
			}
			*dst = t
		}
	}
	var matched []map[string]any
	all := c.Events
	if syncToken != "" || q.Get("showDeleted") == "true" {
		all = append(append([]map[string]any{}, c.Events...), c.Deleted...)
	}
	latest := since
	for _, ev := range append(append([]map[string]any{}, c.Events...), c.Deleted...) {
		if u := eventUpdated(ev); u.After(latest) {
			latest = u
		}
	}
	for _, ev := range all {
		if syncToken != "" {
			if eventUpdated(ev).After(since) {
				matched = append(matched, ev)
			}
			continue
		}
		if asString(ev["status"]) == "cancelled" && q.Get("showDeleted") != "true" {
			continue
		}
		if !updatedMin.IsZero() && eventUpdated(ev).Before(updatedMin) {
			continue
		}
		start, end := eventStart(ev, "start"), eventStart(ev, "end")
		if !tMin.IsZero() && !end.After(tMin) || !tMax.IsZero() && !start.Before(tMax) {
			continue
		}
		if text := strings.ToLower(q.Get("q")); text != "" {
			hay := strings.ToLower(asString(ev["summary"]) + " " + asString(ev["description"]) + " " + asString(ev["location"]))
			if !strings.Contains(hay, text) {
				continue
			}
		}
		matched = append(matched, ev)
	}
	if q.Get("orderBy") == "startTime" {
		sort.SliceStable(matched, func(a, b int) bool { return eventStart(matched[a], "start").Before(eventStart(matched[b], "start")) })
	}
	start, _ := strconv.Atoi(q.Get("pageToken"))
	size, _ := strconv.Atoi(q.Get("maxResults"))
	size = s.pageSize(size, 250)
	end := min(start+size, len(matched))
	items := []any{}
	for _, ev := range matched[min(start, end):end] {
		items = append(items, ev)
	}
	resp := map[string]any{"kind": "calendar#events", "timeZone": c.TimeZone, "items": items}
	if end < len(matched) {
		resp["nextPageToken"] = strconv.Itoa(end)
	} else {
		resp["nextSyncToken"] = "sync-" + latest.UTC().Format(time.RFC3339Nano)
	}
	writeJSON(w, http.StatusOK, resp)
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}
