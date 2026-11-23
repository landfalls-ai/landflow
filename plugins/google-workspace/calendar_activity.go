package main

import (
	"context"
	"errors"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Calendar events as activity items (docs/protocol.md §16): the Google
// Calendar Trigger polls events.list with a sync token (only what changed
// since the last poll, deletions included), and the Calendar node's Event →
// Get Many Changed Since reads changes after a time (updatedMin).
//
// Calendar can push to a channel (events.watch), but channels expire and must
// be renewed by the caller, and Landflow's app webhooks have no renewal, so the
// trigger polls with the sync token instead.

const (
	// calendarMaxPages caps the pages of one full or incremental sync (2,500
	// events each); a larger first sync keeps going at the next poll.
	calendarMaxPages     = 20
	calendarManualEvents = 5
)

var htmlTag = regexp.MustCompile(`<[^>]+>`)

func calendarActivityOptions(d *landflow.DisplayOptions) landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: "activityOptions", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{},
		Placeholder: "Add Option", DisplayOptions: d,
		Values: []landflow.PropertyDescriptor{
			{Name: "includeCancelled", DisplayName: "Include Cancelled Events", Type: landflow.PropBoolean, Default: false,
				Description: "Whether cancelled and deleted events are output too (kind work.meeting_cancelled)"},
			{Name: "internalDomains", DisplayName: "Internal Domains", Type: landflow.PropString, Default: "",
				Placeholder: "acme.com, acme.io",
				Description: "Your company's email domains: the first attendee from another domain names the customer (customerHint). Empty: the organizer's domain is internal."},
			{Name: "includeDescription", DisplayName: "Include Description", Type: landflow.PropBoolean, Default: true,
				Description: "Whether the event description is the summary (else only the attendees)"},
		},
	}
}

type calendarActivity struct {
	calendarID         string
	includeCancelled   bool
	includeDescription bool
	internal           []string
}

func newCalendarActivity(ctx *landflow.ExecuteContext, calendarID string, i int) *calendarActivity {
	opts := asMap(ctx.Param("activityOptions", i))
	var internal []string
	for _, d := range strings.Split(getString(opts, "internalDomains", ""), ",") {
		if d = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(d), "@"))); d != "" {
			internal = append(internal, d)
		}
	}
	return &calendarActivity{
		calendarID:         calendarID,
		includeCancelled:   getBool(opts, "includeCancelled", false),
		includeDescription: getBool(opts, "includeDescription", true),
		internal:           internal,
	}
}

func domainOf(email string) string {
	_, domain, _ := strings.Cut(strings.ToLower(email), "@")
	return domain
}

// eventTime is an event boundary: dateTime, or an all-day date (UTC).
func eventTime(ev map[string]any, key string) (time.Time, bool) {
	m := asMap(ev[key])
	if dt := getString(m, "dateTime", ""); dt != "" {
		t, err := time.Parse(time.RFC3339, dt)
		return t, err == nil
	}
	if d := getString(m, "date", ""); d != "" {
		t, err := time.Parse(time.DateOnly, d)
		return t, err == nil
	}
	return time.Time{}, false
}

// keep reports whether an event is output (cancelled ones only when asked).
func (a *calendarActivity) keep(ev map[string]any) bool {
	return a.includeCancelled || getString(ev, "status", "") != "cancelled"
}

// item builds one activity item: held (ended), scheduled (still to come) or
// cancelled, with the attendees in raw.
func (a *calendarActivity) item(ev map[string]any, cursor *string) (map[string]any, error) {
	id := getString(ev, "id", "")
	updated := getString(ev, "updated", "")
	start, hasStart := eventTime(ev, "start")
	end, hasEnd := eventTime(ev, "end")
	kind := "work.meeting_scheduled"
	switch {
	case getString(ev, "status", "") == "cancelled":
		kind = "work.meeting_cancelled"
	case hasEnd && end.Before(now()):
		kind = "work.meeting_held"
	}
	organizer := getString(asMap(ev["organizer"]), "email", "")
	if organizer == "" {
		organizer = getString(asMap(ev["creator"]), "email", "")
	}
	internal := a.internal
	if len(internal) == 0 && organizer != "" {
		internal = []string{domainOf(organizer)}
	}
	var attendees []any
	var names []string
	customer := ""
	for _, raw := range asSlice(ev["attendees"]) {
		at := asMap(raw)
		email := getString(at, "email", "")
		if getBool(at, "resource", false) {
			continue
		}
		attendees = append(attendees, map[string]any{
			"email": email, "displayName": at["displayName"], "responseStatus": at["responseStatus"],
			"organizer": getBool(at, "organizer", false), "optional": getBool(at, "optional", false),
		})
		names = append(names, firstNonEmpty(getString(at, "displayName", ""), email))
		if d := domainOf(email); customer == "" && d != "" && len(internal) > 0 && !slices.Contains(internal, d) {
			customer = d
		}
	}
	summary := ""
	if a.includeDescription {
		summary = html.UnescapeString(htmlTag.ReplaceAllString(strings.ReplaceAll(getString(ev, "description", ""), "<br>", "\n"), " "))
	}
	if len(names) > 0 {
		summary = strings.TrimSpace(summary + "\nAttendees: " + strings.Join(names, ", "))
	}
	occurred := updated
	if hasStart {
		occurred = start.UTC().Format(time.RFC3339)
	}
	if occurred == "" {
		occurred = now().UTC().Format(time.RFC3339)
	}
	raw := map[string]any{
		"id": id, "calendarId": a.calendarID, "status": ev["status"], "summary": ev["summary"], "start": ev["start"], "end": ev["end"],
		"organizer": organizer, "attendees": attendees, "location": ev["location"], "hangoutLink": ev["hangoutLink"],
		"recurringEventId": ev["recurringEventId"], "updated": updated,
	}
	return landflow.ActivityItem(landflow.Activity{
		Source:       "google-calendar",
		SourceID:     "google-calendar:" + a.calendarID + ":" + id + ":" + updated,
		URL:          getString(ev, "htmlLink", ""),
		ActorEmail:   organizer,
		OccurredAt:   occurred,
		Kind:         kind,
		Title:        firstNonEmpty(getString(ev, "summary", ""), "(no title)"),
		Summary:      summary,
		CustomerHint: customer,
		Raw:          raw,
		Cursor:       cursor,
	})
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}

