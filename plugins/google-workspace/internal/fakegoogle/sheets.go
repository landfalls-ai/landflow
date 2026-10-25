package fakegoogle

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// Spreadsheet is a Sheets document. Cell values are strings, float64 or bool.
type Spreadsheet struct {
	ID, Title string
	Sheets    []*Sheet
}

// Sheet is one tab; Rows[0] is sheet row 1.
type Sheet struct {
	ID    int
	Title string
	Rows  [][]any
}

// AddSpreadsheet stores a spreadsheet and lists it in Drive.
func (s *Server) AddSpreadsheet(id, title string, sheets ...*Sheet) *Spreadsheet {
	sp := &Spreadsheet{ID: id, Title: title, Sheets: sheets}
	s.Do(func() {
		s.Spreadsheets[id] = sp
		s.Files[id] = &File{ID: id, Name: title, MimeType: mimeSpreadsheet, Parents: []string{"root"}}
	})
	return sp
}

// SheetRows returns a copy of a sheet's rows (trailing empty rows dropped).
func (s *Server) SheetRows(docID, title string) [][]any {
	var out [][]any
	s.Do(func() {
		if sh := s.findSheet(docID, title); sh != nil {
			for _, row := range trimRows(sh.Rows) {
				out = append(out, append([]any(nil), row...))
			}
		}
	})
	return out
}

// AppendRows adds rows below a sheet's last non-empty row.
func (s *Server) AppendRows(docID, title string, rows ...[]any) {
	s.Do(func() {
		if sh := s.findSheet(docID, title); sh != nil {
			sh.Rows = append(trimRows(sh.Rows), rows...)
		}
	})
}

func (s *Server) findSheet(docID, title string) *Sheet {
	sp := s.Spreadsheets[docID]
	if sp == nil {
		return nil
	}
	for _, sh := range sp.Sheets {
		if sh.Title == title || (title == "" && sh == sp.Sheets[0]) {
			return sh
		}
	}
	return nil
}

const mimeSpreadsheet = "application/vnd.google-apps.spreadsheet"

func (s *Server) sheets(w http.ResponseWriter, r *http.Request, segs []string, body []byte) {
	switch {
	case len(segs) == 0 && r.Method == http.MethodPost:
		s.createSpreadsheet(w, body)
		return
	case len(segs) == 0:
		writeError(w, http.StatusNotFound, "spreadsheet id missing")
		return
	}
	sp := s.Spreadsheets[segs[0]]
	if sp == nil {
		writeError(w, http.StatusNotFound, "Requested entity was not found.")
		return
	}
	switch {
	case len(segs) == 1 && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, spreadsheetJSON(sp))
	case len(segs) == 2 && segs[1] == "values:batchUpdate" && r.Method == http.MethodPost:
		s.batchUpdate(w, sp, body)
	case len(segs) == 2 && segs[1] == "values:batchGet" && r.Method == http.MethodGet:
		var ranges []any
		for _, rng := range r.URL.Query()["ranges"] {
			vr, err := getRange(sp, rng, r.URL.Query().Get("valueRenderOption"))
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			ranges = append(ranges, vr)
		}
		writeJSON(w, http.StatusOK, map[string]any{"spreadsheetId": sp.ID, "valueRanges": ranges})
	case len(segs) == 3 && segs[1] == "values":
		rng, action := segs[2], ""
		for _, a := range []string{":append", ":clear"} {
			if strings.HasSuffix(rng, a) {
				rng, action = strings.TrimSuffix(rng, a), a
			}
		}
		switch {
		case action == "" && r.Method == http.MethodGet:
			vr, err := getRange(sp, rng, r.URL.Query().Get("valueRenderOption"))
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, vr)
		case action == ":append" && r.Method == http.MethodPost:
			s.appendValues(w, r, sp, rng, body)
		case action == ":clear" && r.Method == http.MethodPost:
			a, sh, err := resolve(sp, rng)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			for row := a.r1; row <= len(sh.Rows) && (a.r2 == 0 || row <= a.r2); row++ {
				for col := a.c1; col <= len(sh.Rows[row-1]) && (a.c2 == 0 || col <= a.c2); col++ {
					sh.Rows[row-1][col-1] = nil
				}
			}
			sh.Rows = trimRows(sh.Rows)
			writeJSON(w, http.StatusOK, map[string]any{"spreadsheetId": sp.ID, "clearedRange": quote(sh.Title) + "!" + a.cells})
		default:
			writeError(w, http.StatusNotFound, "unknown values call")
		}
	default:
		writeError(w, http.StatusNotFound, "unknown spreadsheets call")
	}
}

