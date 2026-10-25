package landflow

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
)

// Binary data (docs/protocol.md §11): items carry files under Item.Binary as
// references to bytes in the host's binary store. A ref the host sends has an
// ID; read its bytes with the helpers below, which call the host's binary API
// (ExecuteRequest.BinaryAccess). A node may return a small file inline (Data,
// base64) instead; the host stores it before the next node sees it.

// MaxInlineBinaryBytes is the largest file PrepareBinary returns inline
// (BinaryRef.Data) instead of uploading it (MAX_INLINE_BINARY_BYTES in types.ts).
const MaxInlineBinaryBytes = 64 * 1024

// DefaultBinaryProperty is the usual property name of a single file.
const DefaultBinaryProperty = "data"

// BinaryRef is a file attached to an item (BinaryRef in types.ts, n8n's IBinaryData).
type BinaryRef struct {
	// ID is the store id ("<scope>.<random>"). Empty only on an inline ref a node returns.
	ID       string `json:"id,omitempty"`
	MimeType string `json:"mimeType"`
	FileName string `json:"fileName,omitempty"`
	// FileExtension has no dot: "pdf".
	FileExtension string `json:"fileExtension,omitempty"`
	// FileSize is the size in bytes.
	FileSize int64 `json:"fileSize"`
	// FileType is the coarse kind the UI previews by: image | text | json | html | pdf | audio | video | other.
	FileType string `json:"fileType,omitempty"`
	// Data holds the bytes inline, base64 (only on refs a node returns).
	Data string `json:"data,omitempty"`
}

// BinaryAccess tells a plugin where the host's binary API is for one Execute
// call: GET {URL}/{id} and POST {URL}, each with "Authorization: Bearer {Token}".
type BinaryAccess struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

// BinaryRef returns the file under property name of input item i (main input
// 0). name "" means "data". It fails when the item has no such file.
func (c *ExecuteContext) BinaryRef(i int, name string) (BinaryRef, error) {
	if name == "" {
		name = DefaultBinaryProperty
	}
	items := c.InputData(0)
	if i < 0 || i >= len(items) {
		return BinaryRef{}, fmt.Errorf("there is no input item %d", i)
	}
	ref, ok := items[i].Binary[name]
	if !ok {
		return BinaryRef{}, fmt.Errorf("item %d has no binary file %q", i, name)
	}
	return ref, nil
}

// BinaryBytes returns the bytes of the file under property name of input item i.
func (c *ExecuteContext) BinaryBytes(i int, name string) ([]byte, error) {
	ref, err := c.BinaryRef(i, name)
	if err != nil {
		return nil, err
	}
	return c.ReadBinary(ref)
}

// BinaryReader streams the file under property name of input item i. Close it.
func (c *ExecuteContext) BinaryReader(i int, name string) (io.ReadCloser, error) {
	ref, err := c.BinaryRef(i, name)
	if err != nil {
		return nil, err
	}
	return c.OpenBinary(ref)
}

