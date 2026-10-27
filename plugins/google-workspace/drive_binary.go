package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Drive files as binary data: uploads read the input item's binary file,
// downloads and exports store the bytes in the host's binary store and put
// the ref under the item's binary data.

// exportMimeByFormat maps an export format (an extension) to the MIME type Google converts to.
var exportMimeByFormat = map[string]string{
	"pdf": "application/pdf", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"odt": "application/vnd.oasis.opendocument.text", "rtf": "application/rtf", "txt": "text/plain",
	"html": "application/zip", "epub": "application/epub+zip", "md": "text/markdown",
	"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"ods":  "application/vnd.oasis.opendocument.spreadsheet", "csv": "text/csv", "tsv": "text/tab-separated-values",
	"pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"odp":  "application/vnd.oasis.opendocument.presentation",
	"png":  "image/png", "jpg": "image/jpeg", "svg": "image/svg+xml",
}

// exportFileExtension is the extension of an exported file (html exports are zip archives).
func exportFileExtension(format string) string {
	if format == "html" {
		return "zip"
	}
	return format
}

func exportOptions(formats ...string) []landflow.PropertyOption {
	names := map[string]string{
		"pdf": "PDF", "docx": "Word (.docx)", "odt": "OpenDocument Text (.odt)", "rtf": "Rich Text (.rtf)", "txt": "Plain Text (.txt)",
		"html": "HTML (zipped)", "epub": "EPUB", "md": "Markdown", "xlsx": "Excel (.xlsx)", "ods": "OpenDocument Spreadsheet (.ods)",
		"csv": "CSV (first sheet)", "tsv": "TSV (first sheet)", "pptx": "PowerPoint (.pptx)", "odp": "OpenDocument Presentation (.odp)",
		"png": "PNG", "jpg": "JPEG", "svg": "SVG",
	}
	out := make([]landflow.PropertyOption, len(formats))
	for k, f := range formats {
		out[k] = landflow.PropertyOption{Name: names[f], Value: f}
	}
	return out
}

// exportFormatOptions is the Drive node's list (every Google file type).
var exportFormatOptions = exportOptions("pdf", "docx", "odt", "rtf", "txt", "html", "epub", "md", "xlsx", "ods", "csv", "tsv", "pptx", "odp", "png", "jpg", "svg")

// storeBinary stores the bytes of r as a file: small ones go back inline,
// bigger ones are streamed to the host's binary store.
func storeBinary(ctx *landflow.ExecuteContext, r io.Reader, fileName, mimeType string) (landflow.BinaryRef, error) {
	head, err := io.ReadAll(io.LimitReader(r, landflow.MaxInlineBinaryBytes+1))
	if err != nil {
		return landflow.BinaryRef{}, err
	}
	if len(head) <= landflow.MaxInlineBinaryBytes {
		return ctx.PrepareBinary(head, fileName, mimeType)
	}
	return ctx.PrepareBinaryStream(io.MultiReader(bytes.NewReader(head), r), fileName, mimeType)
}

// emitFile appends an item with the file under its binary data.
func emitFile(out []landflow.Item, i int, result map[string]any, property string, ref landflow.BinaryRef) []landflow.Item {
	return append(out, landflow.Item{JSON: result, Binary: map[string]landflow.BinaryRef{property: ref}, PairedItem: &landflow.PairedItem{Item: i}})
}