func (s *Server) createSpreadsheet(w http.ResponseWriter, body []byte) {
	var req struct {
		Properties struct {
			Title string `json:"title"`
		} `json:"properties"`
		Sheets []struct {
			Properties struct {
				Title string `json:"title"`
			} `json:"properties"`
		} `json:"sheets"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sp := &Spreadsheet{ID: s.id("sheet"), Title: req.Properties.Title}
	for k, sh := range req.Sheets {
		sp.Sheets = append(sp.Sheets, &Sheet{ID: k * 1000, Title: sh.Properties.Title})
	}
	if len(sp.Sheets) == 0 {
		sp.Sheets = []*Sheet{{ID: 0, Title: "Sheet1"}}
	}
	s.Spreadsheets[sp.ID] = sp
	s.Files[sp.ID] = &File{ID: sp.ID, Name: sp.Title, MimeType: mimeSpreadsheet, Parents: []string{"root"}}
	writeJSON(w, http.StatusOK, spreadsheetJSON(sp))
}

func spreadsheetJSON(sp *Spreadsheet) map[string]any {
	sheets := make([]any, len(sp.Sheets))
	for k, sh := range sp.Sheets {
		sheets[k] = map[string]any{"properties": map[string]any{"sheetId": sh.ID, "title": sh.Title, "index": k}}
	}
	return map[string]any{
		"spreadsheetId":  sp.ID,
		"properties":     map[string]any{"title": sp.Title},
		"sheets":         sheets,
		"spreadsheetUrl": "https://docs.google.com/spreadsheets/d/" + sp.ID + "/edit",
	}
}

func (s *Server) appendValues(w http.ResponseWriter, r *http.Request, sp *Spreadsheet, rng string, body []byte) {
	a, sh, err := resolve(sp, rng)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	option := r.URL.Query().Get("valueInputOption")
	if option != "USER_ENTERED" && option != "RAW" {
		writeError(w, http.StatusBadRequest, "'valueInputOption' is required but not specified")
		return
	}
	var req struct {
		Values [][]any `json:"values"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sh.Rows = trimRows(sh.Rows)
	first := len(sh.Rows) + 1
	width := 0
	for _, row := range req.Values {
		out := make([]any, a.c1-1, a.c1-1+len(row))
		for _, v := range row {
			out = append(out, entered(v, option))
		}
		sh.Rows = append(sh.Rows, out)
		width = max(width, len(row))
	}
	last := first + len(req.Values) - 1
	updated := fmt.Sprintf("%s!%s%d:%s%d", quote(sh.Title), column(a.c1), first, column(a.c1+max(width, 1)-1), last)
	writeJSON(w, http.StatusOK, map[string]any{
		"spreadsheetId": sp.ID,
		"updates": map[string]any{
			"spreadsheetId": sp.ID, "updatedRange": updated, "updatedRows": len(req.Values),
			"updatedColumns": width, "updatedCells": width * len(req.Values),
		},
	})
}

func (s *Server) batchUpdate(w http.ResponseWriter, sp *Spreadsheet, body []byte) {
	var req struct {
		ValueInputOption string `json:"valueInputOption"`
		Data             []struct {
			Range  string  `json:"range"`
			Values [][]any `json:"values"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.ValueInputOption != "USER_ENTERED" && req.ValueInputOption != "RAW" {
		writeError(w, http.StatusBadRequest, "valueInputOption is required")
		return
	}
	cells := 0
	for _, d := range req.Data {
		a, sh, err := resolve(sp, d.Range)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		for dr, row := range d.Values {
			rowIdx := a.r1 - 1 + dr
			for len(sh.Rows) <= rowIdx {
				sh.Rows = append(sh.Rows, nil)
			}
			for dc, v := range row {
				colIdx := a.c1 - 1 + dc
				for len(sh.Rows[rowIdx]) <= colIdx {
					sh.Rows[rowIdx] = append(sh.Rows[rowIdx], nil)
				}
				sh.Rows[rowIdx][colIdx] = entered(v, req.ValueInputOption)
				cells++
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"spreadsheetId": sp.ID, "totalUpdatedCells": cells})
}

// getRange answers values.get: values start at the range's top-left cell;
// trailing empty rows and cells are omitted, as Google does.
func getRange(sp *Spreadsheet, rng, render string) (map[string]any, error) {
	a, sh, err := resolve(sp, rng)
	if err != nil {
		return nil, err
	}
	var values [][]any
	for row := a.r1; row <= len(sh.Rows) && (a.r2 == 0 || row <= a.r2); row++ {
		src := sh.Rows[row-1]
		var out []any
		for col := a.c1; col <= len(src) && (a.c2 == 0 || col <= a.c2); col++ {
			v := src[col-1]
			if v == nil {
				v = ""
			}
			if render != "UNFORMATTED_VALUE" {
				v = formatted(v)
			}
			out = append(out, v)
		}
		for len(out) > 0 && out[len(out)-1] == "" {
			out = out[:len(out)-1]
		}
		values = append(values, out)
	}
	for len(values) > 0 && len(values[len(values)-1]) == 0 {
		values = values[:len(values)-1]
	}
	resp := map[string]any{"range": quote(sh.Title) + "!" + a.cells, "majorDimension": "ROWS"}
	if len(values) > 0 {
		resp["values"] = values
	}
	return resp, nil
}

// a1 is a parsed range; rows and columns are 1-based, r2/c2 = 0 is open.
type a1 struct {
	sheet          string
	r1, c1, r2, c2 int
	cells          string
}

func resolve(sp *Spreadsheet, rng string) (a1, *Sheet, error) {
	a, err := parseA1(rng)
	if err != nil {
		return a, nil, err
	}
	for _, sh := range sp.Sheets {
		if sh.Title == a.sheet {
			return a, sh, nil
		}
	}
	return a, nil, fmt.Errorf("Unable to parse range: %s", rng)
}

func parseA1(s string) (a1, error) {
	var out a1
	rest := s
	if strings.HasPrefix(s, "'") {
		var b strings.Builder
		i := 1
		for ; i < len(s); i++ {
			if s[i] == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					b.WriteByte('\'')
					i++
					continue
				}
				break
			}
			b.WriteByte(s[i])
		}
		if i >= len(s) {
			return out, fmt.Errorf("Unable to parse range: %s", s)
		}
		out.sheet, rest = b.String(), s[i+1:]
		if rest != "" && !strings.HasPrefix(rest, "!") {
			return out, fmt.Errorf("Unable to parse range: %s", s)
		}
		rest = strings.TrimPrefix(rest, "!")
	} else if k := strings.Index(s, "!"); k >= 0 {
		out.sheet, rest = s[:k], s[k+1:]
	} else {
		out.sheet, rest = s, ""
	}
	out.r1, out.c1 = 1, 1
	if rest == "" {
		out.cells = "A1:" + "ZZZ"
		return out, nil
	}
	out.cells = rest
	from, to, hasTo := strings.Cut(rest, ":")
	c1, r1, ok1 := parseRef(from)
	if !ok1 {
		return out, fmt.Errorf("Unable to parse range: %s", s)
	}
	out.c1, out.r1 = max(c1, 1), max(r1, 1)
	if hasTo {
		c2, r2, ok2 := parseRef(to)
		if !ok2 {
			return out, fmt.Errorf("Unable to parse range: %s", s)
		}
		out.c2, out.r2 = c2, r2
	} else {
		out.c2, out.r2 = c1, r1
	}
	return out, nil
}

// parseRef reads "C5", "C", "5" (0 for a missing part).
func parseRef(ref string) (col, row int, ok bool) {
	i := 0
	for i < len(ref) && ref[i] >= 'A' && ref[i] <= 'Z' {
		col = col*26 + int(ref[i]-'A'+1)
		i++
	}
	if i < len(ref) {
		n, err := strconv.Atoi(ref[i:])
		if err != nil || n < 1 {
			return 0, 0, false
		}
		row = n
	}
	return col, row, ref != ""
}

func column(n int) string {
	var b []byte
	for n > 0 {
		n--
		b = append([]byte{byte('A' + n%26)}, b...)
		n /= 26
	}
	return string(b)
}

func quote(title string) string { return "'" + strings.ReplaceAll(title, "'", "''") + "'" }

// entered applies USER_ENTERED parsing: numbers and booleans in text become
// typed values.
func entered(v any, option string) any {
	str, ok := v.(string)
	if !ok || option != "USER_ENTERED" {
		return v
	}
	if f, err := strconv.ParseFloat(strings.TrimSpace(str), 64); err == nil && strings.TrimSpace(str) != "" {
		return f
	}
	switch strings.ToUpper(str) {
	case "TRUE":
		return true
	case "FALSE":
		return false
	}
	return str
}

// formatted is FORMATTED_VALUE rendering.
func formatted(v any) any {
	switch t := v.(type) {
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strings.ToUpper(strconv.FormatBool(t))
	}
	return v
}

func trimRows(rows [][]any) [][]any {
	empty := func(row []any) bool {
		for _, v := range row {
			if v != nil && v != "" {
				return false
			}
		}
		return true
	}
	for len(rows) > 0 && empty(rows[len(rows)-1]) {
		rows = rows[:len(rows)-1]
	}
	return rows
}
