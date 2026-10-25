package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/landflow/landflow/plugins/google-workspace/internal/fakegoogle"
	landflow "github.com/landflow/landflow/sdks/go"
)

// leads seeds spreadsheet "sheet-1" with a "Leads" tab (header + 3 rows)
// and an empty "Empty" tab.
func (h *harness) leads() {
	h.fake.AddSpreadsheet("sheet-1", "CRM",
		&fakegoogle.Sheet{ID: 0, Title: "Leads", Rows: [][]any{
			{"Name", "Email", "Score"},
			{"Ada", "ada@example.com", 90.0},
			{"Bob", "bob@example.com", 50.0},
			{"Cy", "cy@example.com", 90.0},
		}},
		&fakegoogle.Sheet{ID: 1, Title: "Empty"},
	)
}

func sheetParams(operation string, extra map[string]any) map[string]any {
	p := map[string]any{"resource": "sheet", "operation": operation, "documentId": "sheet-1", "sheetName": "Leads"}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func jsonBody(t *testing.T, r fakegoogle.Request) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.Body, &m); err != nil {
		t.Fatalf("%s %s body: %v", r.Method, r.Path, err)
	}
	return m
}

func TestSheetsAppendAutoMap(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	h.leads()
	items := []map[string]any{
		{"Name": "Dee", "Email": "dee@example.com", "Score": 70.0, "Extra": "ignored"},
		{"Name": "Eve", "Email": "eve@example.com", "Score": "65"},
		{"Name": "Fay", "Tags": []any{"a"}},
	}
	out := h.ok(h.exec("googleSheets", sheetParams("append", nil), execOpts{items: items}))
	want := []map[string]any{
		{"Name": "Dee", "Email": "dee@example.com", "Score": 70.0, "row_number": 5},
		{"Name": "Eve", "Email": "eve@example.com", "Score": "65", "row_number": 6},
		{"Name": "Fay", "Email": "", "Score": "", "row_number": 7},
	}
	if !reflect.DeepEqual(out, want) {
		t.Errorf("output = %v", out)
	}
	// One append request for the three items, entered as the user would type.
	appends := h.fake.Calls(http.MethodPost, "/v4/spreadsheets/sheet-1/values/'Leads':append")
	if len(appends) != 1 {
		t.Fatalf("%d append calls, want 1", len(appends))
	}
	if q := appends[0].Query; q.Get("valueInputOption") != "USER_ENTERED" || q.Get("insertDataOption") != "INSERT_ROWS" {
		t.Errorf("append query = %v", q)
	}
	rows := h.fake.SheetRows("sheet-1", "Leads")
	if len(rows) != 7 || !reflect.DeepEqual(rows[5], []any{"Eve", "eve@example.com", 65.0}) {
		t.Errorf("sheet rows = %v", rows)
	}
	if got := tel.counter(t, "landflow.google.sheets.rows_appended", map[string]string{"mode": "auto"}); got != 3 {
		t.Errorf("rows_appended{mode=auto} = %v", got)
	}
}

func TestSheetsAppendCreatesHeader(t *testing.T) {
	h := newHarness(t)
	h.leads()
	items := []map[string]any{{"b": 1.0, "a": "x"}, {"c": true, "a": "y"}}
	out := h.ok(h.exec("googleSheets", sheetParams("append", map[string]any{"sheetName": "Empty"}), execOpts{items: items}))
	rows := h.fake.SheetRows("sheet-1", "Empty")
	// Item keys are sorted (Go maps lose JSON order); later items add columns.
	want := [][]any{{"a", "b", "c"}, {"x", 1.0, ""}, {"y", "", true}}
	if !reflect.DeepEqual(rows, want) {
		t.Errorf("rows = %v", rows)
	}
	if len(out) != 2 || out[1]["c"] != true || out[1]["row_number"] != 3 {
		t.Errorf("output = %v", out)
	}
	header := h.fake.Calls(http.MethodPost, "/v4/spreadsheets/sheet-1/values:batchUpdate")
	if len(header) != 1 || jsonBody(t, header[0])["valueInputOption"] != "RAW" {
		t.Errorf("header write = %+v", header)
	}
}