// uploadBinary uploads the input item's binary file: files up to 5 MB in one
// multipart request, bigger ones streamed through a resumable session.
func (d *driveRun) uploadBinary(i int) (map[string]any, error) {
	prop := d.ctx.ParamString("binaryPropertyName", i, landflow.DefaultBinaryProperty)
	ref, err := d.ctx.BinaryRef(i, prop)
	if err != nil {
		return nil, userError("Input Binary Field names a binary property of the input item; check the previous node's Binary output.", "%v", err)
	}
	name := strings.TrimSpace(d.ctx.ParamString("name", i, ""))
	if name == "" {
		if name = ref.FileName; name == "" {
			name = prop
			if ref.FileExtension != "" {
				name += "." + ref.FileExtension
			}
		}
	}
	mimeType := strings.TrimSpace(getString(asMap(d.ctx.Param("options", i)), "mimeType", ""))
	if mimeType == "" {
		mimeType = ref.MimeType
	}
	if mimeType == "" {
		mimeType = landflow.DefaultMimeType
	}
	meta := map[string]any{"name": name, "mimeType": mimeType}
	if folder := idFrom(d.ctx.ParamString("folderId", i, "root"), driveURLPattern); folder != "" {
		meta["parents"] = []string{folder}
	}
	rc, err := d.ctx.OpenBinary(ref)
	if err != nil {
		return nil, userError("The host's binary store could not be read.", "File %q: %v", name, err)
	}
	defer rc.Close()
	var file map[string]any
	if ref.FileSize <= maxUpload {
		content, err := io.ReadAll(rc)
		if err != nil {
			return nil, userError("The host's binary store could not be read.", "File %q: %v", name, err)
		}
		body, contentType, err := multipartRelated(meta, mimeType, content)
		if err != nil {
			return nil, err
		}
		query := url.Values{"uploadType": {"multipart"}, "supportsAllDrives": {"true"}, "fields": {driveFileFields}}
		err = d.c.send(d.ctx, apiDrive, func() (*http.Request, error) {
			req, err := http.NewRequestWithContext(d.ctx, http.MethodPost, d.c.url(apiDrive, "/upload/drive/v3/files", query), bytes.NewReader(body))
			if err == nil {
				req.Header.Set("Content-Type", contentType)
			}
			return req, err
		}, func(resp *http.Response) error { return json.NewDecoder(resp.Body).Decode(&file) })
		return file, err
	}
	return d.resumableUpload(meta, mimeType, rc, ref.FileSize)
}

// resumableUpload starts a resumable session with the metadata, then sends
// the content in one streamed PUT.
func (d *driveRun) resumableUpload(meta map[string]any, mimeType string, content io.Reader, size int64) (map[string]any, error) {
	query := url.Values{"uploadType": {"resumable"}, "supportsAllDrives": {"true"}, "fields": {driveFileFields}}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return nil, err
	}
	var session string
	err = d.c.send(d.ctx, apiDrive, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(d.ctx, http.MethodPost, d.c.url(apiDrive, "/upload/drive/v3/files", query), bytes.NewReader(metaJSON))
		if err == nil {
			req.Header.Set("Content-Type", "application/json; charset=UTF-8")
			req.Header.Set("X-Upload-Content-Type", mimeType)
			req.Header.Set("X-Upload-Content-Length", strconv.FormatInt(size, 10))
		}
		return req, err
	}, func(resp *http.Response) error {
		session = resp.Header.Get("Location")
		return nil
	})
	if err != nil {
		return nil, err
	}
	if session == "" {
		return nil, userError("Try again; Google did not start the upload session.", "Google Drive returned no resumable upload URL")
	}
	var file map[string]any
	err = d.c.send(d.ctx, apiDrive, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(d.ctx, http.MethodPut, session, io.NopCloser(content))
		if err == nil {
			req.ContentLength = size
			req.Header.Set("Content-Type", mimeType)
		}
		return req, err
	}, func(resp *http.Response) error { return json.NewDecoder(resp.Body).Decode(&file) })
	return file, err
}

// driveFileMeta reads the fields a download or export needs.
type driveFileMeta struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Size     string `json:"size"`
}

func (d *driveRun) fileMeta(id string) (driveFileMeta, error) {
	var meta driveFileMeta
	err := d.c.do(d.ctx, apiDrive, http.MethodGet, "/drive/v3/files/"+url.PathEscape(id),
		url.Values{"fields": {"id,name,mimeType,size"}, "supportsAllDrives": {"true"}}, nil, &meta)
	return meta, err
}

