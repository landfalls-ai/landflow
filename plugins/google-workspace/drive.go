package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path"
	"strconv"
	"strings"
	"unicode/utf8"

	landflow "github.com/landflow/landflow/sdks/go"
)

// DriveNode is Google Drive: search files and folders, upload, download,
// export and delete files, and create folders. Files move as binary data
// (drive_binary.go); a download can also return the content as text or base64.
type DriveNode struct{}

const (
	mimeFolder   = "application/vnd.google-apps.folder"
	mimeDocument = "application/vnd.google-apps.document"
	// driveFileFields are the file fields every operation returns.
	driveFileFields = "id,name,mimeType,parents,size,createdTime,modifiedTime,webViewLink,trashed"
	// maxDownload caps downloads that travel inside JSON (binary downloads have no cap).
	maxDownload = 10 << 20
	// maxUpload is the limit of Drive's multipart upload.
	maxUpload = 5 << 20
)

// exportFormats converts Google files on download.
var exportFormats = map[string]string{
	mimeDocument:    "text/plain",
	mimeSpreadsheet: "text/csv",
	"application/vnd.google-apps.presentation": "text/plain",
	"application/vnd.google-apps.drawing":      "image/png",
}

var driveFileTypes = []landflow.PropertyOption{
	{Name: "Google Docs", Value: mimeDocument},
	{Name: "Google Sheets", Value: mimeSpreadsheet},
	{Name: "Google Slides", Value: "application/vnd.google-apps.presentation"},
	{Name: "Folder", Value: mimeFolder},
	{Name: "PDF", Value: "application/pdf"},
	{Name: "Plain Text", Value: "text/plain"},
	{Name: "CSV", Value: "text/csv"},
	{Name: "JSON", Value: "application/json"},
	{Name: "PNG Image", Value: "image/png"},
	{Name: "JPEG Image", Value: "image/jpeg"},
}

// folderProperty is a parent-folder picker ("root" is My Drive).
func folderProperty(name, displayName, description string, d *landflow.DisplayOptions) landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: name, DisplayName: displayName, Type: landflow.PropOptions, Default: "root",
		Description: description,
		Options:     []landflow.PropertyOption{{Name: "My Drive (root)", Value: "root"}},
		TypeOptions: &landflow.TypeOptions{LoadOptionsMethod: "folders"}, DisplayOptions: d,
	}
}

