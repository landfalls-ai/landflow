package fakegoogle

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Document is a Google Doc. Content, when set, is served as the body's
// structural elements (e.g. with a table); otherwise one paragraph per line
// of Text is served.
type Document struct {
	ID, Title string
	Text      string
	Content   []any
}

const mimeDocument = "application/vnd.google-apps.document"

// AddDocument stores a document and lists it in Drive.
func (s *Server) AddDocument(d *Document) {
	s.Do(func() {
		s.Documents[d.ID] = d
		s.Files[d.ID] = &File{ID: d.ID, Name: d.Title, MimeType: mimeDocument, Parents: []string{"root"}, Modified: time.Now()}
	})
}

// DocumentText returns a document's text.
func (s *Server) DocumentText(id string) string {
	var out string
	s.Do(func() {
		if d := s.Documents[id]; d != nil {
			out = d.Text
		}
	})
	return out
}

func (s *Server) docs(w http.ResponseWriter, r *http.Request, segs []string, body []byte) {
	switch {
	case len(segs) == 0 && r.Method == http.MethodPost:
		var req struct {
			Title string `json:"title"`
		}
		_ = json.Unmarshal(body, &req)
		d := &Document{ID: s.id("doc"), Title: req.Title}
		s.Documents[d.ID] = d
		s.Files[d.ID] = &File{ID: d.ID, Name: d.Title, MimeType: mimeDocument, Parents: []string{"root"}, Modified: time.Now()}
		writeJSON(w, http.StatusOK, documentJSON(d))
	case len(segs) == 1 && strings.HasSuffix(segs[0], ":batchUpdate") && r.Method == http.MethodPost:
		d := s.Documents[strings.TrimSuffix(segs[0], ":batchUpdate")]
		if d == nil {
			writeError(w, http.StatusNotFound, "Requested entity was not found.")
			return
		}
		s.batchUpdateDocument(w, d, body)
	case len(segs) == 1 && r.Method == http.MethodGet:
		d := s.Documents[segs[0]]
		if d == nil {
			writeError(w, http.StatusNotFound, "Requested entity was not found.")
			return
		}
		writeJSON(w, http.StatusOK, documentJSON(d))
	default:
		writeError(w, http.StatusNotFound, "unknown Docs call")
	}
}

func documentJSON(d *Document) map[string]any {
	content := d.Content
	if content == nil {
		content = []any{map[string]any{"sectionBreak": map[string]any{}}}
		for _, line := range strings.SplitAfter(d.Text, "\n") {
			if line == "" {
				continue
			}
			content = append(content, map[string]any{"paragraph": map[string]any{
				"elements": []any{map[string]any{"textRun": map[string]any{"content": line}}},
			}})
		}
	}
	return map[string]any{"documentId": d.ID, "title": d.Title, "revisionId": "rev-1", "body": map[string]any{"content": content}}
}

func (s *Server) batchUpdateDocument(w http.ResponseWriter, d *Document, body []byte) {
	var req struct {
		Requests []struct {
			InsertText *struct {
				Text                 string          `json:"text"`
				EndOfSegmentLocation json.RawMessage `json:"endOfSegmentLocation"`
			} `json:"insertText"`
			ReplaceAllText *struct {
				ContainsText struct {
					Text      string `json:"text"`
					MatchCase bool   `json:"matchCase"`
				} `json:"containsText"`
				ReplaceText string `json:"replaceText"`
			} `json:"replaceAllText"`
		} `json:"requests"`
	}
	if err := json.Unmarshal(body, &req); err != nil || len(req.Requests) == 0 {
		writeError(w, http.StatusBadRequest, "requests must not be empty")
		return
	}
	var replies []any
	for _, rq := range req.Requests {
		switch {
		case rq.InsertText != nil:
			if len(rq.InsertText.EndOfSegmentLocation) == 0 {
				writeError(w, http.StatusBadRequest, "only endOfSegmentLocation inserts are supported")
				return
			}
			d.Text += rq.InsertText.Text
			replies = append(replies, map[string]any{})
		case rq.ReplaceAllText != nil:
			find := rq.ReplaceAllText.ContainsText.Text
			pattern := regexp.QuoteMeta(find)
			if !rq.ReplaceAllText.ContainsText.MatchCase {
				pattern = "(?i)" + pattern
			}
			re := regexp.MustCompile(pattern)
			n := len(re.FindAllStringIndex(d.Text, -1))
			d.Text = re.ReplaceAllLiteralString(d.Text, rq.ReplaceAllText.ReplaceText)
			replies = append(replies, map[string]any{"replaceAllText": map[string]any{"occurrencesChanged": n}})
		default:
			writeError(w, http.StatusBadRequest, "unsupported request")
			return
		}
	}
	d.Content = nil
	writeJSON(w, http.StatusOK, map[string]any{"documentId": d.ID, "replies": replies, "writeControl": map[string]any{"requiredRevisionId": "rev-2"}})
}
