package main

import (
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/landflow/landflow/plugins/google-workspace/internal/fakegoogle"
	landflow "github.com/landflow/landflow/sdks/go"
)

// Activity items from Google: the Drive and Calendar triggers (a baseline,
// then only what changed), the Drive and Calendar node reads, and the
// Directory node, all against the fake.

// checkActivityShape fails unless item has exactly the activity item fields
// (plus extra), each required one present, as docs/protocol.md §16 says.
func checkActivityShape(t *testing.T, item map[string]any, extra ...string) {
	t.Helper()
	schema := landflow.ActivityItemSchema()
	want := []string{}
	for key := range schema["properties"].(map[string]any) {
		if key != "cursor" {
			want = append(want, key)
		}
	}
	if _, ok := item["cursor"]; ok {
		want = append(want, "cursor")
	}
	want = append(want, extra...)
	got := make([]string, 0, len(item))
	for key := range item {
		got = append(got, key)
	}
	sort.Strings(want)
	sort.Strings(got)
	if !slices.Equal(got, want) {
		t.Errorf("activity item keys = %v, want %v", got, want)
	}
	if s, _ := item["summary"].(string); len([]rune(s)) > 600 {
		t.Errorf("summary is %d characters", len([]rune(s)))
	}
	if _, err := time.Parse(time.RFC3339, item["occurredAt"].(string)); err != nil {
		t.Errorf("occurredAt %v: %v", item["occurredAt"], err)
	}
}

// editFile records an edit by email at a fixed time.
func editFile(fake *fakegoogle.Server, id, email string, at time.Time) {
	fake.TouchFile(id, email, nil)
	fake.Do(func() { fake.Files[id].Modified = at })
}

// driveTree is: My Drive/Customers/Acme (folder), and the shared drive R&D
// with Projects/Atlas. Old.pdf exists before the trigger starts.
func driveTree(h *harness) {
	h.fake.AddDrive("drive-rnd", "R&D")
	for _, f := range []*fakegoogle.File{
		{ID: "f-customers", Name: "Customers", MimeType: "application/vnd.google-apps.folder"},
		{ID: "f-acme", Name: "Acme", MimeType: "application/vnd.google-apps.folder", Parents: []string{"f-customers"}},
		{ID: "f-projects", Name: "Projects", MimeType: "application/vnd.google-apps.folder", Parents: []string{"drive-rnd"}, DriveID: "drive-rnd"},
		{ID: "f-atlas", Name: "Atlas", MimeType: "application/vnd.google-apps.folder", Parents: []string{"f-projects"}, DriveID: "drive-rnd"},
		{ID: "old", Name: "Old.pdf", MimeType: "application/pdf", Owner: "dana@example.com", Modified: time.Now().Add(-48 * time.Hour)},
	} {
		h.fake.AddFile(f)
	}
}