func TestSheetsAppendDefineBelow(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	h.leads()
	fields := func(pairs ...string) map[string]any {
		var list []any
		for k := 0; k < len(pairs); k += 2 {
			list = append(list, map[string]any{"fieldId": pairs[k], "fieldValue": pairs[k+1]})
		}
		return map[string]any{"fieldValues": list}
	}
	params := sheetParams("append", map[string]any{"dataMode": "defineBelow", "fieldsUi": fields("Email", "gil@example.com", "Name", "Gil")})
	out := h.ok(h.exec("googleSheets", params, execOpts{}))
	if len(out) != 1 || out[0]["Name"] != "Gil" || out[0]["Score"] != "" || out[0]["row_number"] != 5 {
		t.Errorf("output = %v", out)
	}
	if got := tel.counter(t, "landflow.google.sheets.rows_appended", map[string]string{"mode": "manual"}); got != 1 {
		t.Errorf("rows_appended{mode=manual} = %v", got)
	}

	// A column that is not in the header is an item error.
	resp := h.exec("googleSheets", params, execOpts{
		items:   []map[string]any{{}, {}},
		perItem: []map[string]any{{}, {"fieldsUi": fields("Phone", "123")}},
	})
	if resp.Error == nil || resp.Error.ItemIndex == nil || *resp.Error.ItemIndex != 1 ||
		resp.Error.Message != `Column "Phone" is not in the sheet` || !strings.Contains(resp.Error.Description, "Name, Email, Score") {
		t.Errorf("error = %+v", resp.Error)
	}
}

func TestSheetsRead(t *testing.T) {
	h := newHarness(t)
	h.leads()
	all := h.ok(h.exec("googleSheets", sheetParams("read", nil), execOpts{}))
	if len(all) != 3 || all[0]["Name"] != "Ada" || all[0]["Score"] != 90.0 || all[0]["row_number"] != 2 {
		t.Errorf("all rows = %v", all)
	}
	reads := h.fake.Calls(http.MethodGet, "/v4/spreadsheets/sheet-1/values/'Leads'")
	if len(reads) != 1 || reads[0].Query.Get("valueRenderOption") != "UNFORMATTED_VALUE" ||
		reads[0].Query.Get("dateTimeRenderOption") != "FORMATTED_STRING" {
		t.Errorf("read calls = %+v", reads)
	}

	filter := func(col, value string) map[string]any {
		return map[string]any{"values": []any{map[string]any{"lookupColumn": col, "lookupValue": value}}}
	}
	first := h.ok(h.exec("googleSheets", sheetParams("read", map[string]any{"filtersUI": filter("Score", "90")}), execOpts{}))
	if len(first) != 1 || first[0]["Name"] != "Ada" {
		t.Errorf("first match = %v", first)
	}
	every := h.ok(h.exec("googleSheets", sheetParams("read", map[string]any{
		"filtersUI": filter("Score", "90"), "options": map[string]any{"returnAllMatches": "returnAllMatches"},
	}), execOpts{}))
	if len(every) != 2 || every[1]["Name"] != "Cy" || every[1]["row_number"] != 4 {
		t.Errorf("all matches = %v", every)
	}
	either := h.ok(h.exec("googleSheets", sheetParams("read", map[string]any{
		"filtersUI": map[string]any{"values": []any{
			map[string]any{"lookupColumn": "Name", "lookupValue": "Bob"},
			map[string]any{"lookupColumn": "Name", "lookupValue": "Cy"},
		}},
		"combineFilters": "OR", "options": map[string]any{"returnAllMatches": "returnAllMatches"},
	}), execOpts{}))
	if len(either) != 2 || either[0]["Name"] != "Bob" {
		t.Errorf("OR matches = %v", either)
	}
	resp := h.exec("googleSheets", sheetParams("read", map[string]any{"filtersUI": filter("Nope", "1")}), execOpts{})
	if resp.Error == nil || resp.Error.Message != `Column "Nope" is not in the sheet` {
		t.Errorf("unknown filter column error = %+v", resp.Error)
	}

	// An empty sheet name reads the first sheet; a URL works as the document.
	url := "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=0"
	rows := h.ok(h.exec("googleSheets", sheetParams("read", map[string]any{"documentId": url, "sheetName": ""}), execOpts{}))
	if len(rows) != 3 {
		t.Errorf("first sheet by URL = %v", rows)
	}
}

