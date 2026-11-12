package fakegoogle

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// What the activity triggers read: Drive's changes feed (changes.getStartPageToken,
// changes.list) and shared drives (drives.get), and the Admin SDK Directory's
// users.list and users.get. Calendar sync tokens live in calendar.go.

// Change is one entry of Drive's changes feed.
type Change struct {
	FileID  string
	DriveID string
	Removed bool
	Time    time.Time
}

// DirectoryUser is a Workspace user as the Directory API returns it.
type DirectoryUser = map[string]any

// RecordChange appends a change for a file to the changes feed (AddFile and
// TouchFile call it).
func (s *Server) recordChange(f *File, removed bool) {
	at := f.Modified
	if at.IsZero() {
		at = time.Now().UTC()
	}
	s.Changes = append(s.Changes, Change{FileID: f.ID, DriveID: f.DriveID, Removed: removed, Time: at})
}

// TouchFile marks a file edited now by email, with new content when given,
// and records the change.
func (s *Server) TouchFile(id, email string, content []byte) {
	s.Do(func() {
		f := s.Files[id]
		if f == nil {
			return
		}
		f.Modified = time.Now().UTC()
		f.ModifiedBy = email
		if content != nil {
			f.Content = content
		}
		s.recordChange(f, false)
	})
}

// RemoveFile deletes a file and records a removal.
func (s *Server) RemoveFile(id string) {
	s.Do(func() {
		if f := s.Files[id]; f != nil {
			delete(s.Files, id)
			s.recordChange(f, true)
		}
	})
}

// AddDrive names a shared drive.
func (s *Server) AddDrive(id, name string) { s.Do(func() { s.Drives[id] = name }) }

// AddDirectoryUser stores a Directory user (primaryEmail is required).
func (s *Server) AddDirectoryUser(u DirectoryUser) { s.Do(func() { s.Users = append(s.Users, u) }) }