// fetchToBinary GETs contentPath and stores the response as a file.
func (d *driveRun) fetchToBinary(contentPath string, query url.Values, fileName, mimeType string) (landflow.BinaryRef, error) {
	var ref landflow.BinaryRef
	err := d.c.send(d.ctx, apiDrive, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(d.ctx, http.MethodGet, d.c.url(apiDrive, contentPath, query), nil)
		if err == nil {
			req.Header.Set("Accept", "*/*")
		}
		return req, err
	}, func(resp *http.Response) error {
		var err error
		ref, err = storeBinary(d.ctx, resp.Body, fileName, mimeType)
		return err
	})
	return ref, err
}

// downloadBinary stores a file's content as binary data on the output item.
// Google files are exported to their text form (Export has the other formats).
func (d *driveRun) downloadBinary(i int, out *[]landflow.Item) error {
	raw, err := requireParam(d.ctx, "fileId", "File ID", i)
	if err != nil {
		return err
	}
	id := idFrom(raw, driveURLPattern)
	meta, err := d.fileMeta(id)
	if err != nil {
		return err
	}
	filePath := "/drive/v3/files/" + url.PathEscape(id)
	contentType, contentPath, query := meta.MimeType, filePath, url.Values{"alt": {"media"}, "supportsAllDrives": {"true"}}
	fileName := meta.Name
	if strings.HasPrefix(meta.MimeType, "application/vnd.google-apps.") {
		export, ok := exportFormats[meta.MimeType]
		if !ok {
			return userError("Docs, Sheets, Slides and Drawings can be downloaded (exported); folders and other Google types cannot.",
				"Cannot download a file of type %s", meta.MimeType)
		}
		contentType, contentPath, query = export, filePath+"/export", url.Values{"mimeType": {export}}
		if landflow.FileExtensionOf(fileName) == "" {
			fileName += "." + map[string]string{"text/plain": "txt", "text/csv": "csv", "image/png": "png"}[export]
		}
	}
	ref, err := d.fetchToBinary(contentPath, query, fileName, contentType)
	if err != nil {
		return err
	}
	prop := d.ctx.ParamString("outputBinaryField", i, landflow.DefaultBinaryProperty)
	*out = emitFile(*out, i, map[string]any{"id": meta.ID, "name": meta.Name, "mimeType": contentType, "size": ref.FileSize}, prop, ref)
	return nil
}

// exportBinary converts a Google file to the chosen format and stores it as binary data.
func (d *driveRun) exportBinary(i int, out *[]landflow.Item) error {
	raw, err := requireParam(d.ctx, "fileId", "File ID", i)
	if err != nil {
		return err
	}
	return d.exportFile(i, idFrom(raw, driveURLPattern), d.ctx.ParamString("exportFormat", i, "pdf"), out)
}

// exportFile is shared by the Drive, Sheets and Docs nodes.
func (d *driveRun) exportFile(i int, id, format string, out *[]landflow.Item) error {
	mimeType, ok := exportMimeByFormat[format]
	if !ok {
		return userError("Pick one of the formats in the Export As list.", "Unknown export format %q", format)
	}
	meta, err := d.fileMeta(id)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(meta.MimeType, "application/vnd.google-apps.") || meta.MimeType == mimeFolder {
		return userError("Export converts Google Docs, Sheets, Slides and Drawings; use Download for other files.",
			"Cannot export a file of type %s", meta.MimeType)
	}
	fileName := strings.TrimSpace(getString(asMap(d.ctx.Param("options", i)), "fileName", ""))
	if fileName == "" {
		fileName = strings.TrimSuffix(meta.Name, path.Ext(meta.Name))
		if fileName == "" {
			fileName = meta.ID
		}
		fileName += "." + exportFileExtension(format)
	}
	ref, err := d.fetchToBinary("/drive/v3/files/"+url.PathEscape(id)+"/export", url.Values{"mimeType": {mimeType}}, fileName, mimeType)
	if err != nil {
		return err
	}
	prop := d.ctx.ParamString("outputBinaryField", i, landflow.DefaultBinaryProperty)
	*out = emitFile(*out, i, map[string]any{"id": meta.ID, "name": fileName, "mimeType": mimeType, "size": ref.FileSize, "sourceName": meta.Name}, prop, ref)
	return nil
}
