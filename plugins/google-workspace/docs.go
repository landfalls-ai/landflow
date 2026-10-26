package main

import (
	"net/http"
	"net/url"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// DocsNode is Google Docs' document resource: create (optionally in a
// folder), get (simplified to plain text) and update (insert text at the end,
// replace all text) through documents.batchUpdate.
type DocsNode struct{}

func (DocsNode) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name:             "googleDocs",
		DisplayName:      "Google Docs",
		Description:      "Create, read and edit Google Docs",
		Version:          landflow.V(1),
		Kind:             landflow.KindAction,
		Categories:       []string{"Productivity"},
		Icon:             "file:icons/docs.svg",
		Color:            "#4285F4",
		Subtitle:         "{{operation}}: {{resource}}",
		Inputs:           []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		DocumentationURL: "https://developers.google.com/workspace/docs/api/reference/rest",
		Keywords:         []string{"document", "doc", "text", "write", "word processor"},
		Credentials:      credentialRequirements(),

		UsableAsTool: true,
		ToolDescription: "Work with Google Docs. operation=create makes a document called title; get returns " +
			"documentURL's text as `content`; update applies actionsUi actions to documentURL: insert appends text " +
			"at the end, replaceAll replaces every occurrence of text with replaceText.",

		Properties: []landflow.PropertyDescriptor{
			authProperty(),
			resourceProperty("document", landflow.PropertyOption{Name: "Document", Value: "document"}),
			operationProperty("document", "create",
				landflow.PropertyOption{Name: "Create", Value: "create", Description: "Create a document", Action: "Create a document"},
				landflow.PropertyOption{Name: "Get", Value: "get", Description: "Get a document", Action: "Get a document", Idempotent: true},
				landflow.PropertyOption{Name: "Update", Value: "update", Description: "Update a document", Action: "Update a document"},
			),
			{Name: "title", DisplayName: "Title", Type: landflow.PropString, Default: "", Required: true,
				DisplayOptions: show("document", "create")},
			folderProperty("folderId", "Folder", "Folder to put the document in (moved there through Drive)", show("document", "create")),
			{Name: "documentURL", DisplayName: "Doc ID or URL", Type: landflow.PropString, Default: "", Required: true,
				DisplayOptions: show("document", "get", "update")},
			simplifyProperty(show("document", "get")),
			{
				Name: "actionsUi", DisplayName: "Actions", Type: landflow.PropFixedCollection, Default: map[string]any{},
				Placeholder: "Add Action", TypeOptions: &landflow.TypeOptions{MultipleValues: true},
				DisplayOptions: show("document", "update"),
				Groups: []landflow.FixedCollectionGroup{{Name: "actionFields", DisplayName: "Action", Values: []landflow.PropertyDescriptor{
					{Name: "action", DisplayName: "Action", Type: landflow.PropOptions, Default: "insert",
						Options: []landflow.PropertyOption{
							{Name: "Insert", Value: "insert", Description: "Insert text at the end of the document"},
							{Name: "Replace All", Value: "replaceAll", Description: "Replace every occurrence of a text"},
						}},
					{Name: "text", DisplayName: "Text", Type: landflow.PropString, Default: "",
						Description: "Text to insert, or the text to find for Replace All"},
					{Name: "replaceText", DisplayName: "Replace With", Type: landflow.PropString, Default: "",
						DisplayOptions: &landflow.DisplayOptions{Show: map[string][]any{"action": {"replaceAll"}}}},
					{Name: "matchCase", DisplayName: "Match Case", Type: landflow.PropBoolean, Default: false,
						DisplayOptions: &landflow.DisplayOptions{Show: map[string][]any{"action": {"replaceAll"}}}},
				}}},
			},
		},
	}
}

func (DocsNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	items := ctx.InputData(0)
	if len(items) == 0 {
		return nil, nil
	}
	c, err := newClient(ctx, ctx.ParamString("authentication", 0, "serviceAccount"))
	if err != nil {
		return nil, err
	}
	d := &docsRun{ctx: ctx, c: c}
	var out []landflow.Item
	for i := range items {
		operation := ctx.ParamString("operation", i, "create")
		var result map[string]any
		switch operation {
		case "create":
			result, err = d.create(i)
		case "get":
			result, err = d.get(i)
		case "update":
			result, err = d.update(i)
		default:
			err = userError("Pick an operation listed for the document resource.", "Unsupported operation %q", operation)
		}
		if err != nil {
			if ctx.ContinueOnFail() {
				out = append(out, ctx.ErrorItem(i, itemError(i, err)))
				continue
			}
			return nil, itemError(i, err)
		}
		out = emit(out, i, result)
	}
	return [][]landflow.Item{out}, nil
}

type docsRun struct {
	ctx *landflow.ExecuteContext
	c   *client
}

func documentPath(id string) string { return "/v1/documents/" + url.PathEscape(id) }

