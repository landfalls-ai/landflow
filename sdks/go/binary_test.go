package landflow

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeBinaryHost is the host's binary API: GET /api/binary/{id} and POST /api/binary.
type fakeBinaryHost struct {
	*httptest.Server
	token string

	mu      sync.Mutex
	files   map[string][]byte
	uploads []fakeUpload
}

type fakeUpload struct {
	contentType, fileName string
	size                  int
}

func newFakeBinaryHost(t *testing.T, token string) *fakeBinaryHost {
	h := &fakeBinaryHost{token: token, files: map[string][]byte{}}
	h.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+h.token {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"bad token"}`))
			return
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/binary/"):
			data, ok := h.files[strings.TrimPrefix(r.URL.Path, "/api/binary/")]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"error":"Binary data not found"}`))
				return
			}
			_, _ = w.Write(data)
		case r.Method == http.MethodPost && r.URL.Path == "/api/binary":
			data, _ := io.ReadAll(r.Body)
			name, _ := url.PathUnescape(r.Header.Get("X-Landflow-File-Name"))
			id := "ex_test.upload" + strings.Repeat("x", 8) + string(rune('a'+len(h.uploads)))
			h.files[id] = data
			h.uploads = append(h.uploads, fakeUpload{contentType: r.Header.Get("Content-Type"), fileName: name, size: len(data)})
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(BinaryRef{ID: id, MimeType: r.Header.Get("Content-Type"), FileName: name, FileSize: int64(len(data)), FileType: FileTypeOf(r.Header.Get("Content-Type"))})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(h.Close)
	return h
}

func (h *fakeBinaryHost) access() *BinaryAccess {
	return &BinaryAccess{URL: h.URL + "/api/binary", Token: h.token}
}

// funcNode is a node built from a descriptor and an Execute function.
type funcNodeT struct {
	d  NodeDescriptor
	fn func(*ExecuteContext) ([][]Item, error)
}

func (n funcNodeT) Description() NodeDescriptor                   { return n.d }
func (n funcNodeT) Execute(ctx *ExecuteContext) ([][]Item, error) { return n.fn(ctx) }

func funcNode(d NodeDescriptor, fn func(*ExecuteContext) ([][]Item, error)) Node {
	return funcNodeT{d: d, fn: fn}
}

func binaryCtx(access *BinaryAccess, items ...Item) *ExecuteContext {
	req := &ExecuteRequest{Protocol: ProtocolVersion, ExecutionID: "ex_test", Inputs: [][]Item{items}, BinaryAccess: access}
	return NewExecuteContext(context.Background(), req, &NodeDescriptor{})
}

func TestBinaryReadStoredAndInline(t *testing.T) {
	host := newFakeBinaryHost(t, "tok-1")
	host.files["ex_test.storedfile1"] = []byte("stored bytes")
	inline := base64.StdEncoding.EncodeToString([]byte("inline bytes"))
	ctx := binaryCtx(host.access(),
		Item{JSON: map[string]any{}, Binary: map[string]BinaryRef{"data": {ID: "ex_test.storedfile1", MimeType: "text/plain", FileSize: 12}}},
		Item{JSON: map[string]any{}, Binary: map[string]BinaryRef{"doc": {MimeType: "text/plain", Data: inline}}},
	)

	got, err := ctx.BinaryBytes(0, "")
	if err != nil || string(got) != "stored bytes" {
		t.Fatalf("BinaryBytes(0) = %q, %v", got, err)
	}
	rc, err := ctx.BinaryReader(1, "doc")
	if err != nil {
		t.Fatal(err)
	}
	streamed, _ := io.ReadAll(rc)
	_ = rc.Close()
	if string(streamed) != "inline bytes" {
		t.Errorf("BinaryReader(1, doc) = %q", streamed)
	}
	if ref, err := ctx.BinaryRef(0, "data"); err != nil || ref.ID != "ex_test.storedfile1" {
		t.Errorf("BinaryRef = %+v, %v", ref, err)
	}

	if _, err := ctx.BinaryBytes(0, "missing"); err == nil || err.Error() != `item 0 has no binary file "missing"` {
		t.Errorf("missing property error = %v", err)
	}
	if _, err := ctx.BinaryBytes(7, "data"); err == nil || !strings.Contains(err.Error(), "no input item 7") {
		t.Errorf("missing item error = %v", err)
	}
	if _, err := ctx.ReadBinary(BinaryRef{ID: "ex_test.unknownfile"}); err == nil || !strings.Contains(err.Error(), "404") || !strings.Contains(err.Error(), "Binary data not found") {
		t.Errorf("unknown id error = %v", err)
	}
}