func TestSheetsUpdateAndUpsert(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	h.leads()
	params := sheetParams("update", map[string]any{"columnToMatchOn": "Email"})
	out := h.ok(h.exec("googleSheets", params, execOpts{items: []map[string]any{{"Email": "bob@example.com", "Score": 75.0, "Other": 1.0}}}))
	if len(out) != 1 || out[0]["Score"] != 75.0 || out[0]["Name"] != "Bob" || out[0]["row_number"] != 3 {
		t.Errorf("update output = %v", out)
	}
	upd := h.fake.Calls(http.MethodPost, "/v4/spreadsheets/sheet-1/values:batchUpdate")
	if len(upd) != 1 {
		t.Fatalf("%d batchUpdate calls", len(upd))
	}
	body := jsonBody(t, upd[0])
	data := body["data"].([]any)
	if body["valueInputOption"] != "USER_ENTERED" || len(data) != 1 || data[0].(map[string]any)["range"] != "'Leads'!C3" {
		t.Errorf("batchUpdate body = %v", body)
	}
	if rows := h.fake.SheetRows("sheet-1", "Leads"); rows[2][2] != 75.0 {
		t.Errorf("row 3 = %v", rows[2])
	}

	resp := h.exec("googleSheets", params, execOpts{items: []map[string]any{{"Email": "zed@example.com"}}})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, `No row where "Email" is "zed@example.com"`) {
		t.Errorf("missing row error = %+v", resp.Error)
	}
	resp = h.exec("googleSheets", params, execOpts{items: []map[string]any{{"Name": "No email"}}})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, `no field "Email"`) {
		t.Errorf("missing match field error = %+v", resp.Error)
	}

	// Append or Update: the first item updates Ada, the second is appended.
	upsert := sheetParams("appendOrUpdate", map[string]any{"columnToMatchOn": "Email"})
	out = h.ok(h.exec("googleSheets", upsert, execOpts{items: []map[string]any{
		{"Email": "ada@example.com", "Score": 99.0},
		{"Email": "hal@example.com", "Name": "Hal"},
	}}))
	if len(out) != 2 || out[0]["row_number"] != 2 || out[0]["Score"] != 99.0 || out[1]["row_number"] != 5 || out[1]["Name"] != "Hal" {
		t.Errorf("upsert output = %v", out)
	}
	if got := tel.counter(t, "landflow.google.sheets.rows_appended", nil); got != 1 {
		t.Errorf("rows_appended = %v, want 1 (the appended row only)", got)
	}

	// Manual mapping: the match value comes from valueToMatchOn.
	manual := sheetParams("update", map[string]any{
		"columnToMatchOn": "Name", "valueToMatchOn": "Cy", "dataMode": "defineBelow",
		"fieldsUi": map[string]any{"fieldValues": []any{map[string]any{"fieldId": "Score", "fieldValue": "12"}}},
	})
	out = h.ok(h.exec("googleSheets", manual, execOpts{}))
	if out[0]["Score"] != "12" || out[0]["row_number"] != 4 {
		t.Errorf("manual update = %v", out)
	}
}

func TestSheetsClearAndCreate(t *testing.T) {
	h := newHarness(t)
	h.leads()
	out := h.ok(h.exec("googleSheets", sheetParams("clear", map[string]any{"keepFirstRow": true}), execOpts{}))
	if out[0]["clearedRange"] != "'Leads'!A2:"+lastColumn || out[0]["sheetName"] != "Leads" {
		t.Errorf("clear output = %v", out)
	}
	if rows := h.fake.SheetRows("sheet-1", "Leads"); len(rows) != 1 || rows[0][0] != "Name" {
		t.Errorf("rows after clear = %v", rows)
	}

	out = h.ok(h.exec("googleSheets", map[string]any{
		"resource": "spreadsheet", "operation": "create", "title": "Budget",
		"sheetsUi": map[string]any{"sheetValues": []any{map[string]any{"title": "2026"}, map[string]any{"title": "2027"}}},
	}, execOpts{}))
	if len(out) != 1 || out[0]["title"] != "Budget" || len(out[0]["sheets"].([]any)) != 2 ||
		!strings.HasPrefix(landflow.Stringify(out[0]["spreadsheetUrl"]), "https://docs.google.com/spreadsheets/d/") {
		t.Errorf("create output = %v", out)
	}
}

func TestSheetsAPIErrors(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	resp := h.exec("googleSheets", sheetParams("read", map[string]any{"documentId": "missing"}), execOpts{})
	if resp.Error == nil || resp.Error.Message != "Google Sheets API error 404: Requested entity was not found." ||
		!strings.Contains(resp.Error.Description, "share the spreadsheet, file or calendar with the service account ("+saEmail+")") {
		t.Errorf("404 error = %+v", resp.Error)
	}
	if got := tel.counter(t, "landflow.google.api_errors", map[string]string{"api": "sheets", "status_class": "4xx"}); got != 1 {
		t.Errorf("api_errors{sheets,4xx} = %v", got)
	}

	h.leads()
	h.fake.Fail("", "/values", http.StatusServiceUnavailable, "The service is currently unavailable.")
	resp = h.exec("googleSheets", sheetParams("read", nil), execOpts{})
	if resp.Error == nil || resp.Error.Message != "Google Sheets API error 503: The service is currently unavailable." {
		t.Errorf("503 error = %+v", resp.Error)
	}
	if got := tel.counter(t, "landflow.google.api_errors", map[string]string{"api": "sheets", "status_class": "5xx"}); got != 1 {
		t.Errorf("api_errors{sheets,5xx} = %v", got)
	}

	resp = h.exec("googleSheets", sheetParams("read", map[string]any{"documentId": ""}), execOpts{})
	if resp.Error == nil || resp.Error.Message != "Document is required" {
		t.Errorf("missing document error = %+v", resp.Error)
	}
}

