package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/landflow/landflow/plugins/google-workspace/internal/fakegoogle"
	landflow "github.com/landflow/landflow/sdks/go"
)

// storeHost is a fake host binary API: GET /api/binary/{id} and POST /api/binary.
type storeHost struct {
	mu    sync.Mutex
	files map[string][]byte
	names map[string]string
	posts int
}

func newStoreHost(t *testing.T, files map[string][]byte) (*storeHost, *landflow.BinaryAccess) {
	h := &storeHost{files: files, names: map[string]string{}}
	if h.files == nil {
		h.files = map[string][]byte{}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		if r.Method == http.MethodPost {
			data, _ := io.ReadAll(r.Body)
			id := "ex_1.stored" + string(rune('a'+h.posts))
			h.posts++
			h.files[id] = data
			name, _ := url.PathUnescape(r.Header.Get("X-Landflow-File-Name"))
			h.names[id] = name
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(landflow.BinaryRef{ID: id, MimeType: r.Header.Get("Content-Type"), FileName: name, FileSize: int64(len(data))})
			return
		}
		data, ok := h.files[strings.TrimPrefix(r.URL.Path, "/api/binary/")]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(srv.Close)
	return h, &landflow.BinaryAccess{URL: srv.URL + "/api/binary", Token: "tok"}
}

// execItems runs a node and returns its output items (with binary refs).
func (h *harness) execItems(node string, params map[string]any, o execOpts) []landflow.Item {
	h.t.Helper()
	resp := h.exec(node, params, o)
	if resp.Error != nil {
		h.t.Fatalf("%s failed: %+v", node, resp.Error)
	}
	return resp.Outputs[0]
}

func TestDriveUploadFromBinary(t *testing.T) {
	h := newHarness(t)
	h.driveFiles()
	pdf := []byte("%PDF-1.4 small")
	big := bytes.Repeat([]byte("0123456789abcdef"), (maxUpload/16)+4096)
	_, access := newStoreHost(t, map[string][]byte{"ex_1.big": big})
	files := map[string]landflow.BinaryRef{
		"data":   inlineRef("report.pdf", "application/pdf", pdf),
		"bigone": {ID: "ex_1.big", FileName: "dump.bin", MimeType: "application/octet-stream", FileSize: int64(len(big))},
	}
	opts := execOpts{binary: []map[string]landflow.BinaryRef{files}, access: access}

	// Small file: one multipart request; the name and type come from the file.
	out := h.ok(h.exec("googleDrive", map[string]any{"resource": "file", "operation": "upload", "uploadFrom": "binary", "folderId": "folder-1"}, opts))
	f := h.fake.File(out[0]["id"].(string))
	if f.Name != "report.pdf" || f.MimeType != "application/pdf" || !bytes.Equal(f.Content, pdf) || f.Parents[0] != "folder-1" {
		t.Errorf("small upload = %+v", f)
	}
	if n := len(h.fake.Calls(http.MethodPost, "/upload/drive/v3/files")); n != 1 {
		t.Errorf("%d upload calls", n)
	}

	// Big file: a resumable session, one streamed PUT; an explicit name wins.
	out = h.ok(h.exec("googleDrive", map[string]any{"resource": "file", "operation": "upload", "uploadFrom": "binary",
		"binaryPropertyName": "bigone", "name": "renamed.bin"}, opts))
	f = h.fake.File(out[0]["id"].(string))
	if f.Name != "renamed.bin" || !bytes.Equal(f.Content, big) || f.MimeType != "application/octet-stream" {
		t.Errorf("big upload: name %q, %d bytes", f.Name, len(f.Content))
	}
	calls := h.fake.Calls(http.MethodPost, "/upload/drive/v3/files")
	if last := calls[len(calls)-1]; last.Query.Get("uploadType") != "resumable" || last.Header.Get("X-Upload-Content-Length") == "" {
		t.Errorf("session request = %+v", last.Query)
	}
	if puts := h.fake.Calls(http.MethodPut, "/upload/drive/v3/files"); len(puts) != 1 {
		t.Errorf("%d PUTs", len(puts))
	}

	// A missing property is a clear item error.
	resp := h.exec("googleDrive", map[string]any{"resource": "file", "operation": "upload", "uploadFrom": "binary", "binaryPropertyName": "nope"}, opts)
	if resp.Error == nil || !strings.Contains(resp.Error.Message, `no binary file "nope"`) {
		t.Errorf("missing file error = %+v", resp.Error)
	}
}

func TestDriveDownloadAndExportToBinary(t *testing.T) {
	h := newHarness(t)
	h.driveFiles()
	h.fake.AddDocument(&fakegoogle.Document{ID: "doc-1", Title: "Plan", Text: "Step 1\n"})
	h.leads()
	big := bytes.Repeat([]byte{0xAB, 0xCD}, landflow.MaxInlineBinaryBytes)
	h.fake.AddFile(&fakegoogle.File{ID: "file-big", Name: "big.bin", MimeType: "application/octet-stream", Content: big})
	store, access := newStoreHost(t, nil)
	opts := execOpts{access: access}
	read := func(items []landflow.Item, prop string) (landflow.BinaryRef, []byte) {
		t.Helper()
		ref, ok := items[0].Binary[prop]
		if !ok {
			t.Fatalf("no binary %q on %+v", prop, items[0].Binary)
		}
		if ref.Data != "" {
			b, _ := base64.StdEncoding.DecodeString(ref.Data)
			return ref, b
		}
		store.mu.Lock()
		defer store.mu.Unlock()
		return ref, store.files[ref.ID]
	}

	// Small download: inline file, name and MIME from Drive; JSON has the metadata only.
	items := h.execItems("googleDrive", map[string]any{"resource": "file", "operation": "download", "fileId": "file-png", "downloadAs": "binary"}, opts)
	ref, data := read(items, "data")
	if ref.FileName != "logo.png" || ref.MimeType != "image/png" || !bytes.Equal(data, []byte{0x89, 'P', 'N', 'G', 0xff}) || items[0].JSON["content"] != nil {
		t.Errorf("png = %+v %q json=%v", ref, data, items[0].JSON)
	}
	if store.posts != 0 {
		t.Errorf("a small file should travel inline, %d uploads", store.posts)
	}

	// Big download is streamed to the host's store under a chosen property.
	items = h.execItems("googleDrive", map[string]any{"resource": "file", "operation": "download", "fileId": "file-big", "downloadAs": "binary", "outputBinaryField": "blob"}, opts)
	ref, data = read(items, "blob")
	if ref.ID == "" || !bytes.Equal(data, big) || store.posts != 1 || items[0].JSON["size"] != int64(len(big)) {
		t.Errorf("big download: id=%q len=%d posts=%d size=%v", ref.ID, len(data), store.posts, items[0].JSON["size"])
	}

	// A Google Doc downloaded as binary is exported to text.
	items = h.execItems("googleDrive", map[string]any{"resource": "file", "operation": "download", "fileId": "doc-1", "downloadAs": "binary"}, opts)
	if ref, data = read(items, "data"); string(data) != "Step 1\n" || ref.FileName != "Plan.txt" || ref.MimeType != "text/plain" {
		t.Errorf("doc = %+v %q", ref, data)
	}

	// Export: PDF of a Doc, XLSX of a Sheet, a custom name and field.
	items = h.execItems("googleDrive", map[string]any{"resource": "file", "operation": "export", "fileId": "doc-1", "exportFormat": "pdf"}, opts)
	if ref, data = read(items, "data"); ref.FileName != "Plan.pdf" || ref.MimeType != "application/pdf" || !strings.HasPrefix(string(data), "FAKE-EXPORT[doc-1 -> application/pdf]") {
		t.Errorf("pdf export = %+v %q", ref, data)
	}
	items = h.execItems("googleSheets", map[string]any{"resource": "spreadsheet", "operation": "export", "exportDocumentId": "https://docs.google.com/spreadsheets/d/sheet-1/edit",
		"exportFormat": "xlsx", "outputBinaryField": "book", "options": map[string]any{"fileName": "leads-q3.xlsx"}}, opts)
	if ref, data = read(items, "book"); ref.FileName != "leads-q3.xlsx" || !strings.Contains(ref.MimeType, "spreadsheetml") || !strings.Contains(string(data), "sheet-1") {
		t.Errorf("xlsx export = %+v %q", ref, data)
	}
	items = h.execItems("googleDocs", map[string]any{"resource": "document", "operation": "export", "documentURL": "doc-1", "exportFormat": "docx"}, opts)
	if ref, _ = read(items, "data"); ref.FileName != "Plan.docx" || !strings.Contains(ref.MimeType, "wordprocessingml") {
		t.Errorf("docx export = %+v", ref)
	}

	// Plain files and folders cannot be exported; bad formats are refused.
	resp := h.exec("googleDrive", map[string]any{"resource": "file", "operation": "export", "fileId": "file-png", "exportFormat": "pdf"}, opts)
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "Cannot export a file of type image/png") {
		t.Errorf("png export error = %+v", resp.Error)
	}
	resp = h.exec("googleDrive", map[string]any{"resource": "file", "operation": "export", "fileId": "doc-1", "exportFormat": "exe"}, opts)
	if resp.Error == nil || !strings.Contains(resp.Error.Message, `Unknown export format "exe"`) {
		t.Errorf("format error = %+v", resp.Error)
	}
}

