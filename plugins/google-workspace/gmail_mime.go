package main

import (
	"encoding/base64"
	"io"
	"mime"
	"mime/multipart"
	"net/mail"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	landflow "github.com/landflow/landflow/sdks/go"
)

// MIME for Gmail: building RFC 2822 messages for messages.send (base64url in
// "raw") and reading the decoded MIME tree of messages.get (format=full).

// outgoingMail is a text or HTML message, multipart/mixed when it has
// attachments.
type outgoingMail struct {
	From, To, Cc, Bcc, ReplyTo string
	Subject                    string
	InReplyTo, References      string
	HTML                       bool
	Body                       string
	Date                       time.Time
	Attachments                []mailAttachment
	// boundary is fixed by tests; empty picks a random one.
	boundary string
}

// mailAttachment is a file attached to an outgoing message.
type mailAttachment struct {
	FileName, MimeType string
	Data               []byte
}

// bytes renders the message with CRLF line endings: address headers
// re-formatted (display names RFC 2047-encoded), an RFC 2047 subject and a
// base64 UTF-8 body, then each attachment as a base64 part (file names
// RFC 2231-encoded). CR and LF in header values are replaced, so a value
// cannot inject headers.
func (m outgoingMail) bytes() []byte {
	var b strings.Builder
	header := func(name, value string) {
		if value != "" {
			b.WriteString(name + ": " + value + "\r\n")
		}
	}
	date := m.Date
	if date.IsZero() {
		date = time.Now()
	}
	header("From", formatAddressList(m.From))
	header("To", formatAddressList(m.To))
	header("Cc", formatAddressList(m.Cc))
	header("Bcc", formatAddressList(m.Bcc))
	header("Reply-To", formatAddressList(m.ReplyTo))
	header("Subject", mime.BEncoding.Encode("UTF-8", cleanHeader(m.Subject)))
	header("Date", date.Format(time.RFC1123Z))
	header("In-Reply-To", cleanHeader(m.InReplyTo))
	header("References", cleanHeader(m.References))
	header("MIME-Version", "1.0")
	ctype := "text/plain"
	if m.HTML {
		ctype = "text/html"
	}
	body := strings.ReplaceAll(strings.ReplaceAll(m.Body, "\r\n", "\n"), "\n", "\r\n")
	if len(m.Attachments) == 0 {
		header("Content-Type", ctype+`; charset="UTF-8"`)
		header("Content-Transfer-Encoding", "base64")
		b.WriteString("\r\n")
		writeBase64Lines(&b, []byte(body))
		return []byte(b.String())
	}

	boundary := m.boundary
	if boundary == "" {
		boundary = multipart.NewWriter(io.Discard).Boundary()
	}
	header("Content-Type", mime.FormatMediaType("multipart/mixed", map[string]string{"boundary": boundary}))
	b.WriteString("\r\n")
	b.WriteString("--" + boundary + "\r\n")
	header("Content-Type", ctype+`; charset="UTF-8"`)
	header("Content-Transfer-Encoding", "base64")
	b.WriteString("\r\n")
	writeBase64Lines(&b, []byte(body))
	for _, a := range m.Attachments {
		name := cleanHeader(a.FileName)
		if name == "" {
			name = "attachment"
		}
		mt, params, err := mime.ParseMediaType(a.MimeType)
		if err != nil {
			mt, params = landflow.DefaultMimeType, map[string]string{}
		}
		params["name"] = name
		b.WriteString("--" + boundary + "\r\n")
		header("Content-Type", mime.FormatMediaType(mt, params))
		header("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
		header("Content-Transfer-Encoding", "base64")
		b.WriteString("\r\n")
		writeBase64Lines(&b, a.Data)
	}
	b.WriteString("--" + boundary + "--\r\n")
	return []byte(b.String())
}

// writeBase64Lines writes data as base64 in 76-character lines.
func writeBase64Lines(b *strings.Builder, data []byte) {
	enc := base64.StdEncoding.EncodeToString(data)
	for len(enc) > 76 {
		b.WriteString(enc[:76] + "\r\n")
		enc = enc[76:]
	}
	b.WriteString(enc + "\r\n")
}

// raw is the base64url form messages.send expects.
func (m outgoingMail) raw() string { return base64.RawURLEncoding.EncodeToString(m.bytes()) }

func cleanHeader(s string) string {
	return strings.TrimSpace(strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ").Replace(s))
}

// formatAddressList normalises "Name <a@x>, b@y" (commas or semicolons). A
// list Go cannot parse is passed through for Gmail to judge.
func formatAddressList(s string) string {
	s = cleanHeader(s)
	if s == "" {
		return ""
	}
	list, err := mail.ParseAddressList(strings.ReplaceAll(s, ";", ","))
	if err != nil {
		return s
	}
	parts := make([]string, len(list))
	for i, a := range list {
		if a.Name == "" {
			parts[i] = a.Address
		} else {
			parts[i] = a.String()
		}
	}
	return strings.Join(parts, ", ")
}

// addresses returns the lower-cased addresses of a header value.
func addresses(s string) []string {
	list, err := mail.ParseAddressList(strings.ReplaceAll(cleanHeader(s), ";", ","))
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, a := range list {
		out = append(out, strings.ToLower(a.Address))
	}
	return out
}

// gmailMessage is a Users.messages resource.
type gmailMessage struct {
	ID           string     `json:"id"`
	ThreadID     string     `json:"threadId"`
	LabelIDs     []string   `json:"labelIds"`
	Snippet      string     `json:"snippet"`
	InternalDate string     `json:"internalDate"` // ms since the epoch, as a string
	Payload      *gmailPart `json:"payload"`
}

// gmailPart is one node of the MIME tree.
type gmailPart struct {
	PartID   string        `json:"partId"`
	MimeType string        `json:"mimeType"`
	Filename string        `json:"filename"`
	Headers  []gmailHeader `json:"headers"`
	Body     struct {
		Size         int    `json:"size"`
		Data         string `json:"data"`
		AttachmentID string `json:"attachmentId"`
	} `json:"body"`
	Parts []*gmailPart `json:"parts"`
}

type gmailHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// header returns a header of the top-level part, RFC 2047-decoded.
func (m *gmailMessage) header(name string) string {
	if m.Payload == nil {
		return ""
	}
	return m.Payload.header(name)
}

func (p *gmailPart) header(name string) string {
	for _, h := range p.Headers {
		if strings.EqualFold(h.Name, name) {
			if dec, err := new(mime.WordDecoder).DecodeHeader(h.Value); err == nil {
				return dec
			}
			return h.Value
		}
	}
	return ""
}

// internalTime is the message's receive time.
func (m *gmailMessage) internalTime() (int64, bool) {
	ms, err := strconv.ParseInt(m.InternalDate, 10, 64)
	return ms, err == nil
}

// bodies returns the first text/plain and text/html parts of the MIME tree
// (attachments skipped), decoded to UTF-8.
func (m *gmailMessage) bodies() (text, html string) {
	var walk func(p *gmailPart)
	walk = func(p *gmailPart) {
		if p == nil || (text != "" && html != "") {
			return
		}
		mediaType, params, _ := mime.ParseMediaType(p.header("Content-Type"))
		if mediaType == "" {
			mediaType = strings.ToLower(p.MimeType)
		}
		attachment := p.Filename != "" || strings.HasPrefix(strings.ToLower(p.header("Content-Disposition")), "attachment")
		switch {
		case strings.HasPrefix(mediaType, "multipart/"):
			for _, child := range p.Parts {
				walk(child)
			}
		case attachment:
		case mediaType == "text/plain" && text == "":
			text = decodeBody(p.Body.Data, params["charset"])
		case mediaType == "text/html" && html == "":
			html = decodeBody(p.Body.Data, params["charset"])
		}
	}
	walk(m.Payload)
	return text, html
}

// decodeBody decodes Gmail's base64url body data and converts Latin-1 to
// UTF-8 (other charsets are passed through; invalid bytes become U+FFFD).
func decodeBody(data, charset string) string {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(data, "="))
	if err != nil {
		if raw, err = base64.StdEncoding.DecodeString(data); err != nil {
			return ""
		}
	}
	switch strings.ToLower(strings.Trim(charset, `"`)) {
	case "iso-8859-1", "latin1", "latin-1", "iso8859-1", "windows-1252", "cp1252":
		if !utf8.Valid(raw) {
			runes := make([]rune, len(raw))
			for i, c := range raw {
				runes[i] = rune(c)
			}
			return string(runes)
		}
	}
	return strings.ToValidUTF8(string(raw), "�")
}

// simplify flattens a message: ids, the main headers, labels, and the text
// and HTML bodies.
func (m *gmailMessage) simplify() map[string]any {
	text, html := m.bodies()
	labels := m.LabelIDs
	if labels == nil {
		labels = []string{}
	}
	out := map[string]any{
		"id":       m.ID,
		"threadId": m.ThreadID,
		"snippet":  m.Snippet,
		"from":     m.header("From"),
		"to":       m.header("To"),
		"subject":  m.header("Subject"),
		"date":     m.date(),
		"labelIds": labels,
		"text":     text,
		"html":     html,
	}
	if cc := m.header("Cc"); cc != "" {
		out["cc"] = cc
	}
	return out
}

// date is the receive time in RFC 3339, else the Date header.
func (m *gmailMessage) date() string {
	if ms, ok := m.internalTime(); ok {
		return time.UnixMilli(ms).UTC().Format(time.RFC3339)
	}
	raw := m.header("Date")
	if t, err := mail.ParseDate(raw); err == nil {
		return t.UTC().Format(time.RFC3339)
	}
	return raw
}

// attachmentParts returns the parts of the MIME tree that are files: a file
// name and either an attachment id or inline data.
func (m *gmailMessage) attachmentParts() []*gmailPart {
	var out []*gmailPart
	var walk func(p *gmailPart)
	walk = func(p *gmailPart) {
		if p == nil {
			return
		}
		if p.Filename != "" && (p.Body.AttachmentID != "" || p.Body.Data != "") {
			out = append(out, p)
		}
		for _, child := range p.Parts {
			walk(child)
		}
	}
	walk(m.Payload)
	return out
}
