package main

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// SheetsNode is Google Sheets: append, append-or-update, read, update and
// clear rows of a sheet, and create spreadsheets. The first row of a sheet
// holds the column names; rows are returned as objects keyed by them, plus
// row_number.
type SheetsNode struct{}

const (
	mimeSpreadsheet = "application/vnd.google-apps.spreadsheet"
	// lastColumn bounds open-ended ranges (A2:ZZZ); ZZZ is Sheets' last column.
	lastColumn = "ZZZ"
)

var sheetOperations = []landflow.PropertyOption{
	{Name: "Append or Update Row", Value: "appendOrUpdate", Description: "Append a new row or update an existing one (upsert)", Action: "Append or update row in sheet"},
	{Name: "Append Row", Value: "append", Description: "Create a new row in a sheet", Action: "Append row in sheet"},
	{Name: "Clear", Value: "clear", Description: "Delete all the contents of a sheet", Action: "Clear sheet"},
	{Name: "Get Row(s)", Value: "read", Description: "Retrieve one or more rows from a sheet", Action: "Get row(s) in sheet", Idempotent: true},
	{Name: "Update Row", Value: "update", Description: "Update an existing row in a sheet", Action: "Update row in sheet"},
}

func (SheetsNode) Description() landflow.NodeDescriptor {
	anySheetOp := show("sheet")
	writes := show("sheet", "append", "appendOrUpdate", "update")
	matching := show("sheet", "appendOrUpdate", "update")
	return landflow.NodeDescriptor{
		Name:             "googleSheets",
		DisplayName:      "Google Sheets",
		Description:      "Read, append and update rows in Google Sheets",
		Version:          landflow.V(1),
		Kind:             landflow.KindAction,
		Categories:       []string{"Data & Storage", "Productivity"},
		Icon:             "file:icons/sheets.svg",
		Color:            "#0F9D58",
		Subtitle:         "{{operation}}: {{resource}}",
		Inputs:           []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		DocumentationURL: "https://developers.google.com/workspace/sheets/api/reference/rest",
		Keywords:         []string{"spreadsheet", "sheet", "rows", "table", "append", "lookup", "upsert"},
		Credentials:      credentialRequirements(),

		UsableAsTool: true,
		ToolDescription: "Work with rows of a Google Sheets spreadsheet whose first row holds column names. " +
			"operation=read returns rows as objects keyed by column name plus row_number, optionally filtered by " +
			"filtersUI (column = value); append adds a row from the item's fields (keys matching column names); " +
			"appendOrUpdate and update find the row whose columnToMatchOn equals the item's value for that column. " +
			"Needs documentId (spreadsheet ID or URL) and sheetName (tab title).",

		Properties: []landflow.PropertyDescriptor{
			authProperty(),
			resourceProperty("sheet",
				landflow.PropertyOption{Name: "Document", Value: "spreadsheet", Description: "A spreadsheet file"},
				landflow.PropertyOption{Name: "Sheet Within Document", Value: "sheet", Description: "Rows of one sheet (tab)"},
			),
			operationProperty("spreadsheet", "create",
				landflow.PropertyOption{Name: "Create", Value: "create", Description: "Create a spreadsheet", Action: "Create spreadsheet"},
			),
			operationProperty("sheet", "append", sheetOperations...),

			// Document → Create
			{
				Name: "title", DisplayName: "Title", Type: landflow.PropString, Default: "", Required: true,
				Description: "Title of the new spreadsheet", DisplayOptions: show("spreadsheet", "create"),
			},
			{
				Name: "sheetsUi", DisplayName: "Sheets", Type: landflow.PropFixedCollection, Default: map[string]any{},
				Placeholder: "Add Sheet", Description: "Sheets (tabs) to create; Google adds one called Sheet1 when empty",
				TypeOptions: &landflow.TypeOptions{MultipleValues: true}, DisplayOptions: show("spreadsheet", "create"),
				Groups: []landflow.FixedCollectionGroup{{Name: "sheetValues", DisplayName: "Sheet", Values: []landflow.PropertyDescriptor{
					{Name: "title", DisplayName: "Title", Type: landflow.PropString, Default: "", Description: "Name of the sheet"},
				}}},
			},

			// Sheet Within Document
			{
				Name: "documentId", DisplayName: "Document", Type: landflow.PropOptions, Default: "", Required: true,
				Description:    "Spreadsheet to use. An expression may also give its ID or URL.",
				TypeOptions:    &landflow.TypeOptions{LoadOptionsMethod: "spreadsheets"},
				DisplayOptions: anySheetOp,
			},
			{
				Name: "sheetName", DisplayName: "Sheet", Type: landflow.PropOptions, Default: "",
				Description:    "Sheet (tab) in the document; empty means the first one",
				TypeOptions:    &landflow.TypeOptions{LoadOptionsMethod: "sheets", LoadOptionsDependsOn: []string{"documentId"}},
				DisplayOptions: anySheetOp,
			},
			{
				Name: "keepFirstRow", DisplayName: "Keep First Row", Type: landflow.PropBoolean, Default: false,
				Description: "Whether to keep the header row and clear only the data", DisplayOptions: show("sheet", "clear"),
			},
			{
				Name: "dataMode", DisplayName: "Mapping Column Mode", Type: landflow.PropOptions, Default: "autoMapInputData",
				Options: []landflow.PropertyOption{
					{Name: "Map Automatically", Value: "autoMapInputData", Description: "Use the input fields whose names match column names"},
					{Name: "Map Each Column Manually", Value: "defineBelow", Description: "Set the value of each column below"},
				},
				DisplayOptions: writes,
			},
			{
				Name: "columnToMatchOn", DisplayName: "Column to Match On", Type: landflow.PropOptions, Default: "", Required: true,
				Description:    "Column used to find the row to update. With Map Automatically the item's field of the same name gives the value.",
				TypeOptions:    &landflow.TypeOptions{LoadOptionsMethod: "columns", LoadOptionsDependsOn: []string{"documentId", "sheetName"}},
				DisplayOptions: matching,
			},
			{
				Name: "valueToMatchOn", DisplayName: "Value of Column to Match On", Type: landflow.PropString, Default: "",
				Description: "Rows whose Column to Match On holds this value are updated", DisplayOptions: with(matching, "dataMode", "defineBelow"),
			},
			{
				Name: "fieldsUi", DisplayName: "Values to Send", Type: landflow.PropFixedCollection, Default: map[string]any{},
				Placeholder: "Add Field", TypeOptions: &landflow.TypeOptions{MultipleValues: true},
				DisplayOptions: with(writes, "dataMode", "defineBelow"),
				Groups: []landflow.FixedCollectionGroup{{Name: "fieldValues", DisplayName: "Field", Values: []landflow.PropertyDescriptor{
					{Name: "fieldId", DisplayName: "Column", Type: landflow.PropString, Default: "", Description: "Column name, as in the header row"},
					{Name: "fieldValue", DisplayName: "Value", Type: landflow.PropString, Default: ""},
				}}},
			},
			{
				Name: "filtersUI", DisplayName: "Filters", Type: landflow.PropFixedCollection, Default: map[string]any{},
				Placeholder: "Add Filter", Description: "Return only rows where the column equals the value; no filters return every row",
				TypeOptions: &landflow.TypeOptions{MultipleValues: true}, DisplayOptions: show("sheet", "read"),
				Groups: []landflow.FixedCollectionGroup{{Name: "values", DisplayName: "Filter", Values: []landflow.PropertyDescriptor{
					{Name: "lookupColumn", DisplayName: "Column", Type: landflow.PropString, Default: ""},
					{Name: "lookupValue", DisplayName: "Value", Type: landflow.PropString, Default: ""},
				}}},
			},
			{
				Name: "combineFilters", DisplayName: "Combine Filters", Type: landflow.PropOptions, Default: "AND",
				Options: []landflow.PropertyOption{
					{Name: "AND", Value: "AND", Description: "Rows must match every filter"},
					{Name: "OR", Value: "OR", Description: "Rows must match at least one filter"},
				},
				DisplayOptions: show("sheet", "read"),
			},
			{
				Name: "options", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{},
				Placeholder: "Add Option", DisplayOptions: show("sheet", "read"),
				Values: []landflow.PropertyDescriptor{
					{
						Name: "returnAllMatches", DisplayName: "When Filter Has Multiple Matches", Type: landflow.PropOptions,
						Default: "returnFirstMatch",
						Options: []landflow.PropertyOption{
							{Name: "Return First Match", Value: "returnFirstMatch"},
							{Name: "Return All Matches", Value: "returnAllMatches"},
						},
					},
				},
			},
		},
	}
}

