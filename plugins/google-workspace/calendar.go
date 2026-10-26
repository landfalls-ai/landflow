package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
)

// CalendarNode is Google Calendar's event resource: create, get, get many,
// update and delete events.
type CalendarNode struct{}

var sendUpdatesProperty = landflow.PropertyDescriptor{
	Name: "sendUpdates", DisplayName: "Send Updates", Type: landflow.PropOptions, Default: "none",
	Description: "Whether to email guests about the change",
	Options: []landflow.PropertyOption{
		{Name: "All", Value: "all", Description: "Notify all guests"},
		{Name: "External Only", Value: "externalOnly", Description: "Notify guests outside the organization"},
		{Name: "None", Value: "none", Description: "Notify nobody"},
	},
}

// eventFields are the event fields Create and Update can set.
func eventFields(withTimes bool) []landflow.PropertyDescriptor {
	fields := []landflow.PropertyDescriptor{
		{Name: "allday", DisplayName: "All Day", Type: landflow.PropBoolean, Default: false,
			Description: "Whether the event lasts whole days (start and end are taken as dates; the end date is exclusive)"},
		{Name: "attendees", DisplayName: "Attendees", Type: landflow.PropString, Default: "",
			Description: "Guest emails, separated by commas"},
		{Name: "description", DisplayName: "Description", Type: landflow.PropString, Default: "",
			TypeOptions: &landflow.TypeOptions{Rows: landflow.Ptr(3)}},
		{Name: "location", DisplayName: "Location", Type: landflow.PropString, Default: ""},
		{Name: "summary", DisplayName: "Summary", Type: landflow.PropString, Default: "", Description: "Event title"},
		{Name: "timezone", DisplayName: "Timezone", Type: landflow.PropString, Default: "", Placeholder: "Europe/Berlin",
			Description: "IANA zone for times without an offset; defaults to the calendar's zone"},
		sendUpdatesProperty,
	}
	if withTimes {
		fields = append(fields,
			landflow.PropertyDescriptor{Name: "start", DisplayName: "Start", Type: landflow.PropDateTime, Default: ""},
			landflow.PropertyDescriptor{Name: "end", DisplayName: "End", Type: landflow.PropDateTime, Default: ""},
		)
	}
	return fields
}

