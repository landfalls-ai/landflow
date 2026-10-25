package main

import (
	"encoding/base64"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/landflow/landflow/plugins/google-workspace/internal/fakegoogle"
)

func (h *harness) driveFiles() {
	h.fake.AddFile(&fakegoogle.File{ID: "folder-1", Name: "Reports", MimeType: "application/vnd.google-apps.folder"})
	h.fake.AddFile(&fakegoogle.File{ID: "folder-2", Name: "Archive", MimeType: "application/vnd.google-apps.folder"})
	h.fake.AddFile(&fakegoogle.File{ID: "file-csv", Name: "q3.csv", MimeType: "text/csv", Content: []byte("a,b\n1,2\n"), Parents: []string{"folder-1"}})
	h.fake.AddFile(&fakegoogle.File{ID: "file-png", Name: "logo.png", MimeType: "image/png", Content: []byte{0x89, 'P', 'N', 'G', 0xff}})
	h.fake.AddFile(&fakegoogle.File{ID: "file-ob", Name: "O'Brien notes.txt", MimeType: "text/plain", Content: []byte("hi")})
	h.fake.AddFile(&fakegoogle.File{ID: "file-old", Name: "old report.txt", MimeType: "text/plain", Trashed: true, Parents: []string{"folder-1"}})
}

func TestDriveUpload(t *testing.T) {
	h := newHarness(t)
	h.driveFiles()
	out := h.ok(h.exec("googleDrive", map[string]any{
		"resource": "file", "operation": "upload", "name": "notes.txt", "folderId": "folder-1",
		"uploadFrom": "text", "fileContent": "hello, drive",
	}, execOpts{}))
	if len(out) != 1 || out[0]["name"] != "notes.txt" || out[0]["mimeType"] != "text/plain; charset=utf-8" {
		t.Fatalf("output = %v", out)
	}
	f := h.fake.File(out[0]["id"].(string))
	if string(f.Content) != "hello, drive" || !slices.Equal(f.Parents, []string{"folder-1"}) {
		t.Errorf("stored file = %+v", f)
	}
	up := h.fake.Calls(http.MethodPost, "/upload/drive/v3/files")
	if len(up) != 1 || up[0].Query.Get("uploadType") != "multipart" || !strings.HasPrefix(up[0].Header.Get("Content-Type"), "multipart/related; boundary=") {
		t.Errorf("upload request = %+v", up)
	}

	// Base64 (a data: URL works too); binary content defaults to octet-stream.
	data := "data:application/octet-stream;base64," + base64.StdEncoding.EncodeToString([]byte{0, 1, 2, 0xfe})
	out = h.ok(h.exec("googleDrive", map[string]any{
		"resource": "file", "operation": "upload", "name": "blob", "uploadFrom": "base64", "base64Content": data,
	}, execOpts{}))
	f = h.fake.File(out[0]["id"].(string))
	if f.MimeType != "application/octet-stream" || string(f.Content) != "\x00\x01\x02\xfe" || !slices.Equal(f.Parents, []string{"root"}) {
		t.Errorf("base64 upload = %+v", f)
	}
	resp := h.exec("googleDrive", map[string]any{"resource": "file", "operation": "upload", "name": "x", "uploadFrom": "base64", "base64Content": "%%%"}, execOpts{})
	if resp.Error == nil || resp.Error.Message != "Base64 Content is not valid base64" {
		t.Errorf("bad base64 error = %+v", resp.Error)
	}
	resp = h.exec("googleDrive", map[string]any{"resource": "file", "operation": "upload", "name": "big.txt",
		"fileContent": strings.Repeat("x", maxUpload+1)}, execOpts{})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "more than 5 MB") {
		t.Errorf("oversized upload error = %+v", resp.Error)
	}
}