func TestBinaryReadChecksToken(t *testing.T) {
	host := newFakeBinaryHost(t, "right")
	host.files["ex_test.storedfile1"] = []byte("x")
	ctx := binaryCtx(&BinaryAccess{URL: host.URL + "/api/binary", Token: "wrong"},
		Item{JSON: map[string]any{}, Binary: map[string]BinaryRef{"data": {ID: "ex_test.storedfile1", MimeType: "text/plain"}}})
	if _, err := ctx.BinaryBytes(0, "data"); err == nil || !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "bad token") {
		t.Errorf("wrong token error = %v", err)
	}
	noAccess := binaryCtx(nil, Item{JSON: map[string]any{}, Binary: map[string]BinaryRef{"data": {ID: "ex_test.storedfile1", MimeType: "text/plain"}}})
	if _, err := noAccess.BinaryBytes(0, "data"); err == nil || !strings.Contains(err.Error(), "binaryAccess") {
		t.Errorf("no binaryAccess error = %v", err)
	}
}

func TestPrepareBinaryInlineAndUpload(t *testing.T) {
	host := newFakeBinaryHost(t, "tok")
	ctx := binaryCtx(host.access())

	small, err := ctx.PrepareBinary([]byte("a,b\n1,2\n"), "report.csv", "")
	if err != nil {
		t.Fatal(err)
	}
	if small.ID != "" || small.Data != base64.StdEncoding.EncodeToString([]byte("a,b\n1,2\n")) || small.MimeType != "text/csv" || small.FileExtension != "csv" || small.FileType != "text" || small.FileSize != 8 || small.FileName != "report.csv" {
		t.Errorf("inline ref = %+v", small)
	}
	if len(host.uploads) != 0 {
		t.Errorf("a small file was uploaded: %+v", host.uploads)
	}

	big := bytes.Repeat([]byte{0xAB}, MaxInlineBinaryBytes+1)
	ref, err := ctx.PrepareBinary(big, "Résumé final.pdf", "")
	if err != nil {
		t.Fatal(err)
	}
	if ref.ID == "" || ref.Data != "" || ref.FileSize != int64(len(big)) {
		t.Errorf("uploaded ref = %+v", ref)
	}
	if len(host.uploads) != 1 || host.uploads[0].contentType != "application/pdf" || host.uploads[0].fileName != "Résumé final.pdf" || host.uploads[0].size != len(big) {
		t.Errorf("upload = %+v", host.uploads)
	}
	// What was uploaded reads back.
	if back, err := ctx.ReadBinary(ref); err != nil || !bytes.Equal(back, big) {
		t.Errorf("read back %d bytes, %v", len(back), err)
	}

	// Streams always upload, with the MIME type given.
	sref, err := ctx.PrepareBinaryStream(strings.NewReader("tiny"), "notes", "text/markdown")
	if err != nil || sref.ID == "" || host.uploads[1].contentType != "text/markdown" || host.uploads[1].size != 4 {
		t.Errorf("stream upload: %+v %+v %v", sref, host.uploads, err)
	}

	// Without binaryAccess: small files still work inline, big ones fail clearly.
	offline := binaryCtx(nil)
	if ref, err := offline.PrepareBinary([]byte("hi"), "a.txt", ""); err != nil || ref.Data == "" {
		t.Errorf("offline inline = %+v, %v", ref, err)
	}
	if _, err := offline.PrepareBinary(big, "big.bin", ""); err == nil || !strings.Contains(err.Error(), "binaryAccess") {
		t.Errorf("offline big file error = %v", err)
	}
}

