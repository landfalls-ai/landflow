package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Drive changes as activity items (docs/protocol.md §16): the Google Drive
// Trigger polls Drive's changes feed from a page token, and the Drive node's
// File → Get Many Changed Since and Get Item read the same items on demand.
//
// Drive can push changes to a channel (changes.watch), but a channel expires
// within a week and must be renewed by the caller; Landflow's app webhooks
// have no renewal, so the trigger polls changes.list with the page token,
// which never expires.

const (
	// driveActivityFields are the file fields an activity item is built from.
	driveActivityFields = "id,name,mimeType,parents,owners(emailAddress,displayName),lastModifyingUser(emailAddress,displayName)," +
		"driveId,modifiedTime,webViewLink,trashed,size"
	// driveMaxChangePages caps one poll's changes.list pages (1,000 changes
	// each); the rest is read at the next poll.
	driveMaxChangePages = 20
	driveManualItems    = 5
	// driveFolderDepth caps the walk up the folder tree.
	driveFolderDepth = 15
	// driveSnippetBytes is how much of a Doc's text the summary reads.
	driveSnippetBytes = 8 << 10
	driveTextMax      = 10 << 20
)

var drivePageToken = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`)

// driveActivityOptions are the options shared by the trigger and the node.
func driveActivityOptions(d *landflow.DisplayOptions) landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: "activityOptions", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{},
		Placeholder: "Add Option", DisplayOptions: d,
		Values: []landflow.PropertyDescriptor{
			{Name: "includeText", DisplayName: "Read Google Docs Text", Type: landflow.PropBoolean, Default: true,
				Description: "Whether a Google Doc's summary is its first 600 characters (one export per Doc; needs a Drive scope that can read content, not drive.metadata.readonly)"},
			{Name: "includeFolders", DisplayName: "Include Folders", Type: landflow.PropBoolean, Default: false},
			{Name: "folderId", DisplayName: "Only Under Folder", Type: landflow.PropString, Default: "",
				Description: "ID or link of a folder: only files anywhere below it"},
			{Name: "customerFolder", DisplayName: "Customer Folder Name", Type: landflow.PropString, Default: "Customers",
				Description: "A file in <this folder>/<name>/… is about the customer <name> (customerHint)"},
			{Name: "initiativeFolder", DisplayName: "Initiative Folder Name", Type: landflow.PropString, Default: "Projects",
				Description: "A file in <this folder>/<name>/… belongs to the initiative <name> (initiativeHint)"},
		},
	}
}

type driveFolder struct {
	id, name string
	parents  []string
}

// driveActivity turns Drive files into activity items, caching folders and
// shared drive names for one run.
type driveActivity struct {
	c                *client
	log              *landflow.Logger
	includeText      bool
	includeFolders   bool
	under            string
	customerFolder   string
	initiativeFolder string
	allDrives        bool
	folders          map[string]*driveFolder
	drives           map[string]string
}

func newDriveActivity(ctx *landflow.ExecuteContext, c *client, i int) *driveActivity {
	opts := asMap(ctx.Param("activityOptions", i))
	return &driveActivity{
		c: c, log: ctx.Logger,
		includeText:      getBool(opts, "includeText", true),
		includeFolders:   getBool(opts, "includeFolders", false),
		under:            idFrom(strings.TrimSpace(getString(opts, "folderId", "")), driveURLPattern),
		customerFolder:   strings.TrimSpace(getString(opts, "customerFolder", "Customers")),
		initiativeFolder: strings.TrimSpace(getString(opts, "initiativeFolder", "Projects")),
		allDrives:        ctx.ParamBool("sharedDrives", i, true),
		folders:          map[string]*driveFolder{},
		drives:           map[string]string{},
	}
}

// folder fetches (once) a folder's name and parents; nil when it can't be read.
func (a *driveActivity) folder(ctx context.Context, id string) *driveFolder {
	if f, ok := a.folders[id]; ok {
		return f
	}
	var meta struct {
		ID      string   `json:"id"`
		Name    string   `json:"name"`
		Parents []string `json:"parents"`
	}
	err := a.c.do(ctx, apiDrive, http.MethodGet, "/drive/v3/files/"+url.PathEscape(id), url.Values{"fields": {"id,name,parents"}, "supportsAllDrives": {"true"}}, nil, &meta)
	var f *driveFolder
	if err == nil {
		f = &driveFolder{id: meta.ID, name: meta.Name, parents: meta.Parents}
	}
	a.folders[id] = f
	return f
}

// driveName is a shared drive's name ("" when unknown).
func (a *driveActivity) driveName(ctx context.Context, id string) string {
	if id == "" {
		return ""
	}
	if name, ok := a.drives[id]; ok {
		return name
	}
	var d struct {
		Name string `json:"name"`
	}
	if err := a.c.do(ctx, apiDrive, http.MethodGet, "/drive/v3/drives/"+url.PathEscape(id), nil, nil, &d); err != nil {
		a.log.Warn("could not read shared drive %s: %v", id, err)
	}
	a.drives[id] = d.Name
	return d.Name
}

// path walks up from the file's first parent: the folders from the top down
// (a shared drive's root is the drive itself, and stops the walk).
func (a *driveActivity) path(ctx context.Context, file map[string]any) []driveFolder {
	var chain []driveFolder
	parents := stringList(file["parents"])
	driveID := getString(file, "driveId", "")
	for depth := 0; len(parents) > 0 && depth < driveFolderDepth; depth++ {
		id := parents[0]
		if id == driveID {
			break
		}
		f := a.folder(ctx, id)
		if f == nil || f.name == "" {
			break
		}
		chain = append(chain, *f)
		parents = f.parents
	}
	slices.Reverse(chain)
	return chain
}

// hintAfter is the folder name right below a folder called name.
func hintAfter(chain []driveFolder, name string) string {
	if name == "" {
		return ""
	}
	for k := 0; k+1 < len(chain); k++ {
		if strings.EqualFold(chain[k].name, name) {
			return chain[k+1].name
		}
	}
	return ""
}

// docText exports a Google Doc as plain text, at most limit bytes.
func (a *driveActivity) docText(ctx context.Context, id string, limit int64) (string, error) {
	var text []byte
	err := a.c.send(ctx, apiDrive, func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, a.c.url(apiDrive, "/drive/v3/files/"+url.PathEscape(id)+"/export", url.Values{"mimeType": {"text/plain"}}), nil)
	}, func(resp *http.Response) error {
		var err error
		text, err = io.ReadAll(io.LimitReader(resp.Body, limit))
		return err
	})
	return strings.TrimPrefix(string(text), "\uFEFF"), err
}

// keep reports whether a file belongs in the output (not trashed, not a
// folder unless asked, under the chosen folder).
func (a *driveActivity) keep(ctx context.Context, file map[string]any) bool {
	if file == nil || getBool(file, "trashed", false) {
		return false
	}
	if getString(file, "mimeType", "") == mimeFolder && !a.includeFolders {
		return false
	}
	if a.under == "" {
		return true
	}
	for _, f := range a.path(ctx, file) {
		if f.id == a.under {
			return true
		}
	}
	return slices.Contains(stringList(file["parents"]), a.under)
}

// item builds one activity item; withText adds the full text of a Doc (or a
// plain-text file) as `text`.
func (a *driveActivity) item(ctx context.Context, file map[string]any, cursor *string, withText bool) (map[string]any, error) {
	id := getString(file, "id", "")
	mimeType := getString(file, "mimeType", "")
	chain := a.path(ctx, file)
	driveName := a.driveName(ctx, getString(file, "driveId", ""))
	names := make([]string, 0, len(chain)+1)
	if driveName != "" {
		names = append(names, driveName)
	}
	for _, f := range chain {
		names = append(names, f.name)
	}
	folderPath := strings.Join(names, "/")

	owner := ""
	if owners, ok := file["owners"].([]any); ok && len(owners) > 0 {
		owner = getString(asMap(owners[0]), "emailAddress", "")
	}
	actor := getString(asMap(file["lastModifyingUser"]), "emailAddress", "")
	if actor == "" {
		actor = owner
	}

	var text string
	if mimeType == mimeDocument && (a.includeText || withText) {
		limit := int64(driveSnippetBytes)
		if withText {
			limit = driveTextMax
		}
		t, err := a.docText(ctx, id, limit)
		if err != nil {
			if withText {
				return nil, err
			}
			a.log.Warn("could not read the text of %s: %v", id, err)
		}
		text = t
	} else if withText && (strings.HasPrefix(mimeType, "text/") || mimeType == "application/json") {
		err := a.c.send(ctx, apiDrive, func() (*http.Request, error) {
			return http.NewRequestWithContext(ctx, http.MethodGet, a.c.url(apiDrive, "/drive/v3/files/"+url.PathEscape(id), url.Values{"alt": {"media"}, "supportsAllDrives": {"true"}}), nil)
		}, func(resp *http.Response) error {
			b, err := io.ReadAll(io.LimitReader(resp.Body, driveTextMax))
			text = string(b)
			return err
		})
		if err != nil {
			return nil, err
		}
	}
	summary := text
	if summary == "" {
		summary = fmt.Sprintf("%s in %s", mimeLabel(mimeType), firstNonEmpty(folderPath, "My Drive"))
	}
	modified := getString(file, "modifiedTime", "")
	item, err := landflow.ActivityItem(landflow.Activity{
		Source:         "google-drive",
		SourceID:       "google-drive:" + id + ":" + modified,
		URL:            getString(file, "webViewLink", ""),
		ActorEmail:     actor,
		OccurredAt:     modified,
		Kind:           "work.doc_edited",
		Title:          getString(file, "name", id),
		Summary:        summary,
		TeamHint:       driveName,
		InitiativeHint: hintAfter(chain, a.initiativeFolder),
		CustomerHint:   hintAfter(chain, a.customerFolder),
		Raw: map[string]any{
			"id": id, "name": file["name"], "mimeType": mimeType, "owner": owner, "lastModifyingUser": actor,
			"folderPath": folderPath, "driveId": file["driveId"], "driveName": driveName, "modifiedTime": modified,
			"webViewLink": file["webViewLink"], "size": file["size"],
		},
		Cursor: cursor,
	})
	if err != nil {
		return nil, err
	}
	if withText {
		item["text"] = text
	}
	return item, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// mimeLabel names a file type for a summary.
func mimeLabel(mimeType string) string {
	switch mimeType {
	case mimeDocument:
		return "Google Doc"
	case mimeSpreadsheet:
		return "Google Sheet"
	case "application/vnd.google-apps.presentation":
		return "Google Slides"
	case mimeFolder:
		return "Folder"
	case "application/pdf":
		return "PDF"
	}
	if mimeType == "" {
		return "File"
	}
	return mimeType
}

// driveChangePage is one changes.list answer.
type driveChangePage struct {
	Changes []struct {
		FileID  string         `json:"fileId"`
		Removed bool           `json:"removed"`
		File    map[string]any `json:"file"`
	} `json:"changes"`
	NextPageToken     string `json:"nextPageToken"`
	NewStartPageToken string `json:"newStartPageToken"`
}

func driveStartPageToken(ctx context.Context, c *client) (string, error) {
	var out struct {
		StartPageToken string `json:"startPageToken"`
	}
	err := c.do(ctx, apiDrive, http.MethodGet, "/drive/v3/changes/startPageToken", url.Values{"supportsAllDrives": {"true"}}, nil, &out)
	return out.StartPageToken, err
}

// collectChanges reads the changes feed from token (at most maxPages pages):
// the latest version of each changed file, oldest first, and the token to
// read from next (the new start token at the end of the feed).
func (a *driveActivity) collectChanges(ctx spanContext, token string, maxPages int) ([]map[string]any, string, error) {
	latest := map[string]map[string]any{}
	next := token
	err := ctx.Span("google.drive.changes.list", landflow.Attrs{"google.limit": maxPages}, func(span landflow.Span) error {
		for page := 0; page < maxPages; page++ {
			query := url.Values{
				"pageToken": {next}, "pageSize": {"1000"}, "spaces": {"drive"}, "includeRemoved": {"false"},
				"supportsAllDrives": {"true"}, "includeItemsFromAllDrives": {strconv.FormatBool(a.allDrives)},
				"fields": {"nextPageToken,newStartPageToken,changes(fileId,removed,file(" + driveActivityFields + "))"},
			}
			var p driveChangePage
			if err := a.c.do(span, apiDrive, http.MethodGet, "/drive/v3/changes", query, nil, &p); err != nil {
				return err
			}
			for _, ch := range p.Changes {
				if !ch.Removed && ch.File != nil {
					latest[ch.FileID] = ch.File
				}
			}
			if p.NewStartPageToken != "" {
				next = p.NewStartPageToken
				return nil
			}
			if p.NextPageToken == "" {
				return nil
			}
			next = p.NextPageToken
		}
		return nil
	})
	if err != nil {
		return nil, token, err
	}
	files := make([]map[string]any, 0, len(latest))
	for _, f := range latest {
		if a.keep(ctx, f) {
			files = append(files, f)
		}
	}
	sortByModified(files)
	return files, next, nil
}

func sortByModified(files []map[string]any) {
	slices.SortStableFunc(files, func(x, y map[string]any) int {
		return strings.Compare(getString(x, "modifiedTime", ""), getString(y, "modifiedTime", ""))
	})
}

// recentFiles lists files modified after since (RFC 3339), oldest first, at
// most want (< 0: all).
func (a *driveActivity) recentFiles(ctx spanContext, since string, want int, newestFirst bool) ([]map[string]any, error) {
	q := "trashed = false"
	if since != "" {
		q += " and modifiedTime > " + driveString(since)
	}
	if !a.includeFolders {
		q += " and mimeType != '" + mimeFolder + "'"
	}
	order := "modifiedTime"
	if newestFirst {
		order = "modifiedTime desc"
	}
	var files []map[string]any
	err := paginate(ctx, "google.drive.files.list", -1, func(c context.Context, token string, remaining int) (int, string, error) {
		page, err := listDriveFiles(c, a.c, q, "nextPageToken,files("+driveActivityFields+")", order, token, 1000)
		if err != nil {
			return 0, "", err
		}
		n := 0
		for _, f := range page.Files {
			if want >= 0 && len(files) >= want {
				return n, "", nil
			}
			if a.keep(ctx, f) {
				files = append(files, f)
				n++
			}
		}
		return n, page.NextPageToken, nil
	})
	if !newestFirst {
		sortByModified(files)
	}
	return files, err
}

// ---------------------------------------------------------------------------
// Google Drive Trigger
// ---------------------------------------------------------------------------

// DriveTriggerNode polls Drive's changes feed. State: {pageToken}.
type DriveTriggerNode struct{}

func (DriveTriggerNode) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name:             "googleDriveTrigger",
		DisplayName:      "Google Drive Trigger",
		Description:      "Starts the workflow when files change in Google Drive (shared drives included), with each file as an activity item",
		Version:          landflow.V(1),
		Kind:             landflow.KindTrigger,
		TriggerSource:    landflow.TriggerPoll,
		Categories:       []string{"Data & Storage"},
		Icon:             "file:icons/drive.svg",
		Color:            "#1FA463",
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		DocumentationURL: "https://developers.google.com/workspace/drive/api/guides/manage-changes",
		Keywords:         []string{"drive", "changes", "file changed", "document edited", "activity", "poll"},
		Credentials:      credentialRequirements(),
		OutputSchema:     landflow.ActivityItemSchema(),
		Properties: []landflow.PropertyDescriptor{
			authProperty(),
			landflow.PollIntervalProperty(300),
			{Name: "pollNotice", DisplayName: "The first poll only records where Drive's changes feed is; later polls return the files changed since, once each (the latest version). Executing the node in the editor returns the 5 most recently modified files.", Type: landflow.PropNotice, Default: ""},
			{Name: "sharedDrives", DisplayName: "Include Shared Drives", Type: landflow.PropBoolean, Default: true,
				Description: "Whether files in shared drives the account is a member of are included"},
			driveActivityOptions(nil),
		},
	}
}

func (DriveTriggerNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	c, err := newClient(ctx, ctx.ParamString("authentication", 0, "serviceAccount"))
	if err != nil {
		return nil, err
	}
	a := newDriveActivity(ctx, c, 0)
	var files []map[string]any
	switch {
	case ctx.Mode() == landflow.ModeManual:
		if files, err = a.recentFiles(ctx, "", driveManualItems, true); err != nil {
			return nil, err
		}
		sortByModified(files)
	case ctx.IsFirstPoll() || !landflow.CredentialData(ctx.PollState()).Has("pageToken"):
		token, err := driveStartPageToken(ctx, c)
		if err != nil {
			return nil, err
		}
		ctx.SetPollState(map[string]any{"pageToken": token})
		return nil, nil
	default:
		token := landflow.CredentialData(ctx.PollState()).String("pageToken")
		var next string
		files, next, err = a.collectChanges(ctx, token, driveMaxChangePages)
		if err != nil {
			return nil, err
		}
		ctx.SetPollState(map[string]any{"pageToken": next})
	}
	items := make([]landflow.Item, 0, len(files))
	for _, f := range files {
		item, err := a.item(ctx, f, nil, false)
		if err != nil {
			return nil, err
		}
		items = append(items, landflow.Item{JSON: item})
	}
	if len(items) > 0 && ctx.Mode() != landflow.ModeManual {
		ctx.Metrics().Counter("landflow.google.poll.new_items", landflow.WithDescription("New items found by Google polling triggers")).
			Add(float64(len(items)), landflow.Attrs{"trigger": "drive"})
		ctx.Logger.Info("%d changed file(s)", len(items))
	}
	return [][]landflow.Item{items}, nil
}

// ---------------------------------------------------------------------------
// Google Drive node: File → Get Many Changed Since, Get Item
// ---------------------------------------------------------------------------

// changesSince reads files changed after a time (files.list by modifiedTime)
// or after a changes-feed page token (a cursor from an earlier run).
func (d *driveRun) changesSince(i int) ([]map[string]any, error) {
	a := newDriveActivity(d.ctx, d.c, i)
	since := strings.TrimSpace(d.ctx.ParamString("since", i, ""))
	want := limitFor(d.ctx, i, 50)
	var out []map[string]any
	if since != "" && !drivePageToken.MatchString(since) {
		files, next, err := a.collectChanges(d.ctx, since, driveMaxChangePages)
		if err != nil {
			return nil, err
		}
		for _, f := range files {
			if want >= 0 && len(out) >= want {
				break
			}
			item, err := a.item(d.ctx, f, &next, false)
			if err != nil {
				return nil, err
			}
			out = append(out, item)
		}
		return out, nil
	}
	from := time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339)
	if since != "" {
		t, err := landflow.ToISOTime(since)
		if err != nil {
			return nil, userError("Give an ISO time (2026-11-12T08:00:00Z) or a cursor from an earlier item.", "Since is not a time or a Drive page token")
		}
		from = t
	}
	files, err := a.recentFiles(d.ctx, from, want, false)
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		cursor := getString(f, "modifiedTime", "")
		item, err := a.item(d.ctx, f, &cursor, false)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

// getItem returns one file as an activity item with its full text.
func (d *driveRun) getItem(i int) (map[string]any, error) {
	raw, err := requireParam(d.ctx, "fileId", "File ID", i)
	if err != nil {
		return nil, err
	}
	var file map[string]any
	if err := d.c.do(d.ctx, apiDrive, http.MethodGet, "/drive/v3/files/"+url.PathEscape(idFrom(raw, driveURLPattern)),
		url.Values{"fields": {driveActivityFields}, "supportsAllDrives": {"true"}}, nil, &file); err != nil {
		return nil, err
	}
	return newDriveActivity(d.ctx, d.c, i).item(d.ctx, file, nil, true)
}

// activityWithTextSchema is the activity item schema plus the full `text`.
func activityWithTextSchema(description string) map[string]any {
	schema := landflow.ActivityItemSchema()
	props := schema["properties"].(map[string]any)
	props["text"] = map[string]any{"type": "string", "description": description}
	schema["required"] = append(schema["required"].([]any), "text")
	return schema
}