func (CalendarNode) Description() landflow.NodeDescriptor {
	getAll := show("event", "getAll")
	paging := returnAllLimit(getAll, 50, 2500)
	return landflow.NodeDescriptor{
		Name:             "googleCalendar",
		DisplayName:      "Google Calendar",
		Description:      "Create, read, update and delete Google Calendar events",
		Version:          landflow.V(1),
		Kind:             landflow.KindAction,
		Categories:       []string{"Productivity"},
		Icon:             "file:icons/calendar.svg",
		Color:            "#4285F4",
		Subtitle:         "{{operation}}: {{resource}}",
		Inputs:           []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		DocumentationURL: "https://developers.google.com/workspace/calendar/api/v3/reference/events",
		Keywords:         []string{"calendar", "event", "meeting", "schedule", "appointment"},
		Credentials:      credentialRequirements(),

		UsableAsTool: true,
		ToolDescription: "Manage Google Calendar events in `calendar` (default primary). operation=create needs start " +
			"and end (ISO 8601) and takes additionalFields summary, description, location, attendees (comma-separated " +
			"emails) and allday; getAll lists events between timeMin and timeMax (options.query searches text); get, " +
			"update (updateFields) and delete act on eventId.",

		Properties: []landflow.PropertyDescriptor{
			authProperty(),
			resourceProperty("event", landflow.PropertyOption{Name: "Event", Value: "event"}),
			operationProperty("event", "create",
				landflow.PropertyOption{Name: "Create", Value: "create", Description: "Add an event to a calendar", Action: "Create an event"},
				landflow.PropertyOption{Name: "Delete", Value: "delete", Description: "Delete an event", Action: "Delete an event"},
				landflow.PropertyOption{Name: "Get", Value: "get", Description: "Retrieve an event", Action: "Get an event", Idempotent: true},
				landflow.PropertyOption{Name: "Get Many", Value: "getAll", Description: "Retrieve many events from a calendar", Action: "Get many events", Idempotent: true},
				landflow.PropertyOption{Name: "Update", Value: "update", Description: "Update an event", Action: "Update an event"},
			),
			{
				Name: "calendar", DisplayName: "Calendar", Type: landflow.PropOptions, Default: "primary", Required: true,
				Description: "Calendar to use. An expression may also give a calendar ID (often an email address).",
				Options:     []landflow.PropertyOption{{Name: "Primary Calendar", Value: "primary"}},
				TypeOptions: &landflow.TypeOptions{LoadOptionsMethod: "calendars"}, DisplayOptions: show("event"),
			},
			{Name: "start", DisplayName: "Start", Type: landflow.PropDateTime, Default: "", Required: true,
				Description: "Start time (ISO 8601; without an offset the calendar's timezone applies)", DisplayOptions: show("event", "create")},
			{Name: "end", DisplayName: "End", Type: landflow.PropDateTime, Default: "", Required: true,
				Description: "End time (ISO 8601)", DisplayOptions: show("event", "create")},
			{Name: "additionalFields", DisplayName: "Additional Fields", Type: landflow.PropCollection, Default: map[string]any{},
				Placeholder: "Add Field", DisplayOptions: show("event", "create"), Values: eventFields(false)},
			{Name: "eventId", DisplayName: "Event ID", Type: landflow.PropString, Default: "", Required: true,
				DisplayOptions: show("event", "get", "update", "delete")},
			{Name: "updateFields", DisplayName: "Update Fields", Type: landflow.PropCollection, Default: map[string]any{},
				Placeholder: "Add Field", DisplayOptions: show("event", "update"), Values: eventFields(true)},
			{Name: "options", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{},
				Placeholder: "Add Option", DisplayOptions: show("event", "delete"),
				Values: []landflow.PropertyDescriptor{sendUpdatesProperty}},
			paging[0],
			paging[1],
			{Name: "timeMin", DisplayName: "After", Type: landflow.PropDateTime, Default: "",
				Description: "Events ending after this time (ISO 8601; UTC without an offset)", DisplayOptions: getAll},
			{Name: "timeMax", DisplayName: "Before", Type: landflow.PropDateTime, Default: "",
				Description: "Events starting before this time", DisplayOptions: getAll},
			{Name: "options", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{},
				Placeholder: "Add Option", DisplayOptions: getAll,
				Values: []landflow.PropertyDescriptor{
					{Name: "orderBy", DisplayName: "Order By", Type: landflow.PropOptions, Default: "startTime",
						Description: "Start Time expands recurring events into single events",
						Options: []landflow.PropertyOption{
							{Name: "Start Time", Value: "startTime"},
							{Name: "Updated", Value: "updated"},
						}},
					{Name: "query", DisplayName: "Query", Type: landflow.PropString, Default: "",
						Description: "Free text matched against summary, description, location and attendees"},
					{Name: "showDeleted", DisplayName: "Show Deleted", Type: landflow.PropBoolean, Default: false},
					{Name: "singleEvents", DisplayName: "Single Events", Type: landflow.PropBoolean, Default: false,
						Description: "Whether to expand recurring events into instances"},
				}},
		},
	}
}

func (CalendarNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	items := ctx.InputData(0)
	if len(items) == 0 {
		return nil, nil
	}
	c, err := newClient(ctx, ctx.ParamString("authentication", 0, "serviceAccount"))
	if err != nil {
		return nil, err
	}
	r := &calendarRun{ctx: ctx, c: c, zones: map[string]string{}}
	var out []landflow.Item
	for i := range items {
		operation := ctx.ParamString("operation", i, "create")
		var results []map[string]any
		switch operation {
		case "create":
			results, err = one(r.create(i))
		case "get":
			results, err = one(r.get(i))
		case "getAll":
			results, err = r.getMany(i)
		case "update":
			results, err = one(r.update(i))
		case "delete":
			results, err = one(r.delete(i))
		default:
			err = userError("Pick an operation listed for the event resource.", "Unsupported operation %q", operation)
		}
		if err != nil {
			if ctx.ContinueOnFail() {
				out = append(out, ctx.ErrorItem(i, itemError(i, err)))
				continue
			}
			return nil, itemError(i, err)
		}
		out = emit(out, i, results...)
	}
	return [][]landflow.Item{out}, nil
}

type calendarRun struct {
	ctx   *landflow.ExecuteContext
	c     *client
	zones map[string]string // calendar → timeZone
}

func (r *calendarRun) calendar(i int) string {
	if id := strings.TrimSpace(r.ctx.ParamString("calendar", i, "primary")); id != "" {
		return id
	}
	return "primary"
}

func eventsPath(calendarID string) string {
	return "/calendar/v3/calendars/" + url.PathEscape(calendarID) + "/events"
}

func (r *calendarRun) create(i int) (map[string]any, error) {
	cal := r.calendar(i)
	fields := cloneMap(asMap(r.ctx.Param("additionalFields", i))) // start/end are added below
	start, err := requireParam(r.ctx, "start", "Start", i)
	if err != nil {
		return nil, err
	}
	end, err := requireParam(r.ctx, "end", "End", i)
	if err != nil {
		return nil, err
	}
	fields["start"], fields["end"] = start, end
	body, err := r.eventBody(cal, fields)
	if err != nil {
		return nil, err
	}
	var event map[string]any
	err = r.c.do(r.ctx, apiCalendar, http.MethodPost, eventsPath(cal), sendUpdates(fields), body, &event)
	return event, err
}