// create makes a document, then moves it into the folder through Drive (the
// Docs API always creates in My Drive).
func (d *docsRun) create(i int) (map[string]any, error) {
	title, err := requireParam(d.ctx, "title", "Title", i)
	if err != nil {
		return nil, err
	}
	var doc struct {
		DocumentID string `json:"documentId"`
		Title      string `json:"title"`
	}
	if err := d.c.do(d.ctx, apiDocs, http.MethodPost, "/v1/documents", nil, map[string]any{"title": title}, &doc); err != nil {
		return nil, err
	}
	out := map[string]any{
		"documentId":  doc.DocumentID,
		"title":       doc.Title,
		"documentUrl": "https://docs.google.com/document/d/" + doc.DocumentID + "/edit",
	}
	folder := idFrom(d.ctx.ParamString("folderId", i, "root"), driveURLPattern)
	if folder == "" || folder == "root" {
		return out, nil
	}
	filePath := "/drive/v3/files/" + url.PathEscape(doc.DocumentID)
	var meta struct {
		Parents []string `json:"parents"`
	}
	if err := d.c.do(d.ctx, apiDrive, http.MethodGet, filePath, url.Values{"fields": {"parents"}, "supportsAllDrives": {"true"}}, nil, &meta); err != nil {
		return nil, err
	}
	query := url.Values{
		"addParents":        {folder},
		"removeParents":     {strings.Join(meta.Parents, ",")},
		"supportsAllDrives": {"true"},
		"fields":            {"id,parents"},
	}
	if err := d.c.do(d.ctx, apiDrive, http.MethodPatch, filePath, query, map[string]any{}, nil); err != nil {
		return nil, err
	}
	out["folderId"] = folder
	return out, nil
}

func (d *docsRun) documentID(i int) (string, error) {
	raw, err := requireParam(d.ctx, "documentURL", "Doc ID or URL", i)
	if err != nil {
		return "", err
	}
	return idFrom(raw, documentURLPattern), nil
}

func (d *docsRun) get(i int) (map[string]any, error) {
	id, err := d.documentID(i)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err := d.c.do(d.ctx, apiDocs, http.MethodGet, documentPath(id), nil, nil, &doc); err != nil {
		return nil, err
	}
	if !d.ctx.ParamBool("simple", i, true) {
		return doc, nil
	}
	body, _ := doc["body"].(map[string]any)
	return map[string]any{
		"documentId": landflow.Stringify(doc["documentId"]),
		"title":      landflow.Stringify(doc["title"]),
		"content":    documentText(body["content"]),
	}, nil
}

// update sends the actions as one batchUpdate.
func (d *docsRun) update(i int) (map[string]any, error) {
	id, err := d.documentID(i)
	if err != nil {
		return nil, err
	}
	var requests []map[string]any
	for _, a := range entries(d.ctx.Param("actionsUi", i), "actionFields") {
		text := getString(a, "text", "")
		switch action := getString(a, "action", "insert"); action {
		case "insert":
			if text == "" {
				continue
			}
			requests = append(requests, map[string]any{"insertText": map[string]any{
				"text":                 text,
				"endOfSegmentLocation": map[string]any{"segmentId": ""},
			}})
		case "replaceAll":
			if text == "" {
				return nil, userError("Set the text to find for Replace All.", "Replace All needs a text to find")
			}
			requests = append(requests, map[string]any{"replaceAllText": map[string]any{
				"containsText": map[string]any{"text": text, "matchCase": getBool(a, "matchCase", false)},
				"replaceText":  getString(a, "replaceText", ""),
			}})
		default:
			return nil, userError("Use insert or replaceAll.", "Unknown action %q", action)
		}
	}
	if len(requests) == 0 {
		return nil, userError("Add an action with some text under Actions.", "Nothing to update")
	}
	var resp struct {
		DocumentID string `json:"documentId"`
		Replies    []struct {
			ReplaceAllText *struct {
				OccurrencesChanged int `json:"occurrencesChanged"`
			} `json:"replaceAllText"`
		} `json:"replies"`
	}
	if err := d.c.do(d.ctx, apiDocs, http.MethodPost, documentPath(id)+":batchUpdate", nil, map[string]any{"requests": requests}, &resp); err != nil {
		return nil, err
	}
	changed := 0
	for _, r := range resp.Replies {
		if r.ReplaceAllText != nil {
			changed += r.ReplaceAllText.OccurrencesChanged
		}
	}
	return map[string]any{"documentId": id, "actions": len(requests), "occurrencesChanged": changed}, nil
}

// documentText extracts plain text from a document body's structural
// elements: paragraphs, tables (cell by cell) and tables of contents.
func documentText(content any) string {
	var b strings.Builder
	var walk func(elements any)
	walk = func(elements any) {
		list, _ := elements.([]any)
		for _, e := range list {
			el, _ := e.(map[string]any)
			if p, ok := el["paragraph"].(map[string]any); ok {
				parts, _ := p["elements"].([]any)
				for _, part := range parts {
					pe, _ := part.(map[string]any)
					if run, ok := pe["textRun"].(map[string]any); ok {
						b.WriteString(landflow.Stringify(run["content"]))
					}
				}
			}
			if table, ok := el["table"].(map[string]any); ok {
				rows, _ := table["tableRows"].([]any)
				for _, row := range rows {
					r, _ := row.(map[string]any)
					cells, _ := r["tableCells"].([]any)
					for _, cell := range cells {
						if c, ok := cell.(map[string]any); ok {
							walk(c["content"])
						}
					}
				}
			}
			if toc, ok := el["tableOfContents"].(map[string]any); ok {
				walk(toc["content"])
			}
		}
	}
	walk(content)
	return b.String()
}

// LoadOptionsWithContext lists Drive folders for the folder picker.
func (DocsNode) LoadOptionsWithContext(ctx *landflow.LoadOptionsContext) ([]landflow.PropertyOption, error) {
	return loadFolders(ctx)
}