func (DriveNode) Description() landflow.NodeDescriptor {
	search := show("fileFolder", "search")
	paging := returnAllLimit(search, 50, 1000)
	changed := show("file", "changesSince")
	changedPaging := returnAllLimit(changed, 50, 1000)
	return landflow.NodeDescriptor{
		Name:             "googleDrive",
		DisplayName:      "Google Drive",
		Description:      "Search, upload, download and delete Google Drive files",
		Version:          landflow.V(1),
		Kind:             landflow.KindAction,
		Categories:       []string{"Data & Storage"},
		Icon:             "file:icons/drive.svg",
		Color:            "#1FA463",
		Subtitle:         "{{operation}}: {{resource}}",
		Inputs:           []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		DocumentationURL: "https://developers.google.com/workspace/drive/api/reference/rest/v3",
		Keywords:         []string{"files", "folder", "upload", "download", "storage", "documents"},
		Credentials:      credentialRequirements(),

		UsableAsTool: true,
		ToolDescription: "Work with Google Drive files. resource=fileFolder, operation=search finds files by name " +
			"(queryString) or Drive query syntax; resource=file: upload creates a file from fileContent text, " +
			"download returns `content` (text, or base64 for binary files, max 10 MB) or, with downloadAs=binary, the file as the item's binary data; " +
			"export converts a Google Doc/Sheet/Slides to a binary file (exportFormat pdf, docx, xlsx…); upload with uploadFrom=binary " +
			"sends the input item's binary file; deleteFile trashes fileId; getItem returns a file as an activity item with its text; " +
			"changesSince lists files changed after `since` (an ISO time or a cursor) as activity items; " +
			"resource=folder, operation=create makes a folder.",

		Properties: []landflow.PropertyDescriptor{
			authProperty(),
			resourceProperty("file",
				landflow.PropertyOption{Name: "File", Value: "file"},
				landflow.PropertyOption{Name: "File/Folder", Value: "fileFolder"},
				landflow.PropertyOption{Name: "Folder", Value: "folder"},
			),
			operationProperty("file", "upload",
				landflow.PropertyOption{Name: "Delete", Value: "deleteFile", Description: "Move a file to the trash, or delete it permanently", Action: "Delete a file"},
				landflow.PropertyOption{Name: "Download", Value: "download", Description: "Download a file's content as text or as a binary file", Action: "Download a file", Idempotent: true},
				landflow.PropertyOption{Name: "Export", Value: "export", Description: "Export a Google Doc, Sheet, Slides or Drawing as a file (PDF, Word, Excel…)", Action: "Export a Google file", Idempotent: true},
				landflow.PropertyOption{Name: "Get Item", Value: "getItem", Description: "One file as an activity item, with the full text of a Google Doc or text file", Action: "Get a file as an activity item", Idempotent: true,
					OutputSchema: activityWithTextSchema("The full text of a Google Doc or a text file (up to 10 MB); empty for other files")},
				landflow.PropertyOption{Name: "Get Many Changed Since", Value: "changesSince", Description: "Files changed after a time or a cursor, as activity items (oldest first)", Action: "Get files changed since", Idempotent: true,
					OutputSchema: landflow.ActivityItemSchema()},
				landflow.PropertyOption{Name: "Upload", Value: "upload", Description: "Upload a file", Action: "Upload a file"},
			),
			operationProperty("fileFolder", "search",
				landflow.PropertyOption{Name: "Search", Value: "search", Description: "Search files and folders", Action: "Search files and folders", Idempotent: true},
			),
			operationProperty("folder", "create",
				landflow.PropertyOption{Name: "Create", Value: "create", Description: "Create a folder", Action: "Create a folder"},
			),

			// File → Upload
			{Name: "name", DisplayName: "File Name", Type: landflow.PropString, Default: "",
				Placeholder: "report.txt", Description: "Required unless the content comes from a binary file (it then defaults to that file's name)",
				DisplayOptions: show("file", "upload")},
			folderProperty("folderId", "Parent Folder", "Folder to upload into", show("file", "upload")),
			{Name: "uploadFrom", DisplayName: "Content From", Type: landflow.PropOptions, Default: "text",
				Options: []landflow.PropertyOption{
					{Name: "Binary File", Value: "binary", Description: "A file of the input item (Read Files, HTTP Request, a form upload, Convert to File…); big files are streamed"},
					{Name: "Text", Value: "text", Description: "The text below becomes the file"},
					{Name: "Base64", Value: "base64", Description: "Base64-encoded bytes, e.g. from a download"},
				},
				DisplayOptions: show("file", "upload")},
			{Name: "binaryPropertyName", DisplayName: "Input Binary Field", Type: landflow.PropString, Default: "data",
				Description:    "Name of the input item's binary property that holds the file",
				DisplayOptions: with(show("file", "upload"), "uploadFrom", "binary")},
			{Name: "fileContent", DisplayName: "File Content", Type: landflow.PropString, Default: "",
				TypeOptions:    &landflow.TypeOptions{Rows: landflow.Ptr(6)},
				DisplayOptions: with(show("file", "upload"), "uploadFrom", "text")},
			{Name: "base64Content", DisplayName: "Base64 Content", Type: landflow.PropString, Default: "",
				Placeholder: "{{ $json.content }}", Description: "Base64 (or a data: URL) of the file's bytes",
				DisplayOptions: with(show("file", "upload"), "uploadFrom", "base64")},
			{Name: "options", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{},
				Placeholder: "Add Option", DisplayOptions: show("file", "upload"),
				Values: []landflow.PropertyDescriptor{
					{Name: "mimeType", DisplayName: "MIME Type", Type: landflow.PropString, Default: "",
						Placeholder: "text/csv", Description: "Defaults to a guess from the file name"},
				}},

			// File → Download / Delete
			{Name: "fileId", DisplayName: "File ID", Type: landflow.PropString, Default: "", Required: true,
				Description: "ID or link of the file", DisplayOptions: show("file", "download", "deleteFile", "export", "getItem")},

			// File → Get Many Changed Since, Get Item
			{Name: "since", DisplayName: "Since", Type: landflow.PropString, Default: "",
				Placeholder: "2026-11-12T08:00:00Z", DisplayOptions: changed,
				Description: "Files changed after this ISO time, or after a cursor from an earlier item (a changes-feed page token). Empty: the last 24 hours."},
			{Name: "sharedDrives", DisplayName: "Include Shared Drives", Type: landflow.PropBoolean, Default: true, DisplayOptions: changed,
				Description: "Whether files in shared drives the account is a member of are included"},
			changedPaging[0],
			changedPaging[1],
			driveActivityOptions(show("file", "changesSince", "getItem")),
			{Name: "downloadAs", DisplayName: "Return Content As", Type: landflow.PropOptions, Default: "json",
				Options: []landflow.PropertyOption{
					{Name: "Text or Base64 (in the JSON)", Value: "json", Description: "`content` in the item, up to 10 MB"},
					{Name: "Binary File", Value: "binary", Description: "The file under the item's binary data, streamed to the host's store (no size limit)"},
				},
				DisplayOptions: show("file", "download")},
			{Name: "exportFormat", DisplayName: "Export As", Type: landflow.PropOptions, Default: "pdf",
				Options: exportFormatOptions, DisplayOptions: show("file", "export")},
			{Name: "outputBinaryField", DisplayName: "Output Binary Field", Type: landflow.PropString, Default: "data",
				Description:    "Name of the binary property that gets the file",
				DisplayOptions: &landflow.DisplayOptions{Show: map[string][]any{"resource": {"file"}, "operation": {"download", "export"}}}},
			{Name: "options", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{},
				Placeholder: "Add Option", DisplayOptions: show("file", "export"),
				Values: []landflow.PropertyDescriptor{
					{Name: "fileName", DisplayName: "File Name", Type: landflow.PropString, Default: "",
						Description: "Defaults to the Google file's name plus the format's extension"},
				}},
			{Name: "options", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{},
				Placeholder: "Add Option", DisplayOptions: show("file", "deleteFile"),
				Values: []landflow.PropertyDescriptor{
					{Name: "deletePermanently", DisplayName: "Delete Permanently", Type: landflow.PropBoolean, Default: false,
						Description: "Whether to delete the file immediately instead of moving it to the trash"},
				}},

			// File/Folder → Search
			{Name: "searchMethod", DisplayName: "Search Method", Type: landflow.PropOptions, Default: "name",
				Options: []landflow.PropertyOption{
					{Name: "Search File/Folder Name", Value: "name", Description: "Names containing the text"},
					{Name: "Advanced Search", Value: "query", Description: "A Drive query (name contains 'x' and …)"},
				},
				DisplayOptions: search},
			{Name: "queryString", DisplayName: "Search Query", Type: landflow.PropString, Default: "",
				Description: "Text the name contains, or a Drive query for Advanced Search", DisplayOptions: search},
			paging[0],
			paging[1],
			{Name: "filter", DisplayName: "Filter", Type: landflow.PropCollection, Default: map[string]any{},
				Placeholder: "Add Filter", DisplayOptions: search,
				Values: []landflow.PropertyDescriptor{
					folderProperty("folderId", "Folder", "Only items directly in this folder", nil),
					{Name: "whatToSearch", DisplayName: "What to Search", Type: landflow.PropOptions, Default: "all",
						Options: []landflow.PropertyOption{
							{Name: "Files and Folders", Value: "all"},
							{Name: "Files", Value: "files"},
							{Name: "Folders", Value: "folders"},
						}},
					{Name: "fileTypes", DisplayName: "File Types", Type: landflow.PropMultiOptions, Default: []any{},
						Options: driveFileTypes},
					{Name: "includeTrashed", DisplayName: "Include Trashed Items", Type: landflow.PropBoolean, Default: false},
				}},

			// Folder → Create
			{Name: "name", DisplayName: "Folder Name", Type: landflow.PropString, Default: "", Required: true,
				DisplayOptions: show("folder", "create")},
			folderProperty("folderId", "Parent Folder", "Folder to create it in", show("folder", "create")),
		},
	}
}