func TestDriveTriggerBaselineThenChanges(t *testing.T) {
	h := newHarness(t)
	driveTree(h)
	params := map[string]any{"authentication": "serviceAccount"}

	first := h.exec("googleDriveTrigger", params, execOpts{mode: landflow.ModePoll})
	if items := h.ok(first); len(items) != 0 || first.PollState["pageToken"] == "" {
		t.Fatalf("baseline = %v, state %v", items, first.PollState)
	}

	// After the baseline: a Doc under Customers/Acme edited twice, a sheet in
	// the shared drive's Projects/Atlas, a new folder and a trashed file.
	base := time.Now().UTC().Truncate(time.Second)
	h.fake.AddDocument(&fakegoogle.Document{ID: "doc-plan", Title: "Acme rollout plan", Text: "\uFEFFRollout   plan for Acme:\nphase one in December. " + strings.Repeat("More detail. ", 80)})
	h.fake.Do(func() {
		h.fake.Files["doc-plan"].Parents = []string{"f-acme"}
		h.fake.Files["doc-plan"].Owner = "dana@example.com"
	})
	editFile(h.fake, "doc-plan", "lee@example.com", base.Add(-3*time.Minute))
	h.fake.AddFile(&fakegoogle.File{ID: "sheet-atlas", Name: "Atlas budget", MimeType: "application/vnd.google-apps.spreadsheet",
		Parents: []string{"f-atlas"}, DriveID: "drive-rnd", Owner: "ignored@example.com", ModifiedBy: "kim@example.com", Modified: base.Add(-2 * time.Minute)})
	editFile(h.fake, "doc-plan", "Dana@Example.com", base.Add(-1*time.Minute))
	h.fake.AddFile(&fakegoogle.File{ID: "f-new", Name: "New folder", MimeType: "application/vnd.google-apps.folder", Modified: base})
	h.fake.AddFile(&fakegoogle.File{ID: "trash", Name: "Gone.txt", MimeType: "text/plain", Trashed: true, Modified: base})
	h.fake.PageSize = 2 // five changes: three pages

	second := h.exec("googleDriveTrigger", params, execOpts{mode: landflow.ModePoll, pollState: first.PollState})
	items := h.ok(second)
	if len(items) != 2 {
		t.Fatalf("second poll = %d items: %v", len(items), items)
	}
	sheet, doc := items[0], items[1] // oldest first; the Doc's latest edit is newer
	for _, it := range items {
		checkActivityShape(t, it)
	}
	if sheet["sourceId"] != "google-drive:sheet-atlas:"+base.Add(-2*time.Minute).Format(time.RFC3339) || sheet["kind"] != "work.doc_edited" ||
		sheet["actorEmail"] != "kim@example.com" || sheet["teamHint"] != "R&D" || sheet["initiativeHint"] != "Atlas" ||
		sheet["customerHint"] != nil || sheet["summary"] != "Google Sheet in R&D/Projects/Atlas" {
		t.Errorf("sheet = %v", sheet)
	}
	if raw := sheet["raw"].(map[string]any); raw["owner"] != "" || raw["folderPath"] != "R&D/Projects/Atlas" || raw["driveName"] != "R&D" {
		t.Errorf("sheet raw = %v (no owners on shared drives)", raw)
	}
	if doc["source"] != "google-drive" || doc["title"] != "Acme rollout plan" || doc["actorEmail"] != "dana@example.com" ||
		doc["customerHint"] != "Acme" || doc["teamHint"] != nil || doc["url"] != "https://drive.google.com/file/d/doc-plan/view" ||
		!strings.HasPrefix(doc["summary"].(string), "Rollout plan for Acme: phase one in December.") || len([]rune(doc["summary"].(string))) > 600 {
		t.Errorf("doc = %v", doc)
	}
	if raw := doc["raw"].(map[string]any); raw["owner"] != "dana@example.com" || raw["folderPath"] != "Customers/Acme" || raw["mimeType"] != "application/vnd.google-apps.document" {
		t.Errorf("doc raw = %v", raw)
	}
	if second.PollState["pageToken"] == first.PollState["pageToken"] {
		t.Errorf("page token did not move: %v", second.PollState)
	}

	// Nothing new: nothing out.
	third := h.exec("googleDriveTrigger", params, execOpts{mode: landflow.ModePoll, pollState: second.PollState})
	if items := h.ok(third); len(items) != 0 {
		t.Errorf("third poll = %v", items)
	}

	// Without shared drives, a shared-drive edit is not seen.
	editFile(h.fake, "sheet-atlas", "kim@example.com", base.Add(time.Minute))
	noShared := map[string]any{"authentication": "serviceAccount", "sharedDrives": false}
	if items := h.ok(h.exec("googleDriveTrigger", noShared, execOpts{mode: landflow.ModePoll, pollState: third.PollState})); len(items) != 0 {
		t.Errorf("shared drives off = %v", items)
	}

	// Executed in the editor: the most recent files, no state.
	manual := h.exec("googleDriveTrigger", params, execOpts{})
	if items := h.ok(manual); len(items) == 0 || len(items) > 5 || manual.PollState != nil {
		t.Errorf("manual = %d items, state %v", len(items), manual.PollState)
	}
}

