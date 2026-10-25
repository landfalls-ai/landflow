package main

import (
	"bytes"
	"encoding/base64"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/mail"
	"strings"
	"testing"
	"time"

	"github.com/landflow/landflow/plugins/google-workspace/internal/fakegoogle"
	landflow "github.com/landflow/landflow/sdks/go"
)

// mailPart is one decoded part of a multipart/mixed message.
type mailPart struct {
	contentType, disposition string
	data                     []byte
}

// sentParts parses the sent message with this id into its parts.
func sentParts(t *testing.T, h *harness, id string) (*mail.Message, []mailPart, string) {
	t.Helper()
	var raw []byte
	var thread string
	h.fake.Do(func() {
		for _, m := range h.fake.Mail.Messages {
			if m.ID == id {
				raw, thread = m.Raw, m.ThreadID
			}
		}
	})
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	mt, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil || mt != "multipart/mixed" {
		t.Fatalf("Content-Type = %q (%v)", msg.Header.Get("Content-Type"), err)
	}
	var parts []mailPart
	mr := multipart.NewReader(msg.Body, params["boundary"])
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		enc, _ := io.ReadAll(p)
		data, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(string(enc)), ""))
		if err != nil {
			t.Fatalf("part is not base64: %v", err)
		}
		parts = append(parts, mailPart{contentType: p.Header.Get("Content-Type"), disposition: p.Header.Get("Content-Disposition"), data: data})
	}
	return msg, parts, thread
}

