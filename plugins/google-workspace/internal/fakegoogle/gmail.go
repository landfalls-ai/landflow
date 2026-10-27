package fakegoogle

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/mail"
	"net/textproto"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Mailbox is the "me" user's mail.
type Mailbox struct {
	Email    string
	Labels   []Label
	Messages []*Message
}

// Label is a Gmail label.
type Label struct {
	ID, Name, Type string
}

// Message is a stored message; Payload is the format=full MIME tree.
type Message struct {
	ID, ThreadID string
	LabelIDs     []string
	InternalDate int64 // ms
	Snippet      string
	Payload      map[string]any
	Raw          []byte // for sent messages
}

// SimpleMessage describes a message to add (multipart/alternative when
// both Text and HTML are set).
type SimpleMessage struct {
	From       string    `json:"from"`
	To         string    `json:"to"`
	Cc         string    `json:"cc"`
	Subject    string    `json:"subject"`
	Text       string    `json:"text"`
	HTML       string    `json:"html"`
	MessageID  string    `json:"messageId"`
	References string    `json:"references"`
	ThreadID   string    `json:"threadId"`
	Labels     []string  `json:"labels"`
	Time       time.Time `json:"time"`
}

func defaultLabels() []Label {
	return []Label{
		{ID: "INBOX", Name: "INBOX", Type: "system"},
		{ID: "UNREAD", Name: "UNREAD", Type: "system"},
		{ID: "SENT", Name: "SENT", Type: "system"},
		{ID: "SPAM", Name: "SPAM", Type: "system"},
		{ID: "TRASH", Name: "TRASH", Type: "system"},
		{ID: "Label_1", Name: "Invoices", Type: "user"},
		{ID: "Label_2", Name: "Alerts", Type: "user"},
	}
}

// AddMessage stores a received message.
func (s *Server) AddMessage(m SimpleMessage) *Message {
	var msg *Message
	s.Do(func() { msg = s.addMessage(m) })
	return msg
}

func (s *Server) addMessage(m SimpleMessage) *Message {
	if m.Time.IsZero() {
		m.Time = time.Now()
	}
	if m.Labels == nil {
		m.Labels = []string{"INBOX", "UNREAD"}
	}
	id := s.id("msg")
	if m.MessageID == "" {
		m.MessageID = "<" + id + "@mail.example.com>"
	}
	headers := []any{
		header("From", m.From), header("To", m.To), header("Subject", m.Subject),
		header("Date", m.Time.Format(time.RFC1123Z)), header("Message-ID", m.MessageID),
	}
	if m.Cc != "" {
		headers = append(headers, header("Cc", m.Cc))
	}
	if m.References != "" {
		headers = append(headers, header("References", m.References))
	}
	textPart := leaf("text/plain; charset=UTF-8", []byte(m.Text))
	var payload map[string]any
	if m.HTML != "" {
		payload = map[string]any{
			"mimeType": "multipart/alternative", "filename": "", "body": map[string]any{"size": 0},
			"headers": append(headers, header("Content-Type", `multipart/alternative; boundary="b1"`)),
			"parts":   []any{textPart, leaf("text/html; charset=UTF-8", []byte(m.HTML))},
		}
	} else {
		payload = textPart
		payload["headers"] = append(headers, header("Content-Type", "text/plain; charset=UTF-8"))
	}
	thread := m.ThreadID
	if thread == "" {
		thread = "thr-" + id
	}
	msg := &Message{ID: id, ThreadID: thread, LabelIDs: m.Labels, InternalDate: m.Time.UnixMilli(), Snippet: snippet(m.Text), Payload: payload}
	s.Mail.Messages = append(s.Mail.Messages, msg)
	return msg
}

func header(name, value string) map[string]any { return map[string]any{"name": name, "value": value} }

func leaf(contentType string, data []byte) map[string]any {
	mt, _, _ := mime.ParseMediaType(contentType)
	return map[string]any{
		"mimeType": mt, "filename": "",
		"headers": []any{header("Content-Type", contentType)},
		"body":    map[string]any{"size": len(data), "data": base64.URLEncoding.EncodeToString(data)},
	}
}

func snippet(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > 100 {
		text = text[:100]
	}
	return text
}