func (r *calendarRun) get(i int) (map[string]any, error) {
	id, err := requireParam(r.ctx, "eventId", "Event ID", i)
	if err != nil {
		return nil, err
	}
	var event map[string]any
	err = r.c.do(r.ctx, apiCalendar, http.MethodGet, eventsPath(r.calendar(i))+"/"+url.PathEscape(id), nil, nil, &event)
	return event, err
}

func (r *calendarRun) update(i int) (map[string]any, error) {
	cal := r.calendar(i)
	id, err := requireParam(r.ctx, "eventId", "Event ID", i)
	if err != nil {
		return nil, err
	}
	fields := asMap(r.ctx.Param("updateFields", i))
	body, err := r.eventBody(cal, fields)
	if err != nil {
		return nil, err
	}
	if len(body) == 0 {
		return nil, userError("Add at least one field under Update Fields.", "Nothing to update")
	}
	var event map[string]any
	err = r.c.do(r.ctx, apiCalendar, http.MethodPatch, eventsPath(cal)+"/"+url.PathEscape(id), sendUpdates(fields), body, &event)
	return event, err
}

func (r *calendarRun) delete(i int) (map[string]any, error) {
	id, err := requireParam(r.ctx, "eventId", "Event ID", i)
	if err != nil {
		return nil, err
	}
	opts := asMap(r.ctx.Param("options", i))
	if err := r.c.do(r.ctx, apiCalendar, http.MethodDelete, eventsPath(r.calendar(i))+"/"+url.PathEscape(id), sendUpdates(opts), nil, nil); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "success": true}, nil
}

// getMany lists events, paging with pageToken.
func (r *calendarRun) getMany(i int) ([]map[string]any, error) {
	cal := r.calendar(i)
	opts := asMap(r.ctx.Param("options", i))
	base := url.Values{}
	for _, name := range []string{"timeMin", "timeMax"} {
		if v := strings.TrimSpace(r.ctx.ParamString(name, i, "")); v != "" {
			t, _, err := parseDateTime(v)
			if err != nil {
				return nil, err
			}
			base.Set(name, t.UTC().Format(time.RFC3339))
		}
	}
	if q := strings.TrimSpace(getString(opts, "query", "")); q != "" {
		base.Set("q", q)
	}
	orderBy := getString(opts, "orderBy", "")
	single := getBool(opts, "singleEvents", false)
	if orderBy == "startTime" {
		single = true // the API only orders single events by start time
	}
	if single {
		base.Set("singleEvents", "true")
	}
	if orderBy != "" {
		base.Set("orderBy", orderBy)
	}
	if getBool(opts, "showDeleted", false) {
		base.Set("showDeleted", "true")
	}
	var events []map[string]any
	err := paginate(r.ctx, "google.calendar.events.list", limitFor(r.ctx, i, 50), func(ctx context.Context, token string, remaining int) (int, string, error) {
		query := url.Values{}
		for k, v := range base {
			query[k] = v
		}
		query.Set("maxResults", strconv.Itoa(pageSize(remaining, 2500)))
		if token != "" {
			query.Set("pageToken", token)
		}
		var page struct {
			Items         []map[string]any `json:"items"`
			NextPageToken string           `json:"nextPageToken"`
		}
		if err := r.c.do(ctx, apiCalendar, http.MethodGet, eventsPath(cal), query, nil, &page); err != nil {
			return 0, "", err
		}
		if remaining >= 0 && len(page.Items) > remaining {
			page.Items = page.Items[:remaining]
		}
		events = append(events, page.Items...)
		return len(page.Items), page.NextPageToken, nil
	})
	return events, err
}

// eventBody maps Create/Update fields to an Events resource.
func (r *calendarRun) eventBody(cal string, fields map[string]any) (map[string]any, error) {
	body := map[string]any{}
	for _, key := range []string{"summary", "description", "location"} {
		if v, ok := fields[key]; ok && v != nil {
			body[key] = landflow.Stringify(v)
		}
	}
	if v, ok := fields["attendees"]; ok {
		list := []map[string]any{}
		for _, email := range stringList(v) {
			list = append(list, map[string]any{"email": email})
		}
		body["attendees"] = list
	}
	allDay := getBool(fields, "allday", false)
	tz := strings.TrimSpace(getString(fields, "timezone", ""))
	start := strings.TrimSpace(getString(fields, "start", ""))
	end := strings.TrimSpace(getString(fields, "end", ""))
	if start != "" {
		v, err := r.eventTime(cal, start, allDay, tz)
		if err != nil {
			return nil, err
		}
		body["start"] = v
	}
	if end != "" {
		v, err := r.eventTime(cal, end, allDay, tz)
		if err != nil {
			return nil, err
		}
		// The end date of an all-day event is exclusive: a same-day end means one day.
		if allDay && start != "" {
			if s, ok := body["start"].(map[string]any); ok && v["date"].(string) <= s["date"].(string) {
				d, _ := time.Parse(time.DateOnly, s["date"].(string))
				v["date"] = d.AddDate(0, 0, 1).Format(time.DateOnly)
			}
		}
		body["end"] = v
	}
	return body, nil
}