func TestDriveTriggerOnlyUnderFolder(t *testing.T) {
	h := newHarness(t)
	driveTree(h)
	params := map[string]any{"authentication": "serviceAccount", "activityOptions": map[string]any{
		"folderId": "https://drive.google.com/drive/folders/f-customers", "includeText": false}}
	first := h.exec("googleDriveTrigger", params, execOpts{mode: landflow.ModePoll})
	h.fake.AddFile(&fakegoogle.File{ID: "in", Name: "In.pdf", MimeType: "application/pdf", Parents: []string{"f-acme"}, Modified: time.Now()})
	h.fake.AddFile(&fakegoogle.File{ID: "out", Name: "Out.pdf", MimeType: "application/pdf", Modified: time.Now()})
	items := h.ok(h.exec("googleDriveTrigger", params, execOpts{mode: landflow.ModePoll, pollState: first.PollState}))
	if len(items) != 1 || items[0]["title"] != "In.pdf" || items[0]["customerHint"] != "Acme" {
		t.Errorf("under Customers = %v", items)
	}
}

func TestDriveChangesSinceAndGetItem(t *testing.T) {
	h := newHarness(t)
	driveTree(h)
	h.fake.AddDocument(&fakegoogle.Document{ID: "doc-1", Title: "Spec", Text: "Full text of the spec."})
	h.fake.Do(func() { h.fake.Files["doc-1"].Modified = time.Now().Add(-time.Hour) })

	// Since a time: files.list by modifiedTime, with a cursor per item.
	since := time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339)
	items := h.ok(h.exec("googleDrive", map[string]any{"resource": "file", "operation": "changesSince", "since": since, "returnAll": true}, execOpts{}))
	if len(items) != 1 || items[0]["title"] != "Spec" || items[0]["cursor"] == nil {
		t.Fatalf("since a time = %v", items)
	}
	checkActivityShape(t, items[0])
	if items[0]["summary"] != "Full text of the spec." {
		t.Errorf("summary = %q", items[0]["summary"])
	}

	// Since a page token: the changes feed from there.
	start := len(h.fake.Changes) + 1
	editFile(h.fake, "old", "dana@example.com", time.Now())
	items = h.ok(h.exec("googleDrive", map[string]any{"resource": "file", "operation": "changesSince", "since": strconv.Itoa(start), "returnAll": true}, execOpts{}))
	if len(items) != 1 || items[0]["title"] != "Old.pdf" || items[0]["cursor"] != strconv.Itoa(start+1) {
		t.Errorf("since a token = %v", items)
	}

	// Get Item: one file, with its full text.
	got := h.ok(h.exec("googleDrive", map[string]any{"resource": "file", "operation": "getItem", "fileId": "doc-1"}, execOpts{}))
	if len(got) != 1 || got[0]["text"] != "Full text of the spec." || got[0]["sourceId"] == nil {
		t.Fatalf("get item = %v", got)
	}
	checkActivityShape(t, got[0], "text")
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

func calendarEvent(id, summary string, start time.Time, updated time.Time, attendees ...string) map[string]any {
	var list []any
	for k, email := range attendees {
		list = append(list, map[string]any{"email": email, "responseStatus": "accepted", "organizer": k == 0})
	}
	list = append(list, map[string]any{"email": "room-1@resource.calendar.google.com", "resource": true})
	return map[string]any{
		"id": id, "status": "confirmed", "summary": summary, "description": "Agenda:<br>pricing &amp; <b>rollout</b>",
		"htmlLink": "https://calendar.google.com/event?eid=" + id, "organizer": map[string]any{"email": attendees[0]},
		"start": map[string]any{"dateTime": start.Format(time.RFC3339)}, "end": map[string]any{"dateTime": start.Add(time.Hour).Format(time.RFC3339)},
		"attendees": list, "updated": updated.UTC().Format(time.RFC3339Nano),
	}
}