func (DriveNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	items := ctx.InputData(0)
	if len(items) == 0 {
		return nil, nil
	}
	c, err := newClient(ctx, ctx.ParamString("authentication", 0, "serviceAccount"))
	if err != nil {
		return nil, err
	}
	d := &driveRun{ctx: ctx, c: c}
	var out []landflow.Item
	for i := range items {
		resource := ctx.ParamString("resource", i, "file")
		operation := ctx.ParamString("operation", i, "upload")
		var results []map[string]any
		switch resource + "." + operation {
		case "fileFolder.search":
			results, err = d.search(i)
		case "file.upload":
			results, err = one(d.upload(i))
		case "file.download":
			if ctx.ParamString("downloadAs", i, "json") == "binary" {
				err = d.downloadBinary(i, &out)
			} else {
				results, err = one(d.download(i))
			}
		case "file.export":
			err = d.exportBinary(i, &out)
		case "file.changesSince":
			results, err = d.changesSince(i)
		case "file.getItem":
			results, err = one(d.getItem(i))
		case "file.deleteFile":
			results, err = one(d.delete(i))
		case "folder.create":
			results, err = one(d.createFolder(i))
		default:
			err = userError("Pick an operation listed for the resource.", "Unsupported operation %q for resource %q", operation, resource)
		}
		if err != nil {
			if ctx.ContinueOnFail() {
				out = append(out, ctx.ErrorItem(i, itemError(i, err)))
				continue
			}
			return nil, itemError(i, err)
		}
		out = emit(out, i, results...)
	}
	return [][]landflow.Item{out}, nil
}