// ReadBinary returns the bytes of any ref (an input file, or one returned by
// a sub-workflow).
func (c *ExecuteContext) ReadBinary(ref BinaryRef) ([]byte, error) {
	rc, err := c.OpenBinary(ref)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// OpenBinary streams the bytes of any ref: inline data is decoded locally, a
// stored ref is fetched from the host's binary API. Close the reader.
func (c *ExecuteContext) OpenBinary(ref BinaryRef) (io.ReadCloser, error) {
	if ref.Data != "" {
		data, err := base64.StdEncoding.DecodeString(ref.Data)
		if err != nil {
			return nil, fmt.Errorf("binary file %q: inline data is not valid base64: %v", displayName(ref), err)
		}
		return io.NopCloser(bytes.NewReader(data)), nil
	}
	if ref.ID == "" {
		return nil, fmt.Errorf("binary file %q has neither an id nor inline data", displayName(ref))
	}
	access, err := c.binaryAccess()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(c, http.MethodGet, strings.TrimRight(access.URL, "/")+"/"+url.PathEscape(ref.ID), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+access.Token)
	resp, err := HTTPClient(c).Do(req)
	if err != nil {
		return nil, fmt.Errorf("reading binary file %q: %w", displayName(ref), err)
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		return nil, fmt.Errorf("reading binary file %q: host answered %s%s", displayName(ref), resp.Status, hostMessage(resp.Body))
	}
	return resp.Body, nil
}

// PrepareBinary stores data as a file and returns the ref to put under
// Item.Binary[name]. Files up to MaxInlineBinaryBytes are returned inline
// (the host stores them); bigger ones are uploaded. mimeType "" is guessed
// from fileName.
func (c *ExecuteContext) PrepareBinary(data []byte, fileName, mimeType string) (BinaryRef, error) {
	if len(data) <= MaxInlineBinaryBytes {
		ref := completeBinaryRef(BinaryRef{FileName: fileName, MimeType: mimeType, FileSize: int64(len(data))})
		ref.Data = base64.StdEncoding.EncodeToString(data)
		return ref, nil
	}
	if c.req.BinaryAccess == nil || c.req.BinaryAccess.URL == "" {
		return BinaryRef{}, fmt.Errorf("file %q is %d bytes; the host sent no binaryAccess, so only files up to %d bytes can be returned (inline)", fileName, len(data), MaxInlineBinaryBytes)
	}
	return c.PrepareBinaryStream(bytes.NewReader(data), fileName, mimeType)
}

// PrepareBinaryStream uploads the bytes of r to the host's binary store and
// returns the stored ref. mimeType "" is guessed from fileName.
func (c *ExecuteContext) PrepareBinaryStream(r io.Reader, fileName, mimeType string) (BinaryRef, error) {
	access, err := c.binaryAccess()
	if err != nil {
		return BinaryRef{}, err
	}
	meta := completeBinaryRef(BinaryRef{FileName: fileName, MimeType: mimeType})
	req, err := http.NewRequestWithContext(c, http.MethodPost, strings.TrimRight(access.URL, "/"), r)
	if err != nil {
		return BinaryRef{}, err
	}
	req.Header.Set("Authorization", "Bearer "+access.Token)
	req.Header.Set("Content-Type", meta.MimeType)
	if fileName != "" {
		req.Header.Set("X-Landflow-File-Name", url.PathEscape(fileName))
	}
	resp, err := HTTPClient(c).Do(req)
	if err != nil {
		return BinaryRef{}, fmt.Errorf("storing binary file %q: %w", fileName, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return BinaryRef{}, fmt.Errorf("storing binary file %q: host answered %s%s", fileName, resp.Status, hostMessage(resp.Body))
	}
	var ref BinaryRef
	if err := json.NewDecoder(resp.Body).Decode(&ref); err != nil {
		return BinaryRef{}, fmt.Errorf("storing binary file %q: unreadable answer: %v", fileName, err)
	}
	if ref.ID == "" {
		return BinaryRef{}, fmt.Errorf("storing binary file %q: the host returned no id", fileName)
	}
	return ref, nil
}

func (c *ExecuteContext) binaryAccess() (*BinaryAccess, error) {
	if c.req.BinaryAccess == nil || c.req.BinaryAccess.URL == "" {
		return nil, errors.New("the host sent no binaryAccess with this call (it has no binary store, or is too old)")
	}
	return c.req.BinaryAccess, nil
}

func displayName(ref BinaryRef) string {
	if ref.FileName != "" {
		return ref.FileName
	}
	return ref.ID
}

// hostMessage reads a JSON {"error": "..."} body (or plain text) for an error message.
func hostMessage(body io.Reader) string {
	raw, _ := io.ReadAll(io.LimitReader(body, 4096))
	var parsed struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &parsed) == nil && parsed.Error != "" {
		return ": " + parsed.Error
	}
	if text := strings.TrimSpace(string(raw)); text != "" {
		return ": " + text
	}
	return ""
}

// ---------------------------------------------------------------------------
// MIME types (the tables of packages/protocol/src/binary.ts)
// ---------------------------------------------------------------------------

// DefaultMimeType is used when nothing better is known.
const DefaultMimeType = "application/octet-stream"

var mimeByExtension = map[string]string{
	"txt": "text/plain", "text": "text/plain", "log": "text/plain", "md": "text/markdown",
	"csv": "text/csv", "tsv": "text/tab-separated-values", "html": "text/html", "htm": "text/html",
	"css": "text/css", "xml": "application/xml", "json": "application/json", "ndjson": "application/x-ndjson",
	"yaml": "application/yaml", "yml": "application/yaml", "js": "text/javascript",
	"pdf": "application/pdf", "zip": "application/zip", "gz": "application/gzip", "tar": "application/x-tar",
	"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xls": "application/vnd.ms-excel",
	"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"ods":  "application/vnd.oasis.opendocument.spreadsheet", "rtf": "application/rtf",
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
	"svg": "image/svg+xml", "bmp": "image/bmp", "ico": "image/x-icon", "tif": "image/tiff", "tiff": "image/tiff",
	"avif": "image/avif", "heic": "image/heic",
	"mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "m4a": "audio/mp4", "flac": "audio/flac",
	"mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm", "avi": "video/x-msvideo", "mkv": "video/x-matroska",
	"eml": "message/rfc822", "ics": "text/calendar",
}

var extensionByMime = func() map[string]string {
	out := map[string]string{}
	for ext, mime := range mimeByExtension {
		// Deterministic preferred extension: the shortest, then alphabetical.
		if cur, ok := out[mime]; !ok || len(ext) < len(cur) || (len(ext) == len(cur) && ext < cur) {
			out[mime] = ext
		}
	}
	out["text/plain"], out["image/jpeg"], out["text/html"], out["application/yaml"] = "txt", "jpg", "html", "yaml"
	return out
}()

// FileExtensionOf returns the lower-case extension of a file name without the dot ("report.PDF" → "pdf").
func FileExtensionOf(fileName string) string {
	base := path.Base(strings.ReplaceAll(fileName, "\\", "/"))
	dot := strings.LastIndex(base, ".")
	if dot <= 0 || dot == len(base)-1 || base == "." {
		return ""
	}
	return strings.ToLower(base[dot+1:])
}

// MimeTypeFromFileName guesses a MIME type from the extension, else DefaultMimeType.
func MimeTypeFromFileName(fileName string) string {
	if mime, ok := mimeByExtension[FileExtensionOf(fileName)]; ok {
		return mime
	}
	return DefaultMimeType
}

func baseMime(mimeType string) string {
	return strings.ToLower(strings.TrimSpace(strings.SplitN(mimeType, ";", 2)[0]))
}

// FileTypeOf maps a MIME type to the coarse kind the UI previews by.
func FileTypeOf(mimeType string) string {
	mime := baseMime(mimeType)
	switch {
	case strings.HasPrefix(mime, "image/"):
		return "image"
	case strings.HasPrefix(mime, "audio/"):
		return "audio"
	case strings.HasPrefix(mime, "video/"):
		return "video"
	case mime == "application/pdf":
		return "pdf"
	case mime == "text/html":
		return "html"
	case mime == "application/json" || strings.HasSuffix(mime, "+json") || mime == "application/x-ndjson":
		return "json"
	case strings.HasPrefix(mime, "text/") || mime == "application/xml" || mime == "application/yaml" || mime == "application/javascript" || strings.HasSuffix(mime, "+xml"):
		return "text"
	}
	return "other"
}

// completeBinaryRef fills what a ref can derive: the MIME type from the file
// name, the extension from either, and the file type.
func completeBinaryRef(ref BinaryRef) BinaryRef {
	if ref.MimeType == "" || ref.MimeType == DefaultMimeType {
		if ref.FileName != "" {
			ref.MimeType = MimeTypeFromFileName(ref.FileName)
		} else if ref.MimeType == "" {
			ref.MimeType = DefaultMimeType
		}
	}
	if ref.FileExtension == "" {
		ref.FileExtension = FileExtensionOf(ref.FileName)
		if ref.FileExtension == "" {
			ref.FileExtension = extensionByMime[baseMime(ref.MimeType)]
		}
	}
	if ref.FileType == "" {
		ref.FileType = FileTypeOf(ref.MimeType)
	}
	return ref
}