func TestCalendarTriggerSyncToken(t *testing.T) {
	h := newHarness(t)
	h.fake.AddCalendar(&fakegoogle.Calendar{ID: "me@example.com", Summary: "Me", Primary: true})
	now := time.Now().UTC().Truncate(time.Second)
	h.fake.UpsertEvent("me@example.com", calendarEvent("before", "Old sync", now.Add(-72*time.Hour), now.Add(-72*time.Hour), "me@example.com"))
	params := map[string]any{"authentication": "serviceAccount", "calendar": "primary"}

	first := h.exec("googleCalendarTrigger", params, execOpts{mode: landflow.ModePoll})
	if items := h.ok(first); len(items) != 0 || !strings.HasPrefix(first.PollState["syncToken"].(string), "sync-") {
		t.Fatalf("baseline = %v, state %v", items, first.PollState)
	}

	h.fake.UpsertEvent("me@example.com", calendarEvent("kickoff", "Acme kickoff", now.Add(48*time.Hour), now.Add(time.Second),
		"me@example.com", "dana@example.com", "buyer@acme.io"))
	h.fake.UpsertEvent("me@example.com", calendarEvent("retro", "Sprint retro", now.Add(-3*time.Hour), now.Add(2*time.Second),
		"me@example.com", "lee@example.com"))
	cancelled := calendarEvent("dropped", "Dropped sync", now.Add(24*time.Hour), now.Add(3*time.Second), "me@example.com")
	cancelled["status"] = "cancelled"
	h.fake.Do(func() {
		h.fake.Calendars["me@example.com"].Deleted = append(h.fake.Calendars["me@example.com"].Deleted, cancelled)
	})

	second := h.exec("googleCalendarTrigger", params, execOpts{mode: landflow.ModePoll, pollState: first.PollState})
	items := h.ok(second)
	if len(items) != 2 {
		t.Fatalf("second poll = %v", items)
	}
	kickoff, retro := items[0], items[1]
	for _, it := range items {
		checkActivityShape(t, it)
	}
	if kickoff["kind"] != "work.meeting_scheduled" || kickoff["customerHint"] != "acme.io" || kickoff["actorEmail"] != "me@example.com" ||
		kickoff["summary"] != "Agenda: pricing & rollout Attendees: me@example.com, dana@example.com, buyer@acme.io" ||
		!strings.HasPrefix(kickoff["sourceId"].(string), "google-calendar:primary:kickoff:") {
		t.Errorf("kickoff = %v", kickoff)
	}
	if attendees := kickoff["raw"].(map[string]any)["attendees"].([]any); len(attendees) != 3 {
		t.Errorf("attendees (rooms left out) = %v", attendees)
	}
	if retro["kind"] != "work.meeting_held" || retro["customerHint"] != nil {
		t.Errorf("retro = %v", retro)
	}

	// Include Cancelled Events: the cancellation comes out too.
	withCancelled := map[string]any{"authentication": "serviceAccount", "calendar": "primary", "activityOptions": map[string]any{"includeCancelled": true}}
	all := h.ok(h.exec("googleCalendarTrigger", withCancelled, execOpts{mode: landflow.ModePoll, pollState: first.PollState}))
	if len(all) != 3 || all[2]["kind"] != "work.meeting_cancelled" {
		t.Errorf("with cancelled = %v", all)
	}

	// Nothing changed: nothing out.
	if items := h.ok(h.exec("googleCalendarTrigger", params, execOpts{mode: landflow.ModePoll, pollState: second.PollState})); len(items) != 0 {
		t.Errorf("third poll = %v", items)
	}

	// An expired sync token (410): a fresh baseline, nothing out.
	gone := h.exec("googleCalendarTrigger", params, execOpts{mode: landflow.ModePoll, pollState: map[string]any{"syncToken": "expired", "pageToken": ""}})
	if items := h.ok(gone); len(items) != 0 || !strings.HasPrefix(gone.PollState["syncToken"].(string), "sync-") {
		t.Errorf("after 410 = %v, state %v", items, gone.PollState)
	}
}

func TestCalendarTriggerPaginates(t *testing.T) {
	h := newHarness(t)
	h.fake.AddCalendar(&fakegoogle.Calendar{ID: "me@example.com", Primary: true})
	params := map[string]any{"calendar": "primary"}
	first := h.exec("googleCalendarTrigger", params, execOpts{mode: landflow.ModePoll})
	now := time.Now().UTC()
	for k := range 5 {
		h.fake.UpsertEvent("me@example.com", calendarEvent("e"+strconv.Itoa(k), "Event "+strconv.Itoa(k), now.Add(time.Duration(k+1)*time.Hour), now.Add(time.Duration(k+1)*time.Second), "me@example.com"))
	}
	h.fake.PageSize = 2
	items := h.ok(h.exec("googleCalendarTrigger", params, execOpts{mode: landflow.ModePoll, pollState: first.PollState}))
	if len(items) != 5 || items[0]["title"] != "Event 0" || items[4]["title"] != "Event 4" {
		t.Errorf("paged = %v", items)
	}
}