type driveRun struct {
	ctx *landflow.ExecuteContext
	c   *client
}

type driveFileList struct {
	Files         []map[string]any `json:"files"`
	NextPageToken string           `json:"nextPageToken"`
}

// search lists files matching the query and filters.
func (d *driveRun) search(i int) ([]map[string]any, error) {
	filter := asMap(d.ctx.Param("filter", i))
	q := driveQuery(d.ctx.ParamString("searchMethod", i, "name"), d.ctx.ParamString("queryString", i, ""), filter)
	var files []map[string]any
	err := paginate(d.ctx, "google.drive.files.list", limitFor(d.ctx, i, 50), func(ctx context.Context, token string, remaining int) (int, string, error) {
		page, err := listDriveFiles(ctx, d.c, q, "nextPageToken,files("+driveFileFields+")", "", token, pageSize(remaining, 1000))
		if err != nil {
			return 0, "", err
		}
		if remaining >= 0 && len(page.Files) > remaining {
			page.Files = page.Files[:remaining]
		}
		files = append(files, page.Files...)
		return len(page.Files), page.NextPageToken, nil
	})
	return files, err
}

// driveQuery builds the files.list q parameter.
func driveQuery(method, text string, filter map[string]any) string {
	var clauses []string
	if text = strings.TrimSpace(text); text != "" {
		if method == "query" {
			clauses = append(clauses, "("+text+")")
		} else {
			clauses = append(clauses, "name contains "+driveString(text))
		}
	}
	if folder := strings.TrimSpace(getString(filter, "folderId", "")); folder != "" {
		clauses = append(clauses, driveString(idFrom(folder, driveURLPattern))+" in parents")
	}
	switch getString(filter, "whatToSearch", "all") {
	case "files":
		clauses = append(clauses, "mimeType != '"+mimeFolder+"'")
	case "folders":
		clauses = append(clauses, "mimeType = '"+mimeFolder+"'")
	}
	if types := stringList(filter["fileTypes"]); len(types) > 0 {
		alts := make([]string, len(types))
		for k, t := range types {
			alts[k] = "mimeType = " + driveString(t)
		}
		clauses = append(clauses, "("+strings.Join(alts, " or ")+")")
	}
	if !getBool(filter, "includeTrashed", false) {
		clauses = append(clauses, "trashed = false")
	}
	return strings.Join(clauses, " and ")
}