func TestGmailDownloadsAttachments(t *testing.T) {
	h := newHarness(t)
	pdf := []byte("%PDF-1.4 invoice \x00\xff")
	_, access := newStoreHost(t, nil)
	files := map[string]landflow.BinaryRef{
		"data":    inlineRef("note.txt", "text/plain", []byte("hello")),
		"invoice": inlineRef("invoice.pdf", "application/pdf", pdf),
	}
	sent := h.ok(h.exec("gmail", map[string]any{"resource": "message", "operation": "send", "sendTo": "me@example.com", "subject": "Files",
		"emailType": "text", "message": "see", "options": map[string]any{"attachments": "data,invoice"}},
		execOpts{binary: []map[string]landflow.BinaryRef{files}, access: access}))
	id := sent[0]["id"].(string)

	items := h.execItems("gmail", map[string]any{"resource": "message", "operation": "get", "messageId": id, "downloadAttachments": true}, execOpts{access: access})
	if len(items[0].Binary) != 2 || items[0].JSON["subject"] != "Files" {
		t.Fatalf("binary = %+v json = %v", items[0].Binary, items[0].JSON)
	}
	got := items[0].Binary["attachment_1"]
	data, _ := base64.StdEncoding.DecodeString(got.Data)
	if got.FileName != "invoice.pdf" || got.MimeType != "application/pdf" || !bytes.Equal(data, pdf) {
		t.Errorf("attachment_1 = %+v %q", got, data)
	}
	if n := len(h.fake.Calls(http.MethodGet, "/gmail/v1/users/me/messages/"+id+"/attachments/att-0")); n != 1 {
		t.Errorf("%d attachment calls", n)
	}

	// Get many with a prefix; a message without files has no binary data.
	h.fake.AddMessage(fakegoogle.SimpleMessage{From: "x@example.com", To: "me@example.com", Subject: "Plain", Text: "no files"})
	items = h.execItems("gmail", map[string]any{"resource": "message", "operation": "getAll", "returnAll": true, "downloadAttachments": true,
		"attachmentPrefix": "file"}, execOpts{access: access})
	byID := map[any]landflow.Item{}
	for _, it := range items {
		byID[it.JSON["id"]] = it
	}
	if len(items) != 2 || len(byID[id].Binary) != 2 || byID[id].Binary["file0"].FileName != "note.txt" || len(byID["msg-2"].Binary) != 0 {
		t.Errorf("getAll items = %+v", items)
	}
}