func TestBinaryOverHTTPExecute(t *testing.T) {
	// A node that reads its input file and returns an upper-cased copy, end to end through the plugin's HTTP server.
	host := newFakeBinaryHost(t, "tok")
	host.files["ex_test.inputfile1"] = []byte("hello")
	p := NewPlugin(PluginInfo{ID: "bin", Name: "Bin", Version: "1"}, funcNode(NodeDescriptor{
		Name: "shout", DisplayName: "Shout", Version: V(1), Kind: KindAction,
		Inputs: []PortDescriptor{MainPort()}, Outputs: []PortDescriptor{MainPort()},
	}, func(ctx *ExecuteContext) ([][]Item, error) {
		data, err := ctx.BinaryBytes(0, "data")
		if err != nil {
			return nil, err
		}
		ref, err := ctx.PrepareBinary(bytes.ToUpper(data), "shout.txt", "")
		if err != nil {
			return nil, err
		}
		return [][]Item{{{JSON: map[string]any{"size": len(data)}, Binary: map[string]BinaryRef{"data": ref}}}}, nil
	}))
	srv := httptest.NewServer(p.Handler())
	defer srv.Close()

	body, _ := json.Marshal(map[string]any{
		"protocol": ProtocolVersion, "executionId": "ex_test", "mode": "manual",
		"node":       map[string]any{"id": "n1", "name": "Shout", "type": "bin.shout", "typeVersion": 1},
		"parameters": map[string]any{}, "itemParameters": []any{map[string]any{}},
		"inputs":       [][]any{{map[string]any{"json": map[string]any{}, "binary": map[string]any{"data": map[string]any{"id": "ex_test.inputfile1", "mimeType": "text/plain", "fileSize": 5}}}}},
		"binaryAccess": map[string]any{"url": host.URL + "/api/binary", "token": "tok"},
	})
	res, err := http.Post(srv.URL+PathExecute, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var resp ExecuteResponse
	if err := json.NewDecoder(res.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.Error != nil {
		t.Fatalf("error: %+v", resp.Error)
	}
	out := resp.Outputs[0][0].Binary["data"]
	decoded, _ := base64.StdEncoding.DecodeString(out.Data)
	if string(decoded) != "HELLO" || out.FileName != "shout.txt" || out.MimeType != "text/plain" || out.FileSize != 5 {
		t.Errorf("output ref = %+v (%q)", out, decoded)
	}
}

func TestBinaryGRPCRoundTrip(t *testing.T) {
	req := execReq("test-plugin.upper", map[string]any{}, map[string]any{"value": "a"})
	req.Inputs[0][0].Binary = map[string]BinaryRef{"data": {ID: "ex_1.abcdefgh", MimeType: "image/png", FileName: "a.png", FileExtension: "png", FileSize: 42, FileType: "image"}}
	req.BinaryAccess = &BinaryAccess{URL: "http://host/api/binary", Token: "tok"}
	msg, err := ExecuteRequestToProto(req)
	if err != nil {
		t.Fatal(err)
	}
	back, err := executeRequestFromProto(msg)
	if err != nil {
		t.Fatal(err)
	}
	if back.BinaryAccess == nil || *back.BinaryAccess != *req.BinaryAccess {
		t.Errorf("binaryAccess = %+v", back.BinaryAccess)
	}
	if got := back.Inputs[0][0].Binary["data"]; got != req.Inputs[0][0].Binary["data"] {
		t.Errorf("binary = %+v", got)
	}
	// Items without files stay without (no empty map), and a request without access has none.
	plain := execReq("test-plugin.upper", map[string]any{}, map[string]any{"value": "a"})
	msg, _ = ExecuteRequestToProto(plain)
	if msg.GetInputs()[0].GetItems()[0].GetBinary() != nil || msg.GetBinaryAccess() != nil {
		t.Errorf("unexpected binary fields: %v", msg)
	}
	if back, _ := executeRequestFromProto(msg); back.Inputs[0][0].Binary != nil || back.BinaryAccess != nil {
		t.Errorf("unexpected binary after round trip: %+v", back)
	}

	// Through a real gRPC server: the node's output files come back.
	p := NewPlugin(PluginInfo{ID: "bin", Name: "Bin", Version: "1"}, funcNode(NodeDescriptor{
		Name: "attach", DisplayName: "Attach", Version: V(1), Kind: KindAction,
		Inputs: []PortDescriptor{MainPort()}, Outputs: []PortDescriptor{MainPort()},
	}, func(ctx *ExecuteContext) ([][]Item, error) {
		in, err := ctx.BinaryRef(0, "data")
		if err != nil {
			return nil, err
		}
		if ctx.Request().BinaryAccess == nil || ctx.Request().BinaryAccess.Token != "tok" {
			return nil, NewNodeError("binaryAccess missing")
		}
		ref, _ := ctx.PrepareBinary([]byte("{}"), "out.json", "")
		return [][]Item{{{JSON: map[string]any{"in": in.FileName}, Binary: map[string]BinaryRef{"data": in, "out": ref}}}}, nil
	}))
	client := bufconnClient(t, p)
	cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req.Node.Type = "bin.attach"
	msg, _ = ExecuteRequestToProto(req)
	res, err := client.Execute(cctx, msg)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := ExecuteResponseFromProto(res)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Error != nil {
		t.Fatalf("error: %+v", resp.Error)
	}
	files := resp.Outputs[0][0].Binary
	if files["data"].ID != "ex_1.abcdefgh" || files["out"].MimeType != "application/json" || files["out"].FileType != "json" || files["out"].Data == "" {
		t.Errorf("output files = %+v", files)
	}
}

func TestMimeHelpers(t *testing.T) {
	cases := map[string]string{"a.PDF": "application/pdf", "x.tar.gz": "application/gzip", "noext": DefaultMimeType, ".hidden": DefaultMimeType, "dir.d/file": DefaultMimeType, "photo.JPeG": "image/jpeg"}
	for name, want := range cases {
		if got := MimeTypeFromFileName(name); got != want {
			t.Errorf("MimeTypeFromFileName(%q) = %q, want %q", name, got, want)
		}
	}
	types := map[string]string{"image/png": "image", "text/csv; charset=utf-8": "text", "application/json": "json", "application/ld+json": "json", "application/pdf": "pdf", "text/html": "html", "video/mp4": "video", "application/zip": "other", "image/svg+xml": "image"}
	for mime, want := range types {
		if got := FileTypeOf(mime); got != want {
			t.Errorf("FileTypeOf(%q) = %q, want %q", mime, got, want)
		}
	}
	if ref := completeBinaryRef(BinaryRef{MimeType: "image/jpeg"}); ref.FileExtension != "jpg" || ref.FileType != "image" {
		t.Errorf("completeBinaryRef from MIME = %+v", ref)
	}
	if ref := completeBinaryRef(BinaryRef{}); ref.MimeType != DefaultMimeType || ref.FileType != "other" {
		t.Errorf("completeBinaryRef empty = %+v", ref)
	}
}
