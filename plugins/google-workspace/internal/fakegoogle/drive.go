package fakegoogle

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// File is a Drive file or folder.
type File struct {
	ID, Name, MimeType string
	Parents            []string
	Trashed            bool
	Content            []byte
	Modified           time.Time
}

const mimeFolder = "application/vnd.google-apps.folder"

// AddFile stores a Drive file.
func (s *Server) AddFile(f *File) *File {
	s.Do(func() {
		if f.ID == "" {
			f.ID = s.id("file")
		}
		if f.Parents == nil {
			f.Parents = []string{"root"}
		}
		s.Files[f.ID] = f
	})
	return f
}

// File returns a copy of a stored file (nil when absent).
func (s *Server) File(id string) *File {
	var out *File
	s.Do(func() {
		if f := s.Files[id]; f != nil {
			cp := *f
			out = &cp
		}
	})
	return out
}

func fileJSON(f *File) map[string]any {
	out := map[string]any{
		"kind": "drive#file", "id": f.ID, "name": f.Name, "mimeType": f.MimeType, "parents": f.Parents,
		"trashed": f.Trashed, "modifiedTime": f.Modified.UTC().Format(time.RFC3339), "createdTime": f.Modified.UTC().Format(time.RFC3339),
		"webViewLink": "https://drive.google.com/file/d/" + f.ID + "/view",
	}
	if !strings.HasPrefix(f.MimeType, "application/vnd.google-apps.") {
		out["size"] = strconv.Itoa(len(f.Content))
	}
	return out
}

func (s *Server) drive(w http.ResponseWriter, r *http.Request, segs []string, body []byte) {
	q := r.URL.Query()
	switch {
	case len(segs) == 0 && r.Method == http.MethodGet:
		s.listFiles(w, r)
	case len(segs) == 0 && r.Method == http.MethodPost:
		var meta struct {
			Name     string   `json:"name"`
			MimeType string   `json:"mimeType"`
			Parents  []string `json:"parents"`
		}
		if err := json.Unmarshal(body, &meta); err != nil || meta.Name == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}
		f := &File{ID: s.id("file"), Name: meta.Name, MimeType: meta.MimeType, Parents: meta.Parents, Modified: time.Now()}
		s.Files[f.ID] = f
		writeJSON(w, http.StatusOK, fileJSON(f))
	case len(segs) >= 1:
		f := s.Files[segs[0]]
		if f == nil {
			writeError(w, http.StatusNotFound, "File not found: "+segs[0]+".")
			return
		}
		switch {
		case len(segs) == 2 && segs[1] == "export" && r.Method == http.MethodGet:
			s.export(w, f, q.Get("mimeType"))
		case len(segs) == 1 && r.Method == http.MethodGet && q.Get("alt") == "media":
			if strings.HasPrefix(f.MimeType, "application/vnd.google-apps.") {
				writeError(w, http.StatusForbidden, "Only files with binary content can be downloaded. Use Export with Docs Editors files.")
				return
			}
			w.Header().Set("Content-Type", f.MimeType)
			_, _ = w.Write(f.Content)
		case len(segs) == 1 && r.Method == http.MethodGet:
			writeJSON(w, http.StatusOK, fileJSON(f))
		case len(segs) == 1 && r.Method == http.MethodPatch:
			var patch map[string]any
			_ = json.Unmarshal(body, &patch)
			if t, ok := patch["trashed"].(bool); ok {
				f.Trashed = t
			}
			if n, ok := patch["name"].(string); ok {
				f.Name = n
			}
			if add := q.Get("addParents"); add != "" {
				remove := strings.Split(q.Get("removeParents"), ",")
				var parents []string
				for _, p := range f.Parents {
					if !contains(remove, p) {
						parents = append(parents, p)
					}
				}
				f.Parents = append(parents, strings.Split(add, ",")...)
			}
			writeJSON(w, http.StatusOK, fileJSON(f))
		case len(segs) == 1 && r.Method == http.MethodDelete:
			delete(s.Files, f.ID)
			w.WriteHeader(http.StatusNoContent)
		default:
			writeError(w, http.StatusNotFound, "unknown files call")
		}
	default:
		writeError(w, http.StatusNotFound, "unknown Drive call")
	}
}

func (s *Server) export(w http.ResponseWriter, f *File, mimeType string) {
	var out string
	switch {
	case f.MimeType == "application/vnd.google-apps.document" && mimeType == "text/plain":
		if d := s.Documents[f.ID]; d != nil {
			out = d.Text
		}
	case f.MimeType == mimeSpreadsheet && mimeType == "text/csv":
		if sp := s.Spreadsheets[f.ID]; sp != nil && len(sp.Sheets) > 0 {
			for _, row := range trimRows(sp.Sheets[0].Rows) {
				cells := make([]string, len(row))
				for k, v := range row {
					cells[k] = fmt.Sprint(formatted(v))
				}
				out += strings.Join(cells, ",") + "\n"
			}
		}
	default:
		writeError(w, http.StatusBadRequest, "Export only supports Docs Editors files.")
		return
	}
	w.Header().Set("Content-Type", mimeType)
	_, _ = io.WriteString(w, out)
}

