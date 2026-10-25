package main

import (
	"fmt"
	"net/http"
	"net/url"

	landflow "github.com/landflow/landflow/sdks/go"
)

// SheetsTriggerNode polls a sheet for rows added below the last one seen.
// State: {lastRow, documentId, sheetName}; rows come out as objects keyed by
// the header row plus row_number, oldest first.
type SheetsTriggerNode struct{}

// sheetsManualRows is how many rows a manual run shows.
const sheetsManualRows = 5

func (SheetsTriggerNode) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name:             "googleSheetsTrigger",
		DisplayName:      "Google Sheets Trigger",
		Description:      "Starts the workflow when rows are added to a Google Sheet",
		Version:          landflow.V(1),
		Kind:             landflow.KindTrigger,
		TriggerSource:    landflow.TriggerPoll,
		Categories:       []string{"Data & Storage", "Productivity"},
		Icon:             "file:icons/sheets.svg",
		Color:            "#0F9D58",
		Subtitle:         "{{event}}",
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		DocumentationURL: "https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get",
		Keywords:         []string{"spreadsheet", "new row", "poll", "watch"},
		Credentials:      credentialRequirements(),
		Properties: []landflow.PropertyDescriptor{
			authProperty(),
			landflow.PollIntervalProperty(60),
			{
				Name: "documentId", DisplayName: "Document", Type: landflow.PropOptions, Default: "", Required: true,
				Description: "Spreadsheet to watch. An expression may also give its ID or URL.",
				TypeOptions: &landflow.TypeOptions{LoadOptionsMethod: "spreadsheets"},
			},
			{
				Name: "sheetName", DisplayName: "Sheet", Type: landflow.PropOptions, Default: "",
				Description: "Sheet (tab) to watch; empty means the first one",
				TypeOptions: &landflow.TypeOptions{LoadOptionsMethod: "sheets", LoadOptionsDependsOn: []string{"documentId"}},
			},
			{
				Name: "event", DisplayName: "Trigger On", Type: landflow.PropOptions, Default: "rowAdded", NoDataExpression: true,
				Options: []landflow.PropertyOption{
					{Name: "Row Added", Value: "rowAdded", Description: "A row was added below the last row seen"},
				},
			},
		},
	}
}

func (SheetsTriggerNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	c, err := newClient(ctx, ctx.ParamString("authentication", 0, "serviceAccount"))
	if err != nil {
		return nil, err
	}
	s := &sheetsRun{ctx: ctx, c: c, tables: map[string]*sheetTable{}, first: map[string]string{}}
	docID, sheet, err := s.target(0)
	if err != nil {
		return nil, err
	}

	state := landflow.CredentialData(ctx.PollState())
	sameTarget := state.String("documentId") == docID && state.String("sheetName") == sheet
	if ctx.Mode() == landflow.ModeManual || ctx.IsFirstPoll() || !state.Has("lastRow") || !sameTarget {
		// Manual run, first poll or a new target: read the whole sheet.
		t, err := s.table(docID, sheet, true)
		if err != nil {
			return nil, err
		}
		last := 1 + len(t.rows) // trailing empty rows are not returned
		if len(t.header) == 0 {
			last = 0
		}
		if ctx.Mode() == landflow.ModeManual {
			return [][]landflow.Item{lastRows(t, sheetsManualRows)}, nil
		}
		// Baseline only: activating a workflow does not replay the sheet.
		ctx.SetPollState(map[string]any{"lastRow": last, "documentId": docID, "sheetName": sheet})
		return nil, nil
	}

	lastRow := max(state.Int("lastRow", 1), 1)
	var header, tail valueRange
	err = ctx.Span("google.sheets.poll", landflow.Attrs{"google.sheets.last_row": lastRow}, func(span landflow.Span) error {
		query := readQuery()
		query.Add("ranges", quoteSheet(sheet)+"!1:1")
		query.Add("ranges", fmt.Sprintf("%s!A%d:%s", quoteSheet(sheet), lastRow+1, lastColumn))
		var resp struct {
			ValueRanges []valueRange `json:"valueRanges"`
		}
		if err := c.do(span, apiSheets, http.MethodGet, "/v4/spreadsheets/"+url.PathEscape(docID)+"/values:batchGet", query, nil, &resp); err != nil {
			return err
		}
		if len(resp.ValueRanges) == 2 {
			header, tail = resp.ValueRanges[0], resp.ValueRanges[1]
		}
		span.SetAttribute("google.sheets.rows", len(tail.Values))
		return nil
	})
	if err != nil {
		return nil, err
	}

	t := tableFrom(docID, sheet, header.Values)
	var out []landflow.Item
	for k, row := range tail.Values {
		if !isEmptyRow(row) {
			out = append(out, landflow.Item{JSON: t.object(row, lastRow+1+k)})
		}
	}
	ctx.SetPollState(map[string]any{"lastRow": lastRow + len(tail.Values), "documentId": docID, "sheetName": sheet})
	if len(out) > 0 {
		ctx.Metrics().Counter("landflow.google.poll.new_items", landflow.WithDescription("New items found by Google polling triggers")).
			Add(float64(len(out)), landflow.Attrs{"trigger": "sheets"})
		ctx.Logger.Info("%d new row(s) after row %d", len(out), lastRow)
	}
	return [][]landflow.Item{out}, nil
}

// lastRows returns up to n of the sheet's last non-empty rows, in order.
func lastRows(t *sheetTable, n int) []landflow.Item {
	var picked []landflow.Item
	for k := len(t.rows) - 1; k >= 0 && len(picked) < n; k-- {
		if !isEmptyRow(t.rows[k]) {
			picked = append(picked, landflow.Item{JSON: t.object(t.rows[k], k+2)})
		}
	}
	out := make([]landflow.Item, 0, len(picked))
	for k := len(picked) - 1; k >= 0; k-- {
		out = append(out, picked[k])
	}
	return out
}

// LoadOptionsWithContext serves the document and sheet pickers.
func (SheetsTriggerNode) LoadOptionsWithContext(ctx *landflow.LoadOptionsContext) ([]landflow.PropertyOption, error) {
	return loadSheetsOptions(ctx)
}