// driveString quotes a value for a Drive query.
func driveString(s string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s) + "'"
}

// listDriveFiles fetches one files.list page.
func listDriveFiles(ctx context.Context, c *client, q, fields, orderBy, token string, size int) (driveFileList, error) {
	query := url.Values{
		"q":                         {q},
		"pageSize":                  {strconv.Itoa(size)},
		"supportsAllDrives":         {"true"},
		"includeItemsFromAllDrives": {"true"},
	}
	query.Set("fields", fields)
	if orderBy != "" {
		query.Set("orderBy", orderBy)
	}
	if token != "" {
		query.Set("pageToken", token)
	}
	var page driveFileList
	err := c.do(ctx, apiDrive, http.MethodGet, "/drive/v3/files", query, nil, &page)
	return page, err
}

// upload creates a file with a multipart (metadata + content) upload.
func (d *driveRun) upload(i int) (map[string]any, error) {
	if d.ctx.ParamString("uploadFrom", i, "text") == "binary" {
		return d.uploadBinary(i)
	}
	name, err := requireParam(d.ctx, "name", "File Name", i)
	if err != nil {
		return nil, err
	}
	var content []byte
	switch from := d.ctx.ParamString("uploadFrom", i, "text"); from {
	case "text":
		content = []byte(d.ctx.ParamString("fileContent", i, ""))
	case "base64":
		if content, err = decodeBase64(d.ctx.ParamString("base64Content", i, "")); err != nil {
			return nil, userError("Give standard or URL-safe base64, or a data: URL.", "Base64 Content is not valid base64")
		}
	default:
		return nil, userError("Use text or base64.", "Unknown content source %q", from)
	}
	if len(content) > maxUpload {
		return nil, userError("Multipart uploads are limited to 5 MB.", "The file is %d bytes, more than 5 MB", len(content))
	}
	mimeType := strings.TrimSpace(getString(asMap(d.ctx.Param("options", i)), "mimeType", ""))
	if mimeType == "" {
		mimeType = mime.TypeByExtension(path.Ext(name))
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
		if utf8.Valid(content) {
			mimeType = "text/plain; charset=utf-8"
		}
	}
	meta := map[string]any{"name": name, "mimeType": mimeType}
	if folder := idFrom(d.ctx.ParamString("folderId", i, "root"), driveURLPattern); folder != "" {
		meta["parents"] = []string{folder}
	}
	body, contentType, err := multipartRelated(meta, mimeType, content)
	if err != nil {
		return nil, err
	}
	query := url.Values{"uploadType": {"multipart"}, "supportsAllDrives": {"true"}, "fields": {driveFileFields}}
	var file map[string]any
	err = d.c.send(d.ctx, apiDrive, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(d.ctx, http.MethodPost, d.c.url(apiDrive, "/upload/drive/v3/files", query), bytes.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", contentType)
		}
		return req, err
	}, func(resp *http.Response) error { return json.NewDecoder(resp.Body).Decode(&file) })
	return file, err
}