func (s *Server) listFiles(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var matched []*File
	for _, f := range s.Files {
		ok, err := matchQuery(f, q.Get("q"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Invalid Value: "+err.Error())
			return
		}
		if ok {
			matched = append(matched, f)
		}
	}
	// Stable order: by name, then id.
	for a := 1; a < len(matched); a++ {
		for b := a; b > 0 && (matched[b].Name < matched[b-1].Name || (matched[b].Name == matched[b-1].Name && matched[b].ID < matched[b-1].ID)); b-- {
			matched[b], matched[b-1] = matched[b-1], matched[b]
		}
	}
	start, _ := strconv.Atoi(q.Get("pageToken"))
	size, _ := strconv.Atoi(q.Get("pageSize"))
	size = s.pageSize(size, 100)
	end := min(start+size, len(matched))
	files := []any{}
	for _, f := range matched[min(start, end):end] {
		files = append(files, fileJSON(f))
	}
	resp := map[string]any{"files": files}
	if end < len(matched) {
		resp["nextPageToken"] = strconv.Itoa(end)
	}
	writeJSON(w, http.StatusOK, resp)
}

var (
	reNameContains = regexp.MustCompile(`^name contains '((?:[^'\\]|\\.)*)'$`)
	reNameEquals   = regexp.MustCompile(`^name = '((?:[^'\\]|\\.)*)'$`)
	reMimeType     = regexp.MustCompile(`^mimeType (=|!=) '((?:[^'\\]|\\.)*)'$`)
	reInParents    = regexp.MustCompile(`^'((?:[^'\\]|\\.)*)' in parents$`)
	reTrashed      = regexp.MustCompile(`^trashed = (true|false)$`)
)

// matchQuery evaluates the subset of Drive's query language the plugin
// uses: clauses joined by "and", parenthesised "or" groups.
func matchQuery(f *File, q string) (bool, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return true, nil
	}
	if ands := splitTop(q, " and "); len(ands) > 1 {
		for _, c := range ands {
			ok, err := matchQuery(f, c)
			if err != nil || !ok {
				return false, err
			}
		}
		return true, nil
	}
	if strings.HasPrefix(q, "(") && strings.HasSuffix(q, ")") {
		for _, c := range splitTop(q[1:len(q)-1], " or ") {
			ok, err := matchQuery(f, c)
			if err != nil {
				return false, err
			}
			if ok {
				return true, nil
			}
		}
		return false, nil
	}
	unq := func(s string) string { return strings.NewReplacer(`\'`, `'`, `\\`, `\`).Replace(s) }
	switch {
	case reNameContains.MatchString(q):
		return strings.Contains(strings.ToLower(f.Name), strings.ToLower(unq(reNameContains.FindStringSubmatch(q)[1]))), nil
	case reNameEquals.MatchString(q):
		return f.Name == unq(reNameEquals.FindStringSubmatch(q)[1]), nil
	case reMimeType.MatchString(q):
		m := reMimeType.FindStringSubmatch(q)
		return (f.MimeType == unq(m[2])) == (m[1] == "="), nil
	case reInParents.MatchString(q):
		return contains(f.Parents, unq(reInParents.FindStringSubmatch(q)[1])), nil
	case reTrashed.MatchString(q):
		return f.Trashed == (reTrashed.FindStringSubmatch(q)[1] == "true"), nil
	}
	return false, fmt.Errorf("unsupported query clause %q", q)
}

// splitTop splits s on sep outside quotes and parentheses.
func splitTop(s, sep string) []string {
	var parts []string
	depth, quoted, start := 0, false, 0
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case quoted && c == '\\':
			i++
		case c == '\'':
			quoted = !quoted
		case !quoted && c == '(':
			depth++
		case !quoted && c == ')':
			depth--
		case !quoted && depth == 0 && strings.HasPrefix(s[i:], sep):
			parts = append(parts, s[start:i])
			start = i + len(sep)
			i += len(sep) - 1
		}
	}
	return append(parts, s[start:])
}

// upload handles uploadType=multipart (metadata part, then content part).
func (s *Server) upload(w http.ResponseWriter, r *http.Request, body []byte) {
	if r.Method != http.MethodPost || r.URL.Query().Get("uploadType") != "multipart" {
		writeError(w, http.StatusBadRequest, "only uploadType=multipart is supported")
		return
	}
	mt, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "multipart/related" {
		writeError(w, http.StatusBadRequest, "Content-Type must be multipart/related")
		return
	}
	mr := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	metaPart, err := mr.NextPart()
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing metadata part")
		return
	}
	var meta struct {
		Name     string   `json:"name"`
		MimeType string   `json:"mimeType"`
		Parents  []string `json:"parents"`
	}
	if err := json.NewDecoder(metaPart).Decode(&meta); err != nil {
		writeError(w, http.StatusBadRequest, "metadata is not JSON")
		return
	}
	contentPart, err := mr.NextPart()
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing media part")
		return
	}
	content, _ := io.ReadAll(contentPart)
	mimeType := meta.MimeType
	if mimeType == "" {
		mimeType = contentPart.Header.Get("Content-Type")
	}
	if meta.Parents == nil {
		meta.Parents = []string{"root"}
	}
	f := &File{ID: s.id("file"), Name: meta.Name, MimeType: mimeType, Parents: meta.Parents, Content: content, Modified: time.Now()}
	s.Files[f.ID] = f
	writeJSON(w, http.StatusOK, fileJSON(f))
}