func TestDriveDownload(t *testing.T) {
	h := newHarness(t)
	h.driveFiles()
	h.fake.AddDocument(&fakegoogle.Document{ID: "doc-1", Title: "Plan", Text: "Step 1\nStep 2\n"})
	h.leads()
	download := func(id string) map[string]any {
		t.Helper()
		return h.ok(h.exec("googleDrive", map[string]any{"resource": "file", "operation": "download", "fileId": id}, execOpts{}))[0]
	}
	if got := download("file-csv"); got["encoding"] != "utf8" || got["content"] != "a,b\n1,2\n" || got["size"] != 8 || got["name"] != "q3.csv" {
		t.Errorf("csv = %v", got)
	}
	if got := download("https://drive.google.com/file/d/file-png/view?usp=sharing"); got["encoding"] != "base64" ||
		got["content"] != base64.StdEncoding.EncodeToString([]byte{0x89, 'P', 'N', 'G', 0xff}) || got["mimeType"] != "image/png" {
		t.Errorf("png = %v", got)
	}
	if got := download("doc-1"); got["mimeType"] != "text/plain" || got["content"] != "Step 1\nStep 2\n" {
		t.Errorf("exported doc = %v", got)
	}
	if got := download("sheet-1"); got["mimeType"] != "text/csv" || !strings.HasPrefix(got["content"].(string), "Name,Email,Score\nAda,") {
		t.Errorf("exported sheet = %v", got)
	}
	if n := len(h.fake.Calls(http.MethodGet, "/drive/v3/files/doc-1/export")); n != 1 {
		t.Errorf("%d export calls", n)
	}
	resp := h.exec("googleDrive", map[string]any{"resource": "file", "operation": "download", "fileId": "folder-1"}, execOpts{})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "Cannot download a file of type application/vnd.google-apps.folder") {
		t.Errorf("folder download error = %+v", resp.Error)
	}
	resp = h.exec("googleDrive", map[string]any{"resource": "file", "operation": "download", "fileId": "missing"}, execOpts{})
	if resp.Error == nil || resp.Error.Message != "Google Drive API error 404: File not found: missing." {
		t.Errorf("missing file error = %+v", resp.Error)
	}
}

func TestDriveSearchAndFolders(t *testing.T) {
	h := newHarness(t)
	h.driveFiles()
	search := func(params map[string]any) []map[string]any {
		t.Helper()
		p := map[string]any{"resource": "fileFolder", "operation": "search"}
		for k, v := range params {
			p[k] = v
		}
		return h.ok(h.exec("googleDrive", p, execOpts{}))
	}
	names := func(files []map[string]any) []string {
		var out []string
		for _, f := range files {
			out = append(out, f["name"].(string))
		}
		return out
	}
	if got := names(search(map[string]any{"queryString": "o'brien", "returnAll": true})); !slices.Equal(got, []string{"O'Brien notes.txt"}) {
		t.Errorf("name search = %v", got)
	}
	last := h.fake.Calls(http.MethodGet, "/drive/v3/files")
	if q := last[len(last)-1].Query.Get("q"); q != `name contains 'o\'brien' and trashed = false` {
		t.Errorf("q = %s", q)
	}
	got := names(search(map[string]any{"returnAll": true, "filter": map[string]any{"folderId": "folder-1", "whatToSearch": "files"}}))
	if !slices.Equal(got, []string{"q3.csv"}) {
		t.Errorf("folder search = %v", got)
	}
	got = names(search(map[string]any{"returnAll": true, "filter": map[string]any{"folderId": "folder-1", "includeTrashed": true}}))
	if !slices.Equal(got, []string{"old report.txt", "q3.csv"}) {
		t.Errorf("search with trash = %v", got)
	}
	got = names(search(map[string]any{"searchMethod": "query", "queryString": "mimeType = 'image/png'", "returnAll": true}))
	if !slices.Equal(got, []string{"logo.png"}) {
		t.Errorf("query search = %v", got)
	}

	// Paging: 5 untrashed files, 2 per page.
	h.fake.PageSize = 2
	if got := search(map[string]any{"returnAll": true}); len(got) != 5 {
		t.Errorf("returnAll = %d files", len(got))
	}
	if got := search(map[string]any{"limit": 3}); len(got) != 3 {
		t.Errorf("limit 3 = %d files", len(got))
	}
	h.fake.PageSize = 0

	out := h.ok(h.exec("googleDrive", map[string]any{"resource": "folder", "operation": "create", "name": "2026", "folderId": "folder-2"}, execOpts{}))
	if out[0]["mimeType"] != "application/vnd.google-apps.folder" || h.fake.File(out[0]["id"].(string)).Parents[0] != "folder-2" {
		t.Errorf("folder = %v", out)
	}

	h.ok(h.exec("googleDrive", map[string]any{"resource": "file", "operation": "deleteFile", "fileId": "file-csv"}, execOpts{}))
	if f := h.fake.File("file-csv"); f == nil || !f.Trashed {
		t.Errorf("trashed file = %+v", f)
	}
	out = h.ok(h.exec("googleDrive", map[string]any{"resource": "file", "operation": "deleteFile", "fileId": "file-png",
		"options": map[string]any{"deletePermanently": true}}, execOpts{}))
	if h.fake.File("file-png") != nil || out[0]["deletedPermanently"] != true {
		t.Errorf("permanent delete = %v", out)
	}

	opts := h.loadOptions("googleDrive", "folders", map[string]any{}, nil)
	var folderNames []string
	for _, o := range opts {
		folderNames = append(folderNames, o.Name)
	}
	if !slices.Equal(folderNames, []string{"My Drive (root)", "2026", "Archive", "Reports"}) {
		t.Errorf("folder options = %v", folderNames)
	}
}