// binaryHost serves GET /api/binary/{id} for the bearer token "tok".
func binaryHost(t *testing.T, files map[string][]byte) *landflow.BinaryAccess {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		data, ok := files[strings.TrimPrefix(r.URL.Path, "/api/binary/")]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"Binary data not found"}`))
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(srv.Close)
	return &landflow.BinaryAccess{URL: srv.URL + "/api/binary", Token: "tok"}
}

func inlineRef(name, mimeType string, data []byte) landflow.BinaryRef {
	return landflow.BinaryRef{FileName: name, MimeType: mimeType, FileSize: int64(len(data)), Data: base64.StdEncoding.EncodeToString(data)}
}

func TestGmailSendWithAttachments(t *testing.T) {
	h := newHarness(t)
	pdf := []byte("%PDF-1.4 fake invoice")
	access := binaryHost(t, map[string][]byte{"ex_1.invoicepdf1": pdf})
	params := map[string]any{
		"resource": "message", "operation": "send", "sendTo": "ann@example.com", "subject": "Your files",
		"emailType": "html", "message": "<p>Attached.</p>", "options": map[string]any{"attachments": "data, invoice ,data"},
	}
	files := map[string]landflow.BinaryRef{
		"data":    inlineRef("Grüße résumé.txt", "text/plain", []byte("hello\nworld")),
		"invoice": {ID: "ex_1.invoicepdf1", MimeType: "application/pdf", FileExtension: "pdf", FileSize: int64(len(pdf))},
	}
	out := h.ok(h.exec("gmail", params, execOpts{binary: []map[string]landflow.BinaryRef{files}, access: access}))
	msg, parts, _ := sentParts(t, h, out[0]["id"].(string))
	if msg.Header.Get("Subject") == "" || len(parts) != 3 {
		t.Fatalf("parts = %d", len(parts))
	}
	if parts[0].contentType != `text/html; charset="UTF-8"` || string(parts[0].data) != "<p>Attached.</p>" {
		t.Errorf("body part = %+v", parts[0])
	}
	// A non-ASCII file name is RFC 2231-encoded; mime decodes it back.
	if _, p, _ := mime.ParseMediaType(parts[1].disposition); p["filename"] != "Grüße résumé.txt" || string(parts[1].data) != "hello\nworld" || !strings.HasPrefix(parts[1].contentType, "text/plain") {
		t.Errorf("text attachment = %+v (%v)", parts[1], p)
	}
	// A stored file without a name is named after its property and extension.
	if _, p, _ := mime.ParseMediaType(parts[2].disposition); p["filename"] != "invoice.pdf" || !bytes.Equal(parts[2].data, pdf) || !strings.HasPrefix(parts[2].contentType, "application/pdf") {
		t.Errorf("pdf attachment = %+v (%v)", parts[2], p)
	}
	if n := len(h.fake.Calls(http.MethodPost, "/upload/gmail/v1/users/me/messages/send")); n != 0 {
		t.Errorf("%d uploads for a small message", n)
	}

	// n8n's attachmentsUi shape works too.
	params["options"] = map[string]any{"attachmentsUi": map[string]any{"attachmentsBinary": []any{map[string]any{"property": "invoice"}}}}
	out = h.ok(h.exec("gmail", params, execOpts{binary: []map[string]landflow.BinaryRef{files}, access: access}))
	if _, parts, _ := sentParts(t, h, out[0]["id"].(string)); len(parts) != 2 || !bytes.Equal(parts[1].data, pdf) {
		t.Errorf("attachmentsUi parts = %+v", parts)
	}

	// A missing property is a clear item error; continue-on-fail keeps going.
	params["options"] = map[string]any{"attachments": "missing"}
	resp := h.exec("gmail", params, execOpts{binary: []map[string]landflow.BinaryRef{files}, access: access})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, `item 0 has no binary file "missing"`) || resp.Error.ItemIndex == nil {
		t.Errorf("missing attachment error = %+v", resp.Error)
	}
}

func TestGmailLargeMessagesUseUpload(t *testing.T) {
	h := newHarness(t)
	big := bytes.Repeat([]byte("0123456789abcdef"), (gmailRawLimit/16)+1024)
	files := []map[string]landflow.BinaryRef{{"data": inlineRef("big.bin", "application/octet-stream", big)}}
	params := map[string]any{
		"resource": "message", "operation": "send", "sendTo": "ann@example.com", "subject": "Big",
		"emailType": "text", "message": "see attachment", "options": map[string]any{"attachments": "data"},
	}
	out := h.ok(h.exec("gmail", params, execOpts{binary: files}))
	calls := h.fake.Calls(http.MethodPost, "/upload/gmail/v1/users/me/messages/send")
	if len(calls) != 1 || calls[0].Query.Get("uploadType") != "media" || calls[0].Header.Get("Content-Type") != "message/rfc822" {
		t.Fatalf("upload calls = %+v", calls)
	}
	if _, parts, _ := sentParts(t, h, out[0]["id"].(string)); len(parts) != 2 || !bytes.Equal(parts[1].data, big) {
		t.Errorf("uploaded attachment: %d parts", len(parts))
	}

	// A big reply keeps its thread through a multipart upload.
	orig := h.fake.AddMessage(fakegoogle.SimpleMessage{From: "carol@example.com", To: "me@example.com", Subject: "Logs", Text: "send logs", MessageID: "<o-1@example.com>"})
	reply := map[string]any{"resource": "message", "operation": "reply", "messageId": orig.ID, "message": "here", "emailType": "text", "options": map[string]any{"attachments": "data", "replyToSenderOnly": true}}
	out = h.ok(h.exec("gmail", reply, execOpts{binary: files}))
	calls = h.fake.Calls(http.MethodPost, "/upload/gmail/v1/users/me/messages/send")
	if len(calls) != 2 || calls[1].Query.Get("uploadType") != "multipart" {
		t.Fatalf("reply upload = %+v", calls[len(calls)-1].Query)
	}
	if _, _, thread := sentParts(t, h, out[0]["id"].(string)); thread != orig.ThreadID {
		t.Errorf("reply thread = %q, want %q", thread, orig.ThreadID)
	}

	// Over Gmail's 35 MB limit: refused before sending.
	huge := []map[string]landflow.BinaryRef{{"data": inlineRef("huge.bin", "", bytes.Repeat([]byte{1}, gmailMaxMessage))}}
	resp := h.exec("gmail", params, execOpts{binary: huge})
	if resp.Error == nil || !strings.Contains(resp.Error.Description, "35 MB") {
		t.Errorf("huge message error = %+v", resp.Error)
	}
}

func TestOutgoingMailAttachmentMIME(t *testing.T) {
	m := outgoingMail{
		To: "a@example.com", Subject: "s", Body: "hi", Date: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), boundary: "BOUNDARY",
		Attachments: []mailAttachment{{FileName: "evil\r\nBcc: x@example.com.txt", MimeType: "not a mime", Data: []byte("x")}},
	}
	raw := string(m.bytes())
	for _, want := range []string{
		"Content-Type: multipart/mixed; boundary=BOUNDARY\r\n", "--BOUNDARY\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\n",
		"Content-Type: application/octet-stream; name=\"evil Bcc: x@example.com.txt\"\r\n", "--BOUNDARY--\r\n",
	} {
		if !strings.Contains(raw, want) {
			t.Errorf("raw message lacks %q:\n%s", want, raw)
		}
	}
	if strings.Contains(raw, "\r\nBcc:") {
		t.Errorf("a file name injected a header:\n%s", raw)
	}
}