func (s *Server) gmail(w http.ResponseWriter, r *http.Request, segs []string, body []byte) {
	switch {
	case hasPrefix(segs, "profile") && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"emailAddress": s.Mail.Email, "messagesTotal": len(s.Mail.Messages)})
	case hasPrefix(segs, "labels") && r.Method == http.MethodGet:
		labels := make([]any, len(s.Mail.Labels))
		for k, l := range s.Mail.Labels {
			labels[k] = map[string]any{"id": l.ID, "name": l.Name, "type": l.Type}
		}
		writeJSON(w, http.StatusOK, map[string]any{"labels": labels})
	case len(segs) == 1 && segs[0] == "messages" && r.Method == http.MethodGet:
		s.listMessages(w, r)
	case len(segs) == 2 && segs[1] == "send" && r.Method == http.MethodPost:
		s.sendMessage(w, body)
	case len(segs) == 2 && r.Method == http.MethodGet:
		m := s.message(segs[1])
		if m == nil {
			writeError(w, http.StatusNotFound, "Requested entity was not found.")
			return
		}
		writeJSON(w, http.StatusOK, messageJSON(m, r.URL.Query().Get("format"), r.URL.Query()["metadataHeaders"]))
	case len(segs) == 4 && segs[2] == "attachments" && r.Method == http.MethodGet:
		m := s.message(segs[1])
		if m == nil {
			writeError(w, http.StatusNotFound, "Requested entity was not found.")
			return
		}
		n := 0
		data, ok := attachmentData(m.Payload, segs[3], &n)
		if !ok {
			writeError(w, http.StatusNotFound, "Invalid attachment token")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"size": len(data), "data": data})
	case len(segs) == 3 && segs[2] == "modify" && r.Method == http.MethodPost:
		m := s.message(segs[1])
		if m == nil {
			writeError(w, http.StatusNotFound, "Requested entity was not found.")
			return
		}
		var req struct {
			AddLabelIDs    []string `json:"addLabelIds"`
			RemoveLabelIDs []string `json:"removeLabelIds"`
		}
		_ = json.Unmarshal(body, &req)
		for _, l := range req.AddLabelIDs {
			if !contains(m.LabelIDs, l) {
				m.LabelIDs = append(m.LabelIDs, l)
			}
		}
		var kept []string
		for _, l := range m.LabelIDs {
			if !contains(req.RemoveLabelIDs, l) {
				kept = append(kept, l)
			}
		}
		m.LabelIDs = kept
		writeJSON(w, http.StatusOK, map[string]any{"id": m.ID, "threadId": m.ThreadID, "labelIds": m.LabelIDs})
	default:
		writeError(w, http.StatusNotFound, "unknown Gmail call")
	}
}

func (s *Server) message(id string) *Message {
	for _, m := range s.Mail.Messages {
		if m.ID == id {
			return m
		}
	}
	return nil
}

// listMessages answers messages.list, newest first, with a small subset of
// the search syntax: after:<epoch seconds>, is:unread, is:read, from:x and
// plain words (subject or text).
func (s *Server) listMessages(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	msgs := append([]*Message(nil), s.Mail.Messages...)
	sort.SliceStable(msgs, func(a, b int) bool { return msgs[a].InternalDate > msgs[b].InternalDate })
	var matched []*Message
	for _, m := range msgs {
		if q.Get("includeSpamTrash") != "true" && (contains(m.LabelIDs, "SPAM") || contains(m.LabelIDs, "TRASH")) {
			continue
		}
		ok := true
		for _, l := range q["labelIds"] {
			ok = ok && contains(m.LabelIDs, l)
		}
		for _, term := range strings.Fields(q.Get("q")) {
			ok = ok && matchTerm(m, term)
		}
		if ok {
			matched = append(matched, m)
		}
	}
	start, _ := strconv.Atoi(q.Get("pageToken"))
	size, _ := strconv.Atoi(q.Get("maxResults"))
	size = s.pageSize(size, 100)
	end := min(start+size, len(matched))
	refs := []any{}
	for _, m := range matched[min(start, end):end] {
		refs = append(refs, map[string]any{"id": m.ID, "threadId": m.ThreadID})
	}
	resp := map[string]any{"resultSizeEstimate": len(matched)}
	if len(refs) > 0 {
		resp["messages"] = refs
	}
	if end < len(matched) {
		resp["nextPageToken"] = strconv.Itoa(end)
	}
	writeJSON(w, http.StatusOK, resp)
}