func TestDocs(t *testing.T) {
	h := newHarness(t)
	h.driveFiles()
	out := h.ok(h.exec("googleDocs", map[string]any{"resource": "document", "operation": "create", "title": "Minutes", "folderId": "folder-1"}, execOpts{}))
	id, _ := out[0]["documentId"].(string)
	if out[0]["title"] != "Minutes" || out[0]["documentUrl"] != "https://docs.google.com/document/d/"+id+"/edit" || out[0]["folderId"] != "folder-1" {
		t.Errorf("create = %v", out)
	}
	if f := h.fake.File(id); f == nil || !slices.Equal(f.Parents, []string{"folder-1"}) {
		t.Errorf("document parents = %+v", f)
	}
	move := h.fake.Calls(http.MethodPatch, "/drive/v3/files/"+id)
	if len(move) != 1 || move[0].Query.Get("addParents") != "folder-1" || move[0].Query.Get("removeParents") != "root" {
		t.Errorf("move = %+v", move)
	}

	url := "https://docs.google.com/document/d/" + id + "/edit"
	out = h.ok(h.exec("googleDocs", map[string]any{"resource": "document", "operation": "update", "documentURL": url,
		"actionsUi": map[string]any{"actionFields": []any{
			map[string]any{"action": "insert", "text": "Hello team.\nHello again.\n"},
			map[string]any{"action": "replaceAll", "text": "hello", "replaceText": "Hi", "matchCase": false},
		}}}, execOpts{}))
	if out[0]["actions"] != 2 || out[0]["occurrencesChanged"] != 2 {
		t.Errorf("update = %v", out)
	}
	if got := h.fake.DocumentText(id); got != "Hi team.\nHi again.\n" {
		t.Errorf("document text = %q", got)
	}

	out = h.ok(h.exec("googleDocs", map[string]any{"resource": "document", "operation": "get", "documentURL": url}, execOpts{}))
	if out[0]["content"] != "Hi team.\nHi again.\n" || out[0]["title"] != "Minutes" || out[0]["documentId"] != id {
		t.Errorf("get = %v", out)
	}
	raw := h.ok(h.exec("googleDocs", map[string]any{"resource": "document", "operation": "get", "documentURL": id, "simple": false}, execOpts{}))
	if raw[0]["revisionId"] != "rev-1" || raw[0]["body"] == nil {
		t.Errorf("raw get = %v", raw)
	}

	resp := h.exec("googleDocs", map[string]any{"resource": "document", "operation": "update", "documentURL": id, "actionsUi": map[string]any{}}, execOpts{})
	if resp.Error == nil || resp.Error.Message != "Nothing to update" {
		t.Errorf("empty update error = %+v", resp.Error)
	}

	// Tables and tables of contents are flattened too.
	content := []any{
		map[string]any{"paragraph": map[string]any{"elements": []any{map[string]any{"textRun": map[string]any{"content": "Title\n"}}}}},
		map[string]any{"table": map[string]any{"tableRows": []any{map[string]any{"tableCells": []any{
			map[string]any{"content": []any{map[string]any{"paragraph": map[string]any{"elements": []any{map[string]any{"textRun": map[string]any{"content": "A1\n"}}}}}}},
			map[string]any{"content": []any{map[string]any{"paragraph": map[string]any{"elements": []any{map[string]any{"textRun": map[string]any{"content": "B1\n"}}}}}}},
		}}}}},
		map[string]any{"tableOfContents": map[string]any{"content": []any{map[string]any{"paragraph": map[string]any{"elements": []any{map[string]any{"textRun": map[string]any{"content": "TOC\n"}}}}}}}},
	}
	if got := documentText(content); got != "Title\nA1\nB1\nTOC\n" {
		t.Errorf("documentText = %q", got)
	}
}