func (SheetsNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	items := ctx.InputData(0)
	if len(items) == 0 {
		return nil, nil
	}
	c, err := newClient(ctx, ctx.ParamString("authentication", 0, "serviceAccount"))
	if err != nil {
		return nil, err
	}
	s := &sheetsRun{ctx: ctx, c: c, tables: map[string]*sheetTable{}, first: map[string]string{}}

	// Consecutive appends to the same sheet go out as one append request,
	// as n8n does, so large batches stay within the write quota.
	var out []landflow.Item
	var batch *appendBatch
	flush := func() error {
		if batch == nil {
			return nil
		}
		b := batch
		batch = nil
		rows, err := s.flushAppend(b)
		if err != nil {
			return itemError(b.items[0], err)
		}
		out = append(out, rows...)
		return nil
	}

	for i := range items {
		resource := ctx.ParamString("resource", i, "sheet")
		operation := ctx.ParamString("operation", i, "append")
		if resource == "sheet" && operation == "append" {
			t, data, mode, err := s.prepareAppend(i)
			if err != nil {
				if ctx.ContinueOnFail() {
					out = append(out, ctx.ErrorItem(i, itemError(i, err)))
					continue
				}
				return nil, itemError(i, err)
			}
			if batch != nil && batch.table != t {
				if err := flush(); err != nil {
					return nil, err
				}
			}
			if batch == nil {
				batch = &appendBatch{table: t}
			}
			batch.items = append(batch.items, i)
			batch.rows = append(batch.rows, data)
			batch.modes = append(batch.modes, mode)
			continue
		}
		if err := flush(); err != nil {
			return nil, err
		}
		var results []map[string]any
		switch resource + "." + operation {
		case "sheet.read":
			results, err = s.read(i)
		case "sheet.update":
			results, err = one(s.upsert(i, false))
		case "sheet.appendOrUpdate":
			results, err = one(s.upsert(i, true))
		case "sheet.clear":
			results, err = one(s.clear(i))
		case "spreadsheet.create":
			results, err = one(s.createSpreadsheet(i))
		default:
			err = userError("Pick an operation listed for the resource.", "Unsupported operation %q for resource %q", operation, resource)
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
	if err := flush(); err != nil {
		return nil, err
	}
	return [][]landflow.Item{out}, nil
}

// one wraps a single result.
func one(result map[string]any, err error) ([]map[string]any, error) {
	if err != nil {
		return nil, err
	}
	return []map[string]any{result}, nil
}

// sheetsRun is the state of one execution: loaded sheets and first-sheet
// titles, kept in sync with this execution's own writes.
type sheetsRun struct {
	ctx    *landflow.ExecuteContext
	c      *client
	tables map[string]*sheetTable
	first  map[string]string
}

// sheetTable is a sheet's header row and (when full) its data rows.
type sheetTable struct {
	docID, sheet string
	header       []string
	rows         [][]any // rows[k] is sheet row k+2
	full         bool    // rows loaded; false: header only
	headerDirty  bool    // header extended here, not yet written
}

// appendBatch is consecutive appends to one sheet.
type appendBatch struct {
	table *sheetTable
	items []int
	rows  []map[string]any
	modes []string
}

// target resolves the document and sheet of item i (empty sheet: the first).
func (s *sheetsRun) target(i int) (docID, sheet string, err error) {
	docID = idFrom(s.ctx.ParamString("documentId", i, ""), spreadsheetURLPattern)
	if docID == "" {
		return "", "", userError("Pick a spreadsheet in Document, or give its ID or URL.", "Document is required")
	}
	if sheet = strings.TrimSpace(s.ctx.ParamString("sheetName", i, "")); sheet != "" {
		return docID, sheet, nil
	}
	if title, ok := s.first[docID]; ok {
		return docID, title, nil
	}
	sheets, err := listSheets(s.ctx, s.c, docID)
	if err != nil {
		return "", "", err
	}
	if len(sheets) == 0 {
		return "", "", userError("Add a sheet to the spreadsheet.", "The spreadsheet has no sheets")
	}
	s.first[docID] = sheets[0].Title
	return docID, sheets[0].Title, nil
}

// table loads a sheet once per execution (header only unless full).
func (s *sheetsRun) table(docID, sheet string, full bool) (*sheetTable, error) {
	key := docID + "\x00" + sheet
	if t := s.tables[key]; t != nil && (t.full || !full) {
		return t, nil
	}
	rng := quoteSheet(sheet)
	if !full {
		rng += "!1:1"
	}
	var vr valueRange
	err := s.ctx.Span("google.sheets.read", landflow.Attrs{"google.sheets.full": full}, func(span landflow.Span) error {
		var err error
		vr, err = getValues(span, s.c, docID, rng)
		span.SetAttribute("google.sheets.rows", len(vr.Values))
		return err
	})
	if err != nil {
		return nil, err
	}
	t := tableFrom(docID, sheet, vr.Values)
	t.full = full
	s.tables[key] = t
	return t, nil
}

// rowData returns the column → value pairs item i writes, in a stable order,
// and the mapping mode ("auto" or "manual").
func (s *sheetsRun) rowData(i int) (map[string]any, []string, string, error) {
	data := map[string]any{}
	var order []string
	switch mode := s.ctx.ParamString("dataMode", i, "autoMapInputData"); mode {
	case "autoMapInputData":
		item := s.ctx.InputData(0)[i].JSON
		// Item keys arrive as a JSON object, whose order Go does not keep.
		order = slices.Sorted(maps.Keys(item))
		for _, k := range order {
			data[k] = item[k]
		}
		return data, order, "auto", nil
	case "defineBelow":
		for _, e := range entries(s.ctx.Param("fieldsUi", i), "fieldValues") {
			col := strings.TrimSpace(getString(e, "fieldId", ""))
			if col == "" {
				continue
			}
			if _, dup := data[col]; !dup {
				order = append(order, col)
			}
			data[col] = e["fieldValue"]
		}
		if len(order) == 0 {
			return nil, nil, "", userError("Add at least one column under Values to Send.", "No columns to write")
		}
		return data, order, "manual", nil
	default:
		return nil, nil, "", userError("Use autoMapInputData or defineBelow.", "Unknown mapping column mode %q", mode)
	}
}

// prepareAppend maps item i to a row of its target sheet. On a sheet without
// a header row the item's columns become the header.
func (s *sheetsRun) prepareAppend(i int) (*sheetTable, map[string]any, string, error) {
	docID, sheet, err := s.target(i)
	if err != nil {
		return nil, nil, "", err
	}
	t, err := s.table(docID, sheet, false)
	if err != nil {
		return nil, nil, "", err
	}
	data, order, mode, err := s.rowData(i)
	if err != nil {
		return nil, nil, "", err
	}
	switch {
	case len(t.header) == 0 || t.headerDirty:
		t.addColumns(order...)
	case mode == "manual":
		for _, col := range order {
			if t.column(col) < 0 {
				return nil, nil, "", unknownColumn(t, col)
			}
		}
	}
	return t, data, mode, nil
}

// flushAppend writes a batch of rows (and a new header row first, if any).
func (s *sheetsRun) flushAppend(b *appendBatch) ([]landflow.Item, error) {
	t := b.table
	if t.headerDirty {
		if err := s.writeRow(t, 1, stringsToAny(t.header), "RAW"); err != nil {
			return nil, err
		}
		t.headerDirty = false
	}
	values := make([][]any, len(b.rows))
	for k, data := range b.rows {
		values[k] = t.rowValues(data)
	}
	first, err := s.appendValues(t, values)
	if err != nil {
		return nil, err
	}
	perMode := map[string]int{}
	var out []landflow.Item
	for k := range values {
		perMode[b.modes[k]]++
		rowNumber := 0
		if first > 0 {
			rowNumber = first + k
			if t.full {
				t.setRow(rowNumber, values[k])
			}
		}
		out = emit(out, b.items[k], t.object(values[k], rowNumber))
	}
	for mode, n := range perMode {
		s.countAppended(mode, n)
	}
	s.ctx.Logger.With("google.sheets.rows", len(values)).Info("appended %d row(s)", len(values))
	return out, nil
}

func (s *sheetsRun) countAppended(mode string, n int) {
	s.ctx.Metrics().Counter("landflow.google.sheets.rows_appended", landflow.WithDescription("Rows appended to Google Sheets")).
		Add(float64(n), landflow.Attrs{"mode": mode})
}

// upsert updates the first row whose match column holds the item's value;
// with appendMissing (Append or Update) a missing row is appended.
func (s *sheetsRun) upsert(i int, appendMissing bool) (map[string]any, error) {
	docID, sheet, err := s.target(i)
	if err != nil {
		return nil, err
	}
	t, err := s.table(docID, sheet, true)
	if err != nil {
		return nil, err
	}
	matchCol, err := requireParam(s.ctx, "columnToMatchOn", "Column to Match On", i)
	if err != nil {
		return nil, err
	}
	data, order, mode, err := s.rowData(i)
	if err != nil {
		return nil, err
	}
	var matchValue string
	if mode == "manual" {
		matchValue = s.ctx.ParamString("valueToMatchOn", i, "")
		if _, ok := data[matchCol]; !ok {
			data[matchCol] = matchValue
			order = append([]string{matchCol}, order...)
		}
	} else {
		v, ok := data[matchCol]
		if !ok {
			return nil, userError("With Map Automatically the input item needs a field named like the column to match on.",
				"The input item has no field %q to match on", matchCol)
		}
		matchValue = landflow.Stringify(v)
	}

	if len(t.header) == 0 {
		if !appendMissing {
			return nil, userError("Add a header row with the column names first.", "Sheet %q has no header row", sheet)
		}
		t.addColumns(order...)
		if err := s.writeRow(t, 1, stringsToAny(t.header), "RAW"); err != nil {
			return nil, err
		}
		t.headerDirty = false
	}
	col := t.column(matchCol)
	if col < 0 {
		return nil, unknownColumn(t, matchCol)
	}
	if mode == "manual" {
		for _, name := range order {
			if t.column(name) < 0 {
				return nil, unknownColumn(t, name)
			}
		}
	}

	k := slices.IndexFunc(t.rows, func(row []any) bool { return !isEmptyRow(row) && cellText(row, col) == matchValue })
	if k < 0 {
		if !appendMissing {
			return nil, userError("Use Append or Update Row to add missing rows.", "No row where %q is %q", matchCol, matchValue)
		}
		values := t.rowValues(data)
		first, err := s.appendValues(t, [][]any{values})
		if err != nil {
			return nil, err
		}
		s.countAppended(mode, 1)
		if first > 0 {
			t.setRow(first, values)
		}
		return t.object(values, first), nil
	}

	rowNumber := k + 2
	row := slices.Clone(t.rows[k])
	for len(row) < len(t.header) {
		row = append(row, "")
	}
	var updates []map[string]any
	for _, name := range order {
		j := t.column(name)
		if j < 0 || j == col { // unknown keys of auto-mapped items are ignored
			continue
		}
		v := cellValue(data[name])
		row[j] = v
		updates = append(updates, map[string]any{
			"range":  quoteSheet(sheet) + "!" + columnLetter(j+1) + strconv.Itoa(rowNumber),
			"values": [][]any{{v}},
		})
	}
	if len(updates) > 0 {
		if err := s.batchUpdate(docID, updates, "USER_ENTERED"); err != nil {
			return nil, err
		}
	}
	t.rows[k] = row
	return t.object(row, rowNumber), nil
}

// read returns the rows matching the filters (every non-empty row without).
func (s *sheetsRun) read(i int) ([]map[string]any, error) {
	docID, sheet, err := s.target(i)
	if err != nil {
		return nil, err
	}
	t, err := s.table(docID, sheet, true)
	if err != nil {
		return nil, err
	}
	type condition struct {
		col   int
		value string
	}
	var conds []condition
	for _, f := range entries(s.ctx.Param("filtersUI", i), "values") {
		name := strings.TrimSpace(getString(f, "lookupColumn", ""))
		if name == "" {
			continue
		}
		col := t.column(name)
		if col < 0 {
			return nil, unknownColumn(t, name)
		}
		conds = append(conds, condition{col, getString(f, "lookupValue", "")})
	}
	anyMatch := strings.EqualFold(s.ctx.ParamString("combineFilters", i, "AND"), "OR")
	firstOnly := len(conds) > 0 &&
		getString(asMap(s.ctx.Param("options", i)), "returnAllMatches", "returnFirstMatch") == "returnFirstMatch"

	var out []map[string]any
	for k, row := range t.rows {
		if isEmptyRow(row) {
			continue
		}
		matched := len(conds) == 0 || !anyMatch
		for _, c := range conds {
			ok := cellText(row, c.col) == c.value
			if anyMatch && ok {
				matched = true
				break
			}
			if !anyMatch && !ok {
				matched = false
				break
			}
		}
		if !matched {
			continue
		}
		out = append(out, t.object(row, k+2))
		if firstOnly {
			break
		}
	}
	return out, nil
}

// clear empties the sheet, optionally keeping the header row.
func (s *sheetsRun) clear(i int) (map[string]any, error) {
	docID, sheet, err := s.target(i)
	if err != nil {
		return nil, err
	}
	rng := quoteSheet(sheet)
	if s.ctx.ParamBool("keepFirstRow", i, false) {
		rng += "!A2:" + lastColumn
	}
	var resp struct {
		ClearedRange string `json:"clearedRange"`
	}
	if err := s.c.do(s.ctx, apiSheets, http.MethodPost, valuesPath(docID, rng)+":clear", nil, map[string]any{}, &resp); err != nil {
		return nil, err
	}
	delete(s.tables, docID+"\x00"+sheet)
	return map[string]any{"spreadsheetId": docID, "sheetName": sheet, "clearedRange": resp.ClearedRange}, nil
}

// createSpreadsheet creates a spreadsheet with the given title and sheets.
func (s *sheetsRun) createSpreadsheet(i int) (map[string]any, error) {
	title, err := requireParam(s.ctx, "title", "Title", i)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"properties": map[string]any{"title": title}}
	var sheets []map[string]any
	for _, e := range entries(s.ctx.Param("sheetsUi", i), "sheetValues") {
		if name := strings.TrimSpace(getString(e, "title", "")); name != "" {
			sheets = append(sheets, map[string]any{"properties": map[string]any{"title": name}})
		}
	}
	if len(sheets) > 0 {
		body["sheets"] = sheets
	}
	var resp spreadsheetResource
	if err := s.c.do(s.ctx, apiSheets, http.MethodPost, "/v4/spreadsheets", nil, body, &resp); err != nil {
		return nil, err
	}
	out := map[string]any{
		"spreadsheetId":  resp.SpreadsheetID,
		"title":          resp.Properties.Title,
		"spreadsheetUrl": resp.SpreadsheetURL,
	}
	list := make([]any, 0, len(resp.Sheets))
	for _, sh := range resp.Sheets {
		list = append(list, map[string]any{"sheetId": sh.Properties.SheetID, "title": sh.Properties.Title})
	}
	out["sheets"] = list
	return out, nil
}

// writeRow overwrites one row starting at column A.
func (s *sheetsRun) writeRow(t *sheetTable, rowNumber int, values []any, inputOption string) error {
	rng := fmt.Sprintf("%s!A%d:%s%d", quoteSheet(t.sheet), rowNumber, columnLetter(max(len(values), 1)), rowNumber)
	return s.batchUpdate(t.docID, []map[string]any{{"range": rng, "values": [][]any{values}}}, inputOption)
}

func (s *sheetsRun) batchUpdate(docID string, data []map[string]any, inputOption string) error {
	body := map[string]any{"valueInputOption": inputOption, "data": data}
	return s.c.do(s.ctx, apiSheets, http.MethodPost, "/v4/spreadsheets/"+url.PathEscape(docID)+"/values:batchUpdate", nil, body, nil)
}

// appendValues appends rows below the sheet's table and returns the first
// new row number (0 when Google does not say).
func (s *sheetsRun) appendValues(t *sheetTable, values [][]any) (int, error) {
	query := url.Values{"valueInputOption": {"USER_ENTERED"}, "insertDataOption": {"INSERT_ROWS"}}
	var resp struct {
		Updates struct {
			UpdatedRange string `json:"updatedRange"`
		} `json:"updates"`
	}
	body := map[string]any{"majorDimension": "ROWS", "values": values}
	err := s.c.do(s.ctx, apiSheets, http.MethodPost, valuesPath(t.docID, quoteSheet(t.sheet))+":append", query, body, &resp)
	return startRow(resp.Updates.UpdatedRange), err
}

// ---------------------------------------------------------------------------
// Sheets helpers shared with the trigger and the pickers
// ---------------------------------------------------------------------------

type valueRange struct {
	Range  string  `json:"range"`
	Values [][]any `json:"values"`
}

type sheetInfo struct {
	SheetID int    `json:"sheetId"`
	Title   string `json:"title"`
	Index   int    `json:"index"`
}

type spreadsheetResource struct {
	SpreadsheetID  string `json:"spreadsheetId"`
	SpreadsheetURL string `json:"spreadsheetUrl"`
	Properties     struct {
		Title string `json:"title"`
	} `json:"properties"`
	Sheets []struct {
		Properties sheetInfo `json:"properties"`
	} `json:"sheets"`
}

func valuesPath(docID, rng string) string {
	return "/v4/spreadsheets/" + url.PathEscape(docID) + "/values/" + url.PathEscape(rng)
}

// readQuery returns numbers as numbers and dates as formatted strings
// (n8n's defaults).
func readQuery() url.Values {
	return url.Values{"valueRenderOption": {"UNFORMATTED_VALUE"}, "dateTimeRenderOption": {"FORMATTED_STRING"}}
}

func getValues(ctx context.Context, c *client, docID, rng string) (valueRange, error) {
	var vr valueRange
	err := c.do(ctx, apiSheets, http.MethodGet, valuesPath(docID, rng), readQuery(), nil, &vr)
	return vr, err
}

func listSheets(ctx context.Context, c *client, docID string) ([]sheetInfo, error) {
	var resp spreadsheetResource
	query := url.Values{"fields": {"spreadsheetId,properties.title,sheets.properties(sheetId,title,index)"}}
	if err := c.do(ctx, apiSheets, http.MethodGet, "/v4/spreadsheets/"+url.PathEscape(docID), query, nil, &resp); err != nil {
		return nil, err
	}
	out := make([]sheetInfo, 0, len(resp.Sheets))
	for _, sh := range resp.Sheets {
		out = append(out, sh.Properties)
	}
	return out, nil
}

// tableFrom splits values into the header row and the data rows.
func tableFrom(docID, sheet string, values [][]any) *sheetTable {
	t := &sheetTable{docID: docID, sheet: sheet}
	if len(values) > 0 {
		t.header = make([]string, len(values[0]))
		for j, v := range values[0] {
			t.header[j] = strings.TrimSpace(landflow.Stringify(v))
		}
		t.rows = values[1:]
	}
	return t
}

func (t *sheetTable) column(name string) int {
	return slices.Index(t.header, strings.TrimSpace(name))
}

// addColumns appends names missing from the header (to be written later).
func (t *sheetTable) addColumns(names ...string) {
	for _, n := range names {
		if n = strings.TrimSpace(n); n != "" && t.column(n) < 0 {
			t.header = append(t.header, n)
			t.headerDirty = true
		}
	}
}

// object keys a row by the header (empty column names are skipped) and adds
// row_number when known.
func (t *sheetTable) object(row []any, rowNumber int) map[string]any {
	obj := make(map[string]any, len(t.header)+1)
	for j, h := range t.header {
		if h == "" {
			continue
		}
		if j < len(row) && row[j] != nil {
			obj[h] = row[j]
		} else {
			obj[h] = ""
		}
	}
	if rowNumber > 0 {
		obj["row_number"] = rowNumber
	}
	return obj
}

// rowValues lays data out in header order ("" for missing columns).
func (t *sheetTable) rowValues(data map[string]any) []any {
	row := make([]any, len(t.header))
	for j, h := range t.header {
		row[j] = ""
		if v, ok := data[h]; ok && h != "" {
			row[j] = cellValue(v)
		}
	}
	return row
}

func (t *sheetTable) setRow(rowNumber int, values []any) {
	k := rowNumber - 2
	if k < 0 {
		return
	}
	for len(t.rows) <= k {
		t.rows = append(t.rows, nil)
	}
	t.rows[k] = values
}

func unknownColumn(t *sheetTable, name string) error {
	return userError(fmt.Sprintf("The header row of sheet %q has: %s.", t.sheet, strings.Join(t.header, ", ")),
		"Column %q is not in the sheet", name)
}

// cellValue converts an item value for the Sheets API: primitives as they
// are, objects and arrays as JSON text.
func cellValue(v any) any {
	switch t := v.(type) {
	case nil:
		return ""
	case string, bool, float64, float32, int, int64, int32, json.Number:
		return t
	default:
		return landflow.Stringify(t)
	}
}

func cellText(row []any, col int) string {
	if col < len(row) {
		return landflow.Stringify(row[col])
	}
	return ""
}

func isEmptyRow(row []any) bool {
	for _, v := range row {
		if landflow.Stringify(v) != "" {
			return false
		}
	}
	return true
}

func stringsToAny(in []string) []any {
	out := make([]any, len(in))
	for i, s := range in {
		out[i] = s
	}
	return out
}

// quoteSheet quotes a sheet title for A1 notation and doubles the single
// quotes inside it.
func quoteSheet(title string) string {
	return "'" + strings.ReplaceAll(title, "'", "''") + "'"
}

// columnLetter turns a 1-based column number into A, …, Z, AA, ….
func columnLetter(n int) string {
	var b []byte
	for n > 0 {
		n--
		b = append([]byte{byte('A' + n%26)}, b...)
		n /= 26
	}
	return string(b)
}

// startRow returns the first row of an A1 range ("'S'!A5:C7" → 5), or 0.
func startRow(a1 string) int {
	if k := strings.LastIndex(a1, "!"); k >= 0 {
		a1 = a1[k+1:]
	}
	a1 = strings.TrimLeft(a1, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz$")
	end := 0
	for end < len(a1) && a1[end] >= '0' && a1[end] <= '9' {
		end++
	}
	n, _ := strconv.Atoi(a1[:end])
	return n
}

// LoadOptionsWithContext serves the document, sheet and column pickers.
func (SheetsNode) LoadOptionsWithContext(ctx *landflow.LoadOptionsContext) ([]landflow.PropertyOption, error) {
	return loadSheetsOptions(ctx)
}

func loadSheetsOptions(ctx *landflow.LoadOptionsContext) ([]landflow.PropertyOption, error) {
	c, err := newClient(ctx, ctx.ParamString("authentication", "serviceAccount"))
	if err != nil {
		return nil, err
	}
	docID := idFrom(ctx.ParamString("documentId", ""), spreadsheetURLPattern)
	switch ctx.Method() {
	case "spreadsheets":
		return driveFileOptions(ctx, c, "mimeType = '"+mimeSpreadsheet+"' and trashed = false", "modifiedTime desc")
	case "sheets":
		if docID == "" {
			return []landflow.PropertyOption{}, nil
		}
		sheets, err := listSheets(ctx, c, docID)
		if err != nil {
			return nil, err
		}
		opts := make([]landflow.PropertyOption, 0, len(sheets))
		for _, sh := range sheets {
			opts = append(opts, landflow.PropertyOption{Name: sh.Title, Value: sh.Title, Description: fmt.Sprintf("gid=%d", sh.SheetID)})
		}
		return opts, nil
	case "columns":
		if docID == "" {
			return []landflow.PropertyOption{}, nil
		}
		sheet := strings.TrimSpace(ctx.ParamString("sheetName", ""))
		if sheet == "" {
			sheets, err := listSheets(ctx, c, docID)
			if err != nil || len(sheets) == 0 {
				return []landflow.PropertyOption{}, err
			}
			sheet = sheets[0].Title
		}
		vr, err := getValues(ctx, c, docID, quoteSheet(sheet)+"!1:1")
		if err != nil {
			return nil, err
		}
		opts := []landflow.PropertyOption{}
		for _, h := range tableFrom(docID, sheet, vr.Values).header {
			if h != "" {
				opts = append(opts, landflow.PropertyOption{Name: h, Value: h})
			}
		}
		return opts, nil
	}
	return nil, fmt.Errorf("unknown loadOptions method %q (supported: spreadsheets, sheets, columns)", ctx.Method())
}