// multipartRelated builds the multipart/related body of a Drive upload.
func multipartRelated(meta map[string]any, mimeType string, content []byte) ([]byte, string, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return nil, "", err
	}
	part, err := w.CreatePart(textproto.MIMEHeader{"Content-Type": {"application/json; charset=UTF-8"}})
	if err != nil {
		return nil, "", err
	}
	part.Write(metaJSON)
	if part, err = w.CreatePart(textproto.MIMEHeader{"Content-Type": {mimeType}}); err != nil {
		return nil, "", err
	}
	part.Write(content)
	if err := w.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), "multipart/related; boundary=" + w.Boundary(), nil
}

// decodeBase64 accepts standard or URL-safe base64, with or without padding
// and whitespace, and data: URLs.
func decodeBase64(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "data:") {
		if k := strings.Index(s, ","); k >= 0 {
			s = s[k+1:]
		}
	}
	s = strings.TrimRight(strings.Join(strings.Fields(s), ""), "=")
	if b, err := base64.RawStdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawURLEncoding.DecodeString(s)
}

// download returns a file's content (Google files are exported).
func (d *driveRun) download(i int) (map[string]any, error) {
	raw, err := requireParam(d.ctx, "fileId", "File ID", i)
	if err != nil {
		return nil, err
	}
	id := idFrom(raw, driveURLPattern)
	var meta struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		MimeType string `json:"mimeType"`
		Size     string `json:"size"`
	}
	filePath := "/drive/v3/files/" + url.PathEscape(id)
	if err := d.c.do(d.ctx, apiDrive, http.MethodGet, filePath, url.Values{"fields": {"id,name,mimeType,size"}, "supportsAllDrives": {"true"}}, nil, &meta); err != nil {
		return nil, err
	}
	contentType := meta.MimeType
	contentPath, query := filePath, url.Values{"alt": {"media"}, "supportsAllDrives": {"true"}}
	if strings.HasPrefix(meta.MimeType, "application/vnd.google-apps.") {
		export, ok := exportFormats[meta.MimeType]
		if !ok {
			return nil, userError("Docs, Sheets, Slides and Drawings can be downloaded (exported); folders and other Google types cannot.",
				"Cannot download a file of type %s", meta.MimeType)
		}
		contentType, contentPath, query = export, filePath+"/export", url.Values{"mimeType": {export}}
	} else if size, _ := strconv.ParseInt(meta.Size, 10, 64); size > maxDownload {
		return nil, tooLarge(meta.Name, size)
	}
	var content []byte
	err = d.c.send(d.ctx, apiDrive, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(d.ctx, http.MethodGet, d.c.url(apiDrive, contentPath, query), nil)
		if err == nil {
			req.Header.Set("Accept", "*/*")
		}
		return req, err
	}, func(resp *http.Response) error {
		var err error
		content, err = io.ReadAll(io.LimitReader(resp.Body, maxDownload+1))
		return err
	})
	if err != nil {
		return nil, err
	}
	if len(content) > maxDownload {
		return nil, tooLarge(meta.Name, int64(len(content)))
	}
	out := map[string]any{"id": meta.ID, "name": meta.Name, "mimeType": contentType, "size": len(content)}
	if isTextual(contentType) && utf8.Valid(content) {
		out["encoding"], out["content"] = "utf8", string(content)
	} else {
		out["encoding"], out["content"] = "base64", base64.StdEncoding.EncodeToString(content)
	}
	return out, nil
}

func tooLarge(name string, size int64) error {
	return userError("Downloads returned inside the item's JSON are limited to 10 MB; set Return Content As to Binary File for bigger files.",
		"File %q is %d bytes, more than the 10 MB download limit", name, size)
}