type eventPage struct {
	Items         []map[string]any `json:"items"`
	NextPageToken string           `json:"nextPageToken"`
	NextSyncToken string           `json:"nextSyncToken"`
}

// errSyncTokenGone is Google's 410: the sync token expired, a full sync is due.
var errSyncTokenGone = errors.New("sync token gone")

// syncEvents pages events.list from a sync token ("" = a full sync): the
// events and the next sync token (or, when maxPages ran out, the page token
// to continue with, as {pageToken}).
func syncEvents(ctx spanContext, c *client, calendarID, syncToken, pageToken string, maxPages int) ([]map[string]any, string, string, error) {
	var events []map[string]any
	next, nextPage := "", ""
	err := ctx.Span("google.calendar.events.sync", landflow.Attrs{"google.full_sync": syncToken == ""}, func(span landflow.Span) error {
		token := pageToken
		for page := 0; page < maxPages; page++ {
			query := url.Values{"maxResults": {"2500"}}
			if syncToken != "" {
				query.Set("syncToken", syncToken)
			}
			if token != "" {
				query.Set("pageToken", token)
			}
			var p eventPage
			if err := c.do(span, apiCalendar, http.MethodGet, eventsPath(calendarID), query, nil, &p); err != nil {
				var apiErr *apiError
				if errors.As(err, &apiErr) && apiErr.status == http.StatusGone {
					return errSyncTokenGone
				}
				return err
			}
			events = append(events, p.Items...)
			if p.NextPageToken == "" {
				next = p.NextSyncToken
				return nil
			}
			token = p.NextPageToken
		}
		nextPage = token
		return nil
	})
	return events, next, nextPage, err
}

func sortByUpdated(events []map[string]any) {
	slices.SortStableFunc(events, func(x, y map[string]any) int {
		return strings.Compare(getString(x, "updated", ""), getString(y, "updated", ""))
	})
}

// ---------------------------------------------------------------------------
// Google Calendar Trigger
// ---------------------------------------------------------------------------

// CalendarTriggerNode polls a calendar with a sync token. State: {syncToken}
// (or, while a large first sync is still paging, {syncToken: "", pageToken}).
type CalendarTriggerNode struct{}

func (CalendarTriggerNode) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name:             "googleCalendarTrigger",
		DisplayName:      "Google Calendar Trigger",
		Description:      "Starts the workflow when events are created, changed or cancelled in a Google Calendar, with each event (and its attendees) as an activity item",
		Version:          landflow.V(1),
		Kind:             landflow.KindTrigger,
		TriggerSource:    landflow.TriggerPoll,
		Categories:       []string{"Productivity"},
		Icon:             "file:icons/calendar.svg",
		Color:            "#4285F4",
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		DocumentationURL: "https://developers.google.com/workspace/calendar/api/guides/sync",
		Keywords:         []string{"calendar", "meeting", "event changed", "attendees", "activity", "poll"},
		Credentials:      credentialRequirements(),
		OutputSchema:     landflow.ActivityItemSchema(),
		Properties: []landflow.PropertyDescriptor{
			authProperty(),
			landflow.PollIntervalProperty(300),
			{Name: "pollNotice", DisplayName: "The first poll reads the calendar once to get Google's sync token and outputs nothing; later polls output the events changed since. Executing the node in the editor returns the 5 most recently updated events.", Type: landflow.PropNotice, Default: ""},
			{
				Name: "calendar", DisplayName: "Calendar", Type: landflow.PropOptions, Default: "primary", Required: true,
				Description: "Calendar to watch. An expression may also give a calendar ID (often an email address).",
				Options:     []landflow.PropertyOption{{Name: "Primary Calendar", Value: "primary"}},
				TypeOptions: &landflow.TypeOptions{LoadOptionsMethod: "calendars"},
			},
			calendarActivityOptions(nil),
		},
	}
}