func matchTerm(m *Message, term string) bool {
	key, value, hasKey := strings.Cut(term, ":")
	switch {
	case hasKey && key == "after":
		secs, err := strconv.ParseInt(value, 10, 64)
		return err == nil && m.InternalDate >= secs*1000
	case term == "is:unread":
		return contains(m.LabelIDs, "UNREAD")
	case term == "is:read":
		return !contains(m.LabelIDs, "UNREAD")
	case hasKey && key == "from":
		return strings.Contains(strings.ToLower(headerValue(m.Payload, "From")), strings.ToLower(value))
	}
	hay := strings.ToLower(headerValue(m.Payload, "Subject") + " " + m.Snippet)
	return strings.Contains(hay, strings.ToLower(term))
}

func headerValue(part map[string]any, name string) string {
	list, _ := part["headers"].([]any)
	for _, h := range list {
		hm, _ := h.(map[string]any)
		if strings.EqualFold(hm["name"].(string), name) {
			return hm["value"].(string)
		}
	}
	return ""
}

func messageJSON(m *Message, format string, metadataHeaders []string) map[string]any {
	out := map[string]any{
		"id": m.ID, "threadId": m.ThreadID, "labelIds": m.LabelIDs, "snippet": m.Snippet,
		"internalDate": strconv.FormatInt(m.InternalDate, 10), "historyId": "1", "sizeEstimate": 1024,
	}
	switch format {
	case "minimal":
	case "metadata":
		var headers []any
		for _, h := range m.Payload["headers"].([]any) {
			name := h.(map[string]any)["name"].(string)
			for _, want := range metadataHeaders {
				if strings.EqualFold(want, name) {
					headers = append(headers, h)
				}
			}
		}
		out["payload"] = map[string]any{"mimeType": m.Payload["mimeType"], "headers": headers}
	default:
		out["payload"], _ = withAttachmentIDs(m.Payload, 0)
	}
	return out
}

// withAttachmentIDs copies a payload tree, moving the data of file parts
// (those with a filename) behind attachment ids "att-N" like the real API.
func withAttachmentIDs(part map[string]any, n int) (map[string]any, int) {
	out := map[string]any{}
	for k, v := range part {
		out[k] = v
	}
	if name, _ := part["filename"].(string); name != "" {
		if body, ok := part["body"].(map[string]any); ok {
			moved := map[string]any{"size": body["size"], "attachmentId": "att-" + strconv.Itoa(n)}
			out["body"] = moved
			n++
		}
	}
	if kids, ok := part["parts"].([]any); ok {
		copied := make([]any, len(kids))
		for k, kid := range kids {
			copied[k], n = withAttachmentIDs(kid.(map[string]any), n)
		}
		out["parts"] = copied
	}
	return out, n
}

// attachmentData finds the data of attachment "att-N" in a payload tree.
func attachmentData(part map[string]any, id string, n *int) (string, bool) {
	if name, _ := part["filename"].(string); name != "" {
		if body, ok := part["body"].(map[string]any); ok {
			if "att-"+strconv.Itoa(*n) == id {
				data, _ := body["data"].(string)
				return data, true
			}
			*n++
		}
	}
	if kids, ok := part["parts"].([]any); ok {
		for _, kid := range kids {
			if data, ok := attachmentData(kid.(map[string]any), id, n); ok {
				return data, true
			}
		}
	}
	return "", false
}