func TestCalendarChangedSince(t *testing.T) {
	h := newHarness(t)
	h.fake.AddCalendar(&fakegoogle.Calendar{ID: "me@example.com", Primary: true})
	now := time.Now().UTC()
	h.fake.UpsertEvent("me@example.com", calendarEvent("old", "Old", now.Add(-100*time.Hour), now.Add(-100*time.Hour), "me@example.com"))
	h.fake.UpsertEvent("me@example.com", calendarEvent("new", "New", now.Add(time.Hour), now.Add(-time.Minute), "me@example.com", "x@partner.com"))
	items := h.ok(h.exec("googleCalendar", map[string]any{"resource": "event", "operation": "changedSince", "calendar": "primary",
		"since": now.Add(-time.Hour).Format(time.RFC3339), "returnAll": true}, execOpts{}))
	if len(items) != 1 || items[0]["title"] != "New" || items[0]["customerHint"] != "partner.com" || items[0]["cursor"] == nil {
		t.Fatalf("changed since = %v", items)
	}
	checkActivityShape(t, items[0])
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

func directoryUsers(h *harness) {
	for _, u := range []fakegoogle.DirectoryUser{
		{"id": "1", "primaryEmail": "dana@example.com", "name": map[string]any{"fullName": "Dana Levi"}, "orgUnitPath": "/Engineering/Platform",
			"organizations": []any{map[string]any{"title": "Old title"}, map[string]any{"title": "Staff Engineer", "department": "R&D", "primary": true}},
			"relations":     []any{map[string]any{"type": "assistant", "value": "x@example.com"}, map[string]any{"type": "manager", "value": "Lee@Example.com"}}},
		{"id": "2", "primaryEmail": "lee@example.com", "name": map[string]any{"givenName": "Lee", "familyName": "Cohen"}, "orgUnitPath": "/Engineering", "isAdmin": true},
		{"id": "3", "primaryEmail": "kim@example.com", "orgUnitPath": "/Sales", "suspended": true},
		{"id": "4", "primaryEmail": "ana@example.com", "orgUnitPath": "/Sales"},
	} {
		h.fake.AddDirectoryUser(u)
	}
}

func TestDirectoryListsPeople(t *testing.T) {
	h := newHarness(t)
	directoryUsers(h)
	h.fake.DirectoryAdmins = []string{"admin@example.com"}
	h.fake.PageSize = 1
	params := map[string]any{"resource": "user", "operation": "getAll", "returnAll": true, "adminEmail": "admin@example.com"}
	people := h.ok(h.exec("googleDirectory", params, execOpts{}))
	if len(people) != 3 { // the suspended one is left out
		t.Fatalf("people = %v", people)
	}
	if people[0]["email"] != "ana@example.com" || people[1]["email"] != "dana@example.com" || people[2]["email"] != "lee@example.com" {
		t.Errorf("order = %v", people)
	}
	dana := people[1]
	if dana["name"] != "Dana Levi" || dana["title"] != "Staff Engineer" || dana["department"] != "R&D" ||
		dana["managerEmail"] != "lee@example.com" || dana["orgUnitPath"] != "/Engineering/Platform" {
		t.Errorf("dana = %v", dana)
	}
	if people[2]["name"] != "Lee Cohen" || people[2]["isAdmin"] != true {
		t.Errorf("lee = %v", people[2])
	}

	// The token asked for the directory scope alone, acting as the admin.
	ex := h.fake.ExchangeList()
	if len(ex) != 1 || ex[0].Claims["sub"] != "admin@example.com" || ex[0].Claims["scope"] != directoryScope {
		t.Errorf("exchange claims = %v", ex[0].Claims)
	}

	// Filters: an org unit, suspended included.
	sales := h.ok(h.exec("googleDirectory", map[string]any{"resource": "user", "operation": "getAll", "returnAll": true, "adminEmail": "admin@example.com",
		"filters": map[string]any{"orgUnitPath": "/Sales", "showSuspended": true}}, execOpts{}))
	if len(sales) != 2 || sales[1]["suspended"] != true {
		t.Errorf("sales = %v", sales)
	}

	// A limit stops paging.
	two := h.ok(h.exec("googleDirectory", map[string]any{"resource": "user", "operation": "getAll", "limit": 2, "adminEmail": "admin@example.com"}, execOpts{}))
	if len(two) != 2 {
		t.Errorf("limit 2 = %v", two)
	}

	// Get one by email.
	one := h.ok(h.exec("googleDirectory", map[string]any{"resource": "user", "operation": "get", "userKey": "dana@example.com", "adminEmail": "admin@example.com"}, execOpts{}))
	if len(one) != 1 || one[0]["managerEmail"] != "lee@example.com" {
		t.Errorf("get = %v", one)
	}
}

func TestDirectoryNeedsAnAdmin(t *testing.T) {
	h := newHarness(t)
	directoryUsers(h)
	h.fake.DirectoryAdmins = []string{"admin@example.com"}

	// The credential's delegated user (me@) is not an admin: Google says 403.
	resp := h.exec("googleDirectory", map[string]any{"resource": "user", "operation": "getAll"}, execOpts{})
	if resp.Error == nil || !strings.Contains(errorText(resp), "Not Authorized") {
		t.Errorf("non-admin = %+v", resp.Error)
	}

	// No one to impersonate at all.
	sa := h.sa()
	delete(sa, "delegatedEmail")
	resp = h.exec("googleDirectory", map[string]any{"resource": "user", "operation": "getAll"}, execOpts{creds: map[string]any{credServiceAccount: sa}})
	if resp.Error == nil || !strings.Contains(errorText(resp), "admin") {
		t.Errorf("no subject = %+v", resp.Error)
	}

	// OAuth needs no admin field (the signed-in user's own rights apply).
	people := h.ok(h.exec("googleDirectory", map[string]any{"authentication": "oAuth2", "resource": "user", "operation": "getAll", "returnAll": true},
		execOpts{creds: map[string]any{credOAuth2: h.oauth()}}))
	if len(people) != 3 {
		t.Errorf("oauth people = %v", people)
	}
}

// The standalone fake's control endpoints feed the triggers while a flow runs.
func TestFakeActivityEndpoints(t *testing.T) {
	h := newHarness(t)
	driveTree(h)
	post := func(path, body string) {
		t.Helper()
		resp, err := http.Post(h.url+path, "application/json", strings.NewReader(body))
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("POST %s: %v %v", path, err, resp)
		}
		resp.Body.Close()
	}
	first := h.exec("googleDriveTrigger", map[string]any{}, execOpts{mode: landflow.ModePoll})
	post("/_fake/drive/docs", `{"id":"doc-9","title":"Acme notes","text":"Notes.","parents":["f-acme"],"editor":"dana@example.com"}`)
	items := h.ok(h.exec("googleDriveTrigger", map[string]any{}, execOpts{mode: landflow.ModePoll, pollState: first.PollState}))
	if len(items) != 1 || items[0]["summary"] != "Notes." || items[0]["customerHint"] != "Acme" || items[0]["actorEmail"] != "dana@example.com" {
		t.Errorf("drive = %v", items)
	}

	cal := h.exec("googleCalendarTrigger", map[string]any{}, execOpts{mode: landflow.ModePoll})
	post("/_fake/calendar/me@example.com/events", `{"id":"ev-9","summary":"Acme sync","start":{"dateTime":"2030-01-01T10:00:00Z"},"end":{"dateTime":"2030-01-01T11:00:00Z"}}`)
	if items := h.ok(h.exec("googleCalendarTrigger", map[string]any{}, execOpts{mode: landflow.ModePoll, pollState: cal.PollState})); len(items) != 1 || items[0]["title"] != "Acme sync" {
		t.Errorf("calendar = %v", items)
	}

	post("/_fake/directory/users", `{"primaryEmail":"new@example.com","orgUnitPath":"/Sales"}`)
	if people := h.ok(h.exec("googleDirectory", map[string]any{"returnAll": true}, execOpts{})); len(people) != 1 || people[0]["email"] != "new@example.com" {
		t.Errorf("directory = %v", people)
	}
}