// eventTime builds an EventDateTime: a date for all-day events, an RFC 3339
// time when the value has an offset, otherwise a local time plus timeZone.
func (r *calendarRun) eventTime(cal, value string, allDay bool, tz string) (map[string]any, error) {
	t, hasZone, err := parseDateTime(value)
	if err != nil {
		return nil, err
	}
	if allDay {
		return map[string]any{"date": t.Format(time.DateOnly)}, nil
	}
	if hasZone {
		out := map[string]any{"dateTime": t.Format(time.RFC3339)}
		if tz != "" {
			out["timeZone"] = tz
		}
		return out, nil
	}
	if tz == "" {
		tz = r.timeZone(cal)
	}
	return map[string]any{"dateTime": t.Format("2006-01-02T15:04:05"), "timeZone": tz}, nil
}

// timeZone returns the calendar's zone (UTC when it cannot be read; the
// event call then reports the real problem).
func (r *calendarRun) timeZone(cal string) string {
	if tz, ok := r.zones[cal]; ok {
		return tz
	}
	var resp struct {
		TimeZone string `json:"timeZone"`
	}
	tz := "UTC"
	if err := r.c.do(r.ctx, apiCalendar, http.MethodGet, "/calendar/v3/calendars/"+url.PathEscape(cal), url.Values{"fields": {"timeZone"}}, nil, &resp); err == nil && resp.TimeZone != "" {
		tz = resp.TimeZone
	}
	r.zones[cal] = tz
	return tz
}

func sendUpdates(fields map[string]any) url.Values {
	if v := getString(fields, "sendUpdates", ""); v != "" {
		return url.Values{"sendUpdates": {v}}
	}
	return nil
}

var zonedLayouts = []string{time.RFC3339Nano, "2006-01-02T15:04Z07:00", "2006-01-02 15:04:05Z07:00"}
var localLayouts = []string{"2006-01-02T15:04:05.999999999", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02 15:04", time.DateOnly}

// parseDateTime reads ISO 8601 dates and times, with or without an offset.
func parseDateTime(s string) (t time.Time, hasZone bool, err error) {
	s = strings.TrimSpace(s)
	for _, layout := range zonedLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true, nil
		}
	}
	for _, layout := range localLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, false, nil
		}
	}
	return time.Time{}, false, userError("Use ISO 8601, e.g. 2026-10-25T14:00:00+02:00 or 2026-10-25.", "%q is not a date or time", s)
}

// LoadOptionsWithContext serves the calendar picker (calendarList).
func (CalendarNode) LoadOptionsWithContext(ctx *landflow.LoadOptionsContext) ([]landflow.PropertyOption, error) {
	if ctx.Method() != "calendars" {
		return nil, fmt.Errorf("unknown loadOptions method %q (supported: calendars)", ctx.Method())
	}
	c, err := newClient(ctx, ctx.ParamString("authentication", "serviceAccount"))
	if err != nil {
		return nil, err
	}
	opts := []landflow.PropertyOption{{Name: "Primary Calendar", Value: "primary"}}
	err = paginate(ctx, "google.calendar.calendar_list", -1, func(ctx context.Context, token string, _ int) (int, string, error) {
		query := url.Values{"maxResults": {"250"}}
		if token != "" {
			query.Set("pageToken", token)
		}
		var page struct {
			Items []struct {
				ID      string `json:"id"`
				Summary string `json:"summary"`
				Primary bool   `json:"primary"`
			} `json:"items"`
			NextPageToken string `json:"nextPageToken"`
		}
		if err := c.do(ctx, apiCalendar, http.MethodGet, "/calendar/v3/users/me/calendarList", query, nil, &page); err != nil {
			return 0, "", err
		}
		for _, cal := range page.Items {
			name := cal.Summary
			if cal.Primary {
				name += " (primary)"
			}
			opts = append(opts, landflow.PropertyOption{Name: name, Value: cal.ID})
		}
		return len(page.Items), page.NextPageToken, nil
	})
	return opts, err
}