func (s *Server) changes(w http.ResponseWriter, r *http.Request, segs []string) {
	q := r.URL.Query()
	if len(segs) == 1 && segs[0] == "startPageToken" {
		writeJSON(w, http.StatusOK, map[string]any{"kind": "drive#startPageToken", "startPageToken": strconv.Itoa(len(s.Changes) + 1)})
		return
	}
	if len(segs) != 0 || r.Method != http.MethodGet {
		writeError(w, http.StatusNotFound, "unknown changes call")
		return
	}
	from, err := strconv.Atoi(q.Get("pageToken"))
	if err != nil || from < 1 || from > len(s.Changes)+1 {
		writeError(w, http.StatusBadRequest, "Invalid Value: pageToken")
		return
	}
	allDrives := q.Get("includeItemsFromAllDrives") == "true"
	if allDrives && q.Get("supportsAllDrives") != "true" {
		writeError(w, http.StatusForbidden, "The includeItemsFromAllDrives parameter can only be set to true when supportsAllDrives is also set to true.")
		return
	}
	size, _ := strconv.Atoi(q.Get("pageSize"))
	size = s.pageSize(size, 100)
	start := from - 1
	end := min(start+size, len(s.Changes))
	items := []any{}
	for _, ch := range s.Changes[start:end] {
		if ch.DriveID != "" && !allDrives {
			continue
		}
		if ch.Removed && q.Get("includeRemoved") == "false" {
			continue
		}
		entry := map[string]any{"kind": "drive#change", "changeType": "file", "fileId": ch.FileID, "removed": ch.Removed, "time": ch.Time.UTC().Format(time.RFC3339Nano)}
		if ch.DriveID != "" {
			entry["driveId"] = ch.DriveID
		}
		if f := s.Files[ch.FileID]; f != nil && !ch.Removed {
			entry["file"] = fileJSON(f)
		}
		items = append(items, entry)
	}
	resp := map[string]any{"kind": "drive#changeList", "changes": items}
	if end < len(s.Changes) {
		resp["nextPageToken"] = strconv.Itoa(end + 1)
	} else {
		resp["newStartPageToken"] = strconv.Itoa(len(s.Changes) + 1)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) drives(w http.ResponseWriter, segs []string) {
	if len(segs) == 1 {
		if name, ok := s.Drives[segs[0]]; ok {
			writeJSON(w, http.StatusOK, map[string]any{"kind": "drive#drive", "id": segs[0], "name": name})
			return
		}
	}
	writeError(w, http.StatusNotFound, "Shared drive not found")
}

// directory serves users.list and users.get. Like Google, it wants a
// service-account token that impersonates an admin (DirectoryAdmins), or any
// OAuth token.
func (s *Server) directory(w http.ResponseWriter, r *http.Request, segs []string, info tokenInfo) {
	if info.serviceAccount && (info.subject == "" || len(s.DirectoryAdmins) > 0 && !contains(s.DirectoryAdmins, info.subject)) {
		writeError(w, http.StatusForbidden, "Not Authorized to access this resource/api")
		return
	}
	q := r.URL.Query()
	if len(segs) == 1 {
		for _, u := range s.Users {
			if u["primaryEmail"] == segs[0] || u["id"] == segs[0] {
				writeJSON(w, http.StatusOK, u)
				return
			}
		}
		writeError(w, http.StatusNotFound, "Resource Not Found: userKey")
		return
	}
	if q.Get("customer") == "" && q.Get("domain") == "" {
		writeError(w, http.StatusBadRequest, "Bad Request")
		return
	}
	var matched []DirectoryUser
	for _, u := range s.Users {
		if q.Get("domain") != "" && !strings.HasSuffix(asString(u["primaryEmail"]), "@"+q.Get("domain")) {
			continue
		}
		if !matchesUserQuery(u, q.Get("query")) {
			continue
		}
		matched = append(matched, u)
	}
	sort.SliceStable(matched, func(a, b int) bool {
		return asString(matched[a]["primaryEmail"]) < asString(matched[b]["primaryEmail"])
	})
	start, _ := strconv.Atoi(q.Get("pageToken"))
	size, _ := strconv.Atoi(q.Get("maxResults"))
	if size > 500 {
		writeError(w, http.StatusBadRequest, "Invalid Input: maxResults")
		return
	}
	size = s.pageSize(size, 100)
	end := min(start+size, len(matched))
	users := []any{}
	for _, u := range matched[min(start, end):end] {
		users = append(users, u)
	}
	resp := map[string]any{"kind": "admin#directory#users", "users": users}
	if end < len(matched) {
		resp["nextPageToken"] = strconv.Itoa(end)
	}
	writeJSON(w, http.StatusOK, resp)
}

// matchesUserQuery understands the clauses the plugin sends: orgUnitPath='…'
// and isSuspended=true|false, joined by spaces.
func matchesUserQuery(u DirectoryUser, query string) bool {
	for _, clause := range strings.Fields(query) {
		key, value, ok := strings.Cut(clause, "=")
		if !ok {
			continue
		}
		value = strings.Trim(value, "'")
		switch key {
		case "orgUnitPath":
			if !strings.HasPrefix(asString(u["orgUnitPath"]), value) {
				return false
			}
		case "isSuspended":
			suspended, _ := u["suspended"].(bool)
			if strconv.FormatBool(suspended) != value {
				return false
			}
		}
	}
	return true
}

// activityAdmin serves the live-check endpoints for the activity triggers:
//
//	POST /_fake/drive/docs            {"id","title","text","parents":[…],"driveId","editor","owner"}: create or edit a Doc
//	POST /_fake/calendar/{id}/events  a raw Events resource: create or replace an event
//	POST /_fake/directory/users       a raw Directory user
//
// It reports whether it handled the request.
func (s *Server) activityAdmin(w http.ResponseWriter, r *http.Request, segs []string, body []byte) bool {
	if r.Method != http.MethodPost {
		return false
	}
	switch {
	case hasPrefix(segs, "drive", "docs") && len(segs) == 2:
		var req struct {
			ID, Title, Text, DriveID, Editor, Owner string
			Parents                                 []string
		}
		if err := json.Unmarshal(body, &req); err != nil || req.ID == "" {
			writeError(w, http.StatusBadRequest, "want {id, title, text, parents, driveId, editor, owner}")
			return true
		}
		f := s.Files[req.ID]
		if f == nil {
			f = &File{ID: req.ID, Name: req.Title, MimeType: mimeDocument, Parents: []string{"root"}}
			s.Files[req.ID] = f
			s.Documents[req.ID] = &Document{ID: req.ID, Title: req.Title}
		}
		if req.Title != "" {
			f.Name, s.Documents[req.ID].Title = req.Title, req.Title
		}
		if req.Text != "" && s.Documents[req.ID] != nil {
			s.Documents[req.ID].Text = req.Text
		}
		if len(req.Parents) > 0 {
			f.Parents = req.Parents
		}
		if req.DriveID != "" {
			f.DriveID = req.DriveID
		}
		if req.Owner != "" {
			f.Owner = req.Owner
		}
		f.ModifiedBy = firstOf(req.Editor, f.Owner)
		f.Modified = time.Now().UTC()
		s.recordChange(f, false)
		writeJSON(w, http.StatusOK, fileJSON(f))
	case len(segs) == 3 && segs[0] == "calendar" && segs[2] == "events":
		var ev map[string]any
		if err := json.Unmarshal(body, &ev); err != nil || ev["id"] == nil {
			writeError(w, http.StatusBadRequest, "want an event with an id")
			return true
		}
		if !s.upsertEvent(segs[1], ev) {
			writeError(w, http.StatusNotFound, "no such calendar")
			return true
		}
		writeJSON(w, http.StatusOK, ev)
	case hasPrefix(segs, "directory", "users") && len(segs) == 2:
		var u DirectoryUser
		if err := json.Unmarshal(body, &u); err != nil || u["primaryEmail"] == nil {
			writeError(w, http.StatusBadRequest, "want a user with a primaryEmail")
			return true
		}
		s.Users = append(s.Users, u)
		writeJSON(w, http.StatusOK, u)
	default:
		return false
	}
	return true
}

func firstOf(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