func TestSheetsLoadOptions(t *testing.T) {
	h := newHarness(t)
	h.leads()
	docs := h.loadOptions("googleSheets", "spreadsheets", map[string]any{}, nil)
	if len(docs) != 1 || docs[0].Name != "CRM" || docs[0].Value != "sheet-1" {
		t.Errorf("spreadsheets = %+v", docs)
	}
	tabs := h.loadOptions("googleSheets", "sheets", map[string]any{"documentId": "sheet-1"}, nil)
	if len(tabs) != 2 || tabs[0].Value != "Leads" || tabs[1].Description != "gid=1" {
		t.Errorf("sheets = %+v", tabs)
	}
	cols := h.loadOptions("googleSheets", "columns", map[string]any{"documentId": "sheet-1", "sheetName": "Leads"}, nil)
	if len(cols) != 3 || cols[2].Value != "Score" {
		t.Errorf("columns = %+v", cols)
	}
	if none := h.loadOptions("googleSheets", "sheets", map[string]any{}, nil); len(none) != 0 {
		t.Errorf("sheets without a document = %+v", none)
	}
	// Pickers inside collections only get the collection's values: the
	// credential is used even without the authentication parameter.
	cols = h.loadOptions("googleSheets", "columns", map[string]any{"documentId": "sheet-1"}, map[string]any{credOAuth2: h.oauth()})
	if len(cols) != 3 {
		t.Errorf("columns with an OAuth2 credential = %+v", cols)
	}
}

func TestSheetsTrigger(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	h.leads()
	params := map[string]any{"documentId": "sheet-1", "sheetName": "Leads", "event": "rowAdded", "pollInterval": 60}

	first := h.exec("googleSheetsTrigger", params, execOpts{mode: landflow.ModePoll})
	if items := h.ok(first); len(items) != 0 || first.PollState["lastRow"] != 4 {
		t.Fatalf("first poll = %v, state %v", items, first.PollState)
	}

	h.fake.AppendRows("sheet-1", "Leads", []any{"Dee", "dee@example.com", 10.0}, []any{"Eve", "eve@example.com", 20.0})
	second := h.exec("googleSheetsTrigger", params, execOpts{mode: landflow.ModePoll, pollState: first.PollState})
	items := h.ok(second)
	if len(items) != 2 || items[0]["Name"] != "Dee" || items[0]["row_number"] != 5 || items[1]["Score"] != 20.0 ||
		second.PollState["lastRow"] != 6 {
		t.Fatalf("second poll = %v, state %v", items, second.PollState)
	}
	batch := h.fake.Calls(http.MethodGet, "/v4/spreadsheets/sheet-1/values:batchGet")
	if len(batch) != 1 || !reflect.DeepEqual(batch[0].Query["ranges"], []string{"'Leads'!1:1", "'Leads'!A5:" + lastColumn}) {
		t.Errorf("batchGet = %+v", batch)
	}

	third := h.exec("googleSheetsTrigger", params, execOpts{mode: landflow.ModePoll, pollState: second.PollState})
	if items := h.ok(third); len(items) != 0 || third.PollState["lastRow"] != 6 {
		t.Errorf("third poll = %v, state %v", items, third.PollState)
	}
	if got := tel.counter(t, "landflow.google.poll.new_items", map[string]string{"trigger": "sheets"}); got != 2 {
		t.Errorf("poll.new_items{sheets} = %v", got)
	}
	if len(tel.spansNamed("google.sheets.poll")) != 2 {
		t.Errorf("google.sheets.poll spans = %d", len(tel.spansNamed("google.sheets.poll")))
	}

	// A different sheet re-baselines instead of replaying old rows.
	moved := cloneMap(params)
	moved["sheetName"] = "Empty"
	fourth := h.exec("googleSheetsTrigger", moved, execOpts{mode: landflow.ModePoll, pollState: third.PollState})
	if items := h.ok(fourth); len(items) != 0 || fourth.PollState["sheetName"] != "Empty" || fourth.PollState["lastRow"] != 0 {
		t.Errorf("re-baseline = %v, state %v", items, fourth.PollState)
	}

	// Manual runs show the latest rows and keep no state.
	manual := h.exec("googleSheetsTrigger", params, execOpts{mode: landflow.ModeManual})
	if items := h.ok(manual); len(items) != 5 || items[0]["Name"] != "Ada" || items[4]["Name"] != "Eve" || manual.PollState != nil {
		t.Errorf("manual = %v, state %v", items, manual.PollState)
	}
}