func (CalendarTriggerNode) LoadOptionsWithContext(ctx *landflow.LoadOptionsContext) ([]landflow.PropertyOption, error) {
	return CalendarNode{}.LoadOptionsWithContext(ctx)
}

func (CalendarTriggerNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	c, err := newClient(ctx, ctx.ParamString("authentication", 0, "serviceAccount"))
	if err != nil {
		return nil, err
	}
	calendarID := strings.TrimSpace(ctx.ParamString("calendar", 0, "primary"))
	if calendarID == "" {
		calendarID = "primary"
	}
	a := newCalendarActivity(ctx, calendarID, 0)
	state := landflow.CredentialData(ctx.PollState())

	var events []map[string]any
	switch {
	case ctx.Mode() == landflow.ModeManual:
		events, err = changedEvents(ctx, c, calendarID, now().Add(-7*24*time.Hour), a.includeCancelled, -1)
		if err != nil {
			return nil, err
		}
		if len(events) > calendarManualEvents {
			events = events[len(events)-calendarManualEvents:]
		}
	case ctx.IsFirstPoll() || state.String("syncToken") == "":
		// Baseline: page through the calendar for the sync token, output nothing.
		_, next, nextPage, err := syncEvents(ctx, c, calendarID, "", state.String("pageToken"), calendarMaxPages)
		if err != nil {
			return nil, err
		}
		ctx.SetPollState(map[string]any{"syncToken": next, "pageToken": nextPage})
		return nil, nil
	default:
		var next, nextPage string
		events, next, nextPage, err = syncEvents(ctx, c, calendarID, state.String("syncToken"), state.String("pageToken"), calendarMaxPages)
		if errors.Is(err, errSyncTokenGone) {
			ctx.Logger.Warn("Google expired the sync token (410): reading the calendar again for a new one; changes in between are not output")
			_, next, nextPage, err = syncEvents(ctx, c, calendarID, "", "", calendarMaxPages)
			if err != nil {
				return nil, err
			}
			ctx.SetPollState(map[string]any{"syncToken": next, "pageToken": nextPage})
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if nextPage != "" {
			// More changes than one poll reads: keep the old sync token and continue from the page.
			next = state.String("syncToken")
		}
		ctx.SetPollState(map[string]any{"syncToken": next, "pageToken": nextPage})
		sortByUpdated(events)
	}
	items := make([]landflow.Item, 0, len(events))
	for _, ev := range events {
		if !a.keep(ev) {
			continue
		}
		item, err := a.item(ev, nil)
		if err != nil {
			return nil, err
		}
		items = append(items, landflow.Item{JSON: item})
	}
	if len(items) > 0 && ctx.Mode() != landflow.ModeManual {
		ctx.Metrics().Counter("landflow.google.poll.new_items", landflow.WithDescription("New items found by Google polling triggers")).
			Add(float64(len(items)), landflow.Attrs{"trigger": "calendar"})
		ctx.Logger.Info("%d changed event(s)", len(items))
	}
	return [][]landflow.Item{items}, nil
}

// changedEvents lists events updated at or after since, oldest change first,
// at most want (< 0: all).
func changedEvents(ctx spanContext, c *client, calendarID string, since time.Time, cancelled bool, want int) ([]map[string]any, error) {
	var events []map[string]any
	err := paginate(ctx, "google.calendar.events.list", want, func(cctx context.Context, token string, remaining int) (int, string, error) {
		query := url.Values{"updatedMin": {since.UTC().Format(time.RFC3339)}, "maxResults": {strconv.Itoa(pageSize(remaining, 2500))}, "showDeleted": {strconv.FormatBool(cancelled)}}
		if token != "" {
			query.Set("pageToken", token)
		}
		var p eventPage
		if err := c.do(cctx, apiCalendar, http.MethodGet, eventsPath(calendarID), query, nil, &p); err != nil {
			return 0, "", err
		}
		events = append(events, p.Items...)
		return len(p.Items), p.NextPageToken, nil
	})
	sortByUpdated(events)
	if want >= 0 && len(events) > want {
		events = events[:want]
	}
	return events, err
}

// changedSince is Event → Get Many Changed Since.
func (r *calendarRun) changedSince(i int) ([]map[string]any, error) {
	cal := r.calendar(i)
	a := newCalendarActivity(r.ctx, cal, i)
	since := now().Add(-24 * time.Hour)
	if s := strings.TrimSpace(r.ctx.ParamString("since", i, "")); s != "" {
		iso, err := landflow.ToISOTime(s)
		if err != nil {
			return nil, userError("Give an ISO time (2026-11-12T08:00:00Z) or a cursor from an earlier item.", "Since is not a time")
		}
		since, _ = time.Parse(time.RFC3339, iso)
	}
	events, err := changedEvents(r.ctx, r.c, cal, since, a.includeCancelled, limitFor(r.ctx, i, 50))
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(events))
	for _, ev := range events {
		if !a.keep(ev) {
			continue
		}
		cursor := getString(ev, "updated", "")
		item, err := a.item(ev, &cursor)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}