// isTextual reports MIME types whose content is returned as text.
func isTextual(mimeType string) bool {
	mt, _, err := mime.ParseMediaType(mimeType)
	if err != nil {
		mt = strings.ToLower(mimeType)
	}
	switch {
	case strings.HasPrefix(mt, "text/"), strings.HasSuffix(mt, "+json"), strings.HasSuffix(mt, "+xml"):
		return true
	}
	switch mt {
	case "application/json", "application/xml", "application/javascript", "application/x-yaml",
		"application/yaml", "application/sql", "application/x-sh", "application/csv":
		return true
	}
	return false
}

// delete moves a file to the trash, or deletes it permanently.
func (d *driveRun) delete(i int) (map[string]any, error) {
	raw, err := requireParam(d.ctx, "fileId", "File ID", i)
	if err != nil {
		return nil, err
	}
	id := idFrom(raw, driveURLPattern)
	filePath := "/drive/v3/files/" + url.PathEscape(id)
	query := url.Values{"supportsAllDrives": {"true"}}
	permanent := getBool(asMap(d.ctx.Param("options", i)), "deletePermanently", false)
	if permanent {
		err = d.c.do(d.ctx, apiDrive, http.MethodDelete, filePath, query, nil, nil)
	} else {
		query.Set("fields", "id,trashed")
		err = d.c.do(d.ctx, apiDrive, http.MethodPatch, filePath, query, map[string]any{"trashed": true}, nil)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "success": true, "deletedPermanently": permanent}, nil
}

// createFolder creates a folder in the parent folder.
func (d *driveRun) createFolder(i int) (map[string]any, error) {
	name, err := requireParam(d.ctx, "name", "Folder Name", i)
	if err != nil {
		return nil, err
	}
	meta := map[string]any{"name": name, "mimeType": mimeFolder}
	if parent := idFrom(d.ctx.ParamString("folderId", i, "root"), driveURLPattern); parent != "" {
		meta["parents"] = []string{parent}
	}
	var file map[string]any
	query := url.Values{"supportsAllDrives": {"true"}, "fields": {driveFileFields}}
	err = d.c.do(d.ctx, apiDrive, http.MethodPost, "/drive/v3/files", query, meta, &file)
	return file, err
}

// driveFileOptions lists Drive files for a picker (up to 1000).
func driveFileOptions(ctx spanContext, c *client, q, orderBy string) ([]landflow.PropertyOption, error) {
	opts := []landflow.PropertyOption{}
	err := paginate(ctx, "google.drive.files.list", 1000, func(ctx context.Context, token string, remaining int) (int, string, error) {
		page, err := listDriveFiles(ctx, c, q, "nextPageToken,files(id,name)", orderBy, token, pageSize(remaining, 1000))
		if err != nil {
			return 0, "", err
		}
		for _, f := range page.Files {
			opts = append(opts, landflow.PropertyOption{Name: landflow.Stringify(f["name"]), Value: landflow.Stringify(f["id"])})
		}
		return len(page.Files), page.NextPageToken, nil
	})
	return opts, err
}

// LoadOptionsWithContext serves the folder picker.
func (DriveNode) LoadOptionsWithContext(ctx *landflow.LoadOptionsContext) ([]landflow.PropertyOption, error) {
	return loadFolders(ctx)
}

func loadFolders(ctx *landflow.LoadOptionsContext) ([]landflow.PropertyOption, error) {
	if ctx.Method() != "folders" {
		return nil, fmt.Errorf("unknown loadOptions method %q (supported: folders)", ctx.Method())
	}
	c, err := newClient(ctx, ctx.ParamString("authentication", "serviceAccount"))
	if err != nil {
		return nil, err
	}
	folders, err := driveFileOptions(ctx, c, "mimeType = '"+mimeFolder+"' and trashed = false", "name")
	if err != nil {
		return nil, err
	}
	return append([]landflow.PropertyOption{{Name: "My Drive (root)", Value: "root"}}, folders...), nil
}