// sendMessage stores a sent message, parsing its raw MIME into a payload.
func (s *Server) sendMessage(w http.ResponseWriter, body []byte) {
	var req struct {
		Raw      string `json:"raw"`
		ThreadID string `json:"threadId"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.Raw == "" {
		writeError(w, http.StatusBadRequest, "'raw' RFC822 payload message string or uploading message via /upload/* URL required")
		return
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(req.Raw, "="))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid value for ByteString: raw is not base64url")
		return
	}
	s.storeSent(w, raw, req.ThreadID)
}

// uploadMessage is messages.send on the upload URL: uploadType=media (the
// raw message as the body) or multipart (JSON metadata, then the message).
func (s *Server) uploadMessage(w http.ResponseWriter, r *http.Request, body []byte) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	switch r.URL.Query().Get("uploadType") {
	case "media":
		if ct := r.Header.Get("Content-Type"); ct != "message/rfc822" {
			writeError(w, http.StatusBadRequest, "Media type '"+ct+"' is not supported. Valid media types: [message/*]")
			return
		}
		s.storeSent(w, body, "")
	case "multipart":
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
			ThreadID string `json:"threadId"`
		}
		if err := json.NewDecoder(metaPart).Decode(&meta); err != nil {
			writeError(w, http.StatusBadRequest, "metadata is not JSON")
			return
		}
		msgPart, err := mr.NextPart()
		if err != nil || msgPart.Header.Get("Content-Type") != "message/rfc822" {
			writeError(w, http.StatusBadRequest, "missing message/rfc822 part")
			return
		}
		raw, _ := io.ReadAll(msgPart)
		s.storeSent(w, raw, meta.ThreadID)
	default:
		writeError(w, http.StatusBadRequest, "uploadType must be media or multipart")
	}
}

// storeSent stores a sent raw message, parsing its MIME into a payload.
func (s *Server) storeSent(w http.ResponseWriter, raw []byte, threadID string) {
	payload, text, err := payloadFromRaw(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid RFC 2822 message: "+err.Error())
		return
	}
	if headerValue(payload, "To") == "" && headerValue(payload, "Cc") == "" && headerValue(payload, "Bcc") == "" {
		writeError(w, http.StatusBadRequest, "Invalid To header")
		return
	}
	id := s.id("sent")
	thread := threadID
	if thread == "" {
		thread = "thr-" + id
	}
	m := &Message{ID: id, ThreadID: thread, LabelIDs: []string{"SENT"}, InternalDate: time.Now().UnixMilli(), Snippet: snippet(text), Payload: payload, Raw: raw}
	s.Mail.Messages = append(s.Mail.Messages, m)
	writeJSON(w, http.StatusOK, map[string]any{"id": m.ID, "threadId": m.ThreadID, "labelIds": m.LabelIDs})
}

// payloadFromRaw builds the format=full MIME tree of a raw message.
func payloadFromRaw(raw []byte) (map[string]any, string, error) {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return nil, "", err
	}
	body, err := io.ReadAll(msg.Body)
	if err != nil {
		return nil, "", err
	}
	var text string
	part := buildPart(textproto.MIMEHeader(msg.Header), body, &text)
	return part, text, nil
}

func buildPart(h textproto.MIMEHeader, body []byte, text *string) map[string]any {
	mt, params, _ := mime.ParseMediaType(h.Get("Content-Type"))
	if mt == "" {
		mt = "text/plain"
	}
	headers := []any{}
	for _, k := range sortedKeys(h) {
		for _, v := range h[k] {
			headers = append(headers, header(k, v))
		}
	}
	filename := ""
	if _, dp, err := mime.ParseMediaType(h.Get("Content-Disposition")); err == nil {
		filename = dp["filename"]
	}
	if filename == "" {
		filename = params["name"]
	}
	part := map[string]any{"mimeType": mt, "filename": filename, "headers": headers}
	if strings.HasPrefix(mt, "multipart/") {
		var parts []any
		mr := multipart.NewReader(bytes.NewReader(body), params["boundary"])
		for {
			p, err := mr.NextPart()
			if err != nil {
				break
			}
			data, _ := io.ReadAll(p)
			parts = append(parts, buildPart(p.Header, data, text))
		}
		part["parts"] = parts
		part["body"] = map[string]any{"size": 0}
		return part
	}
	data := body
	if strings.EqualFold(h.Get("Content-Transfer-Encoding"), "base64") {
		data, _ = base64.StdEncoding.DecodeString(strings.Join(strings.Fields(string(body)), ""))
	}
	if mt == "text/plain" && *text == "" {
		*text = string(data)
	}
	part["body"] = map[string]any{"size": len(data), "data": base64.URLEncoding.EncodeToString(data)}
	return part
}
