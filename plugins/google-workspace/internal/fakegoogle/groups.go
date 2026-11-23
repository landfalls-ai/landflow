package fakegoogle

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// The Admin SDK Directory's groups and group members, stateful: a member added
// through the API shows on the next list, a removed one is gone. Like Google,
// a service-account token needs an admin to impersonate (DirectoryAdmins) and
// the group scopes the call is documented to take.

const (
	scopeGroup  = "https://www.googleapis.com/auth/admin.directory.group"
	scopeMember = "https://www.googleapis.com/auth/admin.directory.group.member"
)

// DirectoryGroup is a group as groups.get returns it (id and email are required).
type DirectoryGroup = map[string]any

// DirectoryMember is a group member as members.get returns it.
type DirectoryMember = map[string]any

// AddDirectoryGroup stores a group.
func (s *Server) AddDirectoryGroup(g DirectoryGroup) {
	s.Do(func() { s.Groups = append(s.Groups, g) })
}

// AddDirectoryMember puts a member (email, role) in a group, given by email or id.
func (s *Server) AddDirectoryMember(group string, m DirectoryMember) {
	s.Do(func() {
		if g := s.findGroup(group); g != nil {
			s.putMember(g, m)
		}
	})
}

// DirectoryMembers lists the members of a group as {email: role}.
func (s *Server) DirectoryMembers(group string) map[string]string {
	out := map[string]string{}
	s.Do(func() {
		if g := s.findGroup(group); g != nil {
			for _, m := range s.Members[asString(g["id"])] {
				out[strings.ToLower(asString(m["email"]))] = asString(m["role"])
			}
		}
	})
	return out
}

func (s *Server) findGroup(key string) DirectoryGroup {
	key = strings.ToLower(key)
	for _, g := range s.Groups {
		if strings.ToLower(asString(g["email"])) == key || asString(g["id"]) == key {
			return g
		}
	}
	return nil
}

func (s *Server) findMember(g DirectoryGroup, key string) int {
	key = strings.ToLower(key)
	for i, m := range s.Members[asString(g["id"])] {
		if strings.ToLower(asString(m["email"])) == key || asString(m["id"]) == key {
			return i
		}
	}
	return -1
}

func (s *Server) putMember(g DirectoryGroup, m DirectoryMember) DirectoryMember {
	if s.Members == nil {
		s.Members = map[string][]DirectoryMember{}
	}
	email := strings.ToLower(asString(m["email"]))
	m["email"] = email
	if m["role"] == nil || m["role"] == "" {
		m["role"] = "MEMBER"
	}
	if m["id"] == nil {
		m["id"] = "m-" + strconv.Itoa(len(s.Members[asString(g["id"])])+1) + "-" + email
	}
	m["kind"], m["type"], m["status"] = "admin#directory#member", firstNonNil(m["type"], "USER"), firstNonNil(m["status"], "ACTIVE")
	id := asString(g["id"])
	s.Members[id] = append(s.Members[id], m)
	g["directMembersCount"] = strconv.Itoa(len(s.Members[id]))
	return m
}

func firstNonNil(a, b any) any {
	if a != nil {
		return a
	}
	return b
}

// groups serves groups.list / get and the members of a group.
func (s *Server) groups(w http.ResponseWriter, r *http.Request, segs []string, body []byte, info tokenInfo) {
	if info.serviceAccount && (info.subject == "" || len(s.DirectoryAdmins) > 0 && !contains(s.DirectoryAdmins, info.subject)) {
		writeError(w, http.StatusForbidden, "Not Authorized to access this resource/api")
		return
	}
	needs := []string{scopeGroup}
	if len(segs) > 1 {
		needs = []string{scopeMember, scopeGroup}
	}
	if info.serviceAccount && !hasAnyScope(info.scope, needs...) {
		writeError(w, http.StatusForbidden, "Request had insufficient authentication scopes.")
		return
	}
	q := r.URL.Query()
	if len(segs) == 0 {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusNotFound, "Method not found")
			return
		}
		s.listGroups(w, q.Get("domain"), q.Get("customer"), q.Get("query"), q.Get("pageToken"), q.Get("maxResults"))
		return
	}
	g := s.findGroup(segs[0])
	if g == nil {
		writeError(w, http.StatusNotFound, "Resource Not Found: groupKey")
		return
	}
	if len(segs) == 1 {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusNotFound, "Method not found")
			return
		}
		writeJSON(w, http.StatusOK, g)
		return
	}
	id := asString(g["id"])
	switch {
	case segs[1] == "hasMember" && len(segs) == 3:
		writeJSON(w, http.StatusOK, map[string]any{"isMember": s.findMember(g, segs[2]) >= 0})
	case segs[1] != "members":
		writeError(w, http.StatusNotFound, "Method not found: "+r.URL.Path)
	case len(segs) == 2 && r.Method == http.MethodGet:
		roles := strings.Split(strings.ToUpper(q.Get("roles")), ",")
		var matched []any
		for _, m := range s.Members[id] {
			if q.Get("roles") == "" || contains(roles, asString(m["role"])) {
				matched = append(matched, m)
			}
		}
		page, next := s.page(matched, q.Get("pageToken"), q.Get("maxResults"))
		resp := map[string]any{"kind": "admin#directory#members", "members": page}
		if next != "" {
			resp["nextPageToken"] = next
		}
		writeJSON(w, http.StatusOK, resp)
	case len(segs) == 2 && r.Method == http.MethodPost:
		var m DirectoryMember
		if err := json.Unmarshal(body, &m); err != nil || asString(m["email"]) == "" {
			writeError(w, http.StatusBadRequest, "Missing required field: email")
			return
		}
		if role := asString(m["role"]); role != "" && role != "MEMBER" && role != "MANAGER" && role != "OWNER" {
			writeError(w, http.StatusBadRequest, "Invalid Input: role")
			return
		}
		if s.findMember(g, asString(m["email"])) >= 0 {
			writeError(w, http.StatusConflict, "Member already exists.")
			return
		}
		if !s.userExistsOrExternal(g, asString(m["email"])) {
			writeError(w, http.StatusNotFound, "Resource Not Found: memberKey")
			return
		}
		writeJSON(w, http.StatusOK, s.putMember(g, m))
	case len(segs) == 3:
		i := s.findMember(g, segs[2])
		if i < 0 {
			writeError(w, http.StatusNotFound, "Resource Not Found: memberKey")
			return
		}
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, s.Members[id][i])
		case http.MethodDelete:
			s.Members[id] = append(s.Members[id][:i], s.Members[id][i+1:]...)
			g["directMembersCount"] = strconv.Itoa(len(s.Members[id]))
			w.WriteHeader(http.StatusNoContent)
		case http.MethodPatch, http.MethodPut:
			var patch struct{ Role string }
			if err := json.Unmarshal(body, &patch); err != nil || (patch.Role != "MEMBER" && patch.Role != "MANAGER" && patch.Role != "OWNER") {
				writeError(w, http.StatusBadRequest, "Invalid Input: role")
				return
			}
			s.Members[id][i]["role"] = patch.Role
			writeJSON(w, http.StatusOK, s.Members[id][i])
		default:
			writeError(w, http.StatusNotFound, "Method not found")
		}
	default:
		writeError(w, http.StatusNotFound, "Method not found: "+r.URL.Path)
	}
}

// userExistsOrExternal: a member in the group's own domain must be a user (or an
// alias of one); addresses outside it are accepted, as Google does for groups
// that allow external members.
func (s *Server) userExistsOrExternal(g DirectoryGroup, email string) bool {
	email = strings.ToLower(email)
	domain := email[strings.LastIndex(email, "@")+1:]
	if !strings.HasSuffix(strings.ToLower(asString(g["email"])), "@"+domain) {
		return true
	}
	for _, u := range s.Users {
		if strings.ToLower(asString(u["primaryEmail"])) == email {
			return true
		}
	}
	for _, o := range s.Groups { // a group can be a member of a group
		if strings.ToLower(asString(o["email"])) == email {
			return true
		}
	}
	return false
}

func (s *Server) listGroups(w http.ResponseWriter, domain, customer, query, token, max string) {
	if domain == "" && customer == "" {
		writeError(w, http.StatusBadRequest, "Bad Request")
		return
	}
	var matched []any
	for _, g := range s.Groups {
		email := strings.ToLower(asString(g["email"]))
		if domain != "" && !strings.HasSuffix(email, "@"+strings.ToLower(domain)) {
			continue
		}
		if !matchesGroupQuery(g, query) {
			continue
		}
		matched = append(matched, g)
	}
	sort.SliceStable(matched, func(a, b int) bool {
		return asString(matched[a].(DirectoryGroup)["email"]) < asString(matched[b].(DirectoryGroup)["email"])
	})
	page, next := s.page(matched, token, max)
	resp := map[string]any{"kind": "admin#directory#groups", "groups": page}
	if next != "" {
		resp["nextPageToken"] = next
	}
	writeJSON(w, http.StatusOK, resp)
}

// matchesGroupQuery understands email:'prefix*' and name:'prefix*' (one clause).
func matchesGroupQuery(g DirectoryGroup, query string) bool {
	field, value, ok := strings.Cut(strings.TrimSpace(query), ":")
	if !ok {
		return true
	}
	value = strings.ToLower(strings.TrimSuffix(strings.Trim(value, "'\""), "*"))
	switch field {
	case "email", "name":
		return strings.HasPrefix(strings.ToLower(asString(g[field])), value)
	}
	return true
}

func (s *Server) page(all []any, token, max string) ([]any, string) {
	start, _ := strconv.Atoi(token)
	size, _ := strconv.Atoi(max)
	size = s.pageSize(size, 200)
	end := min(start+size, len(all))
	page := []any{}
	if start < end {
		page = all[start:end]
	}
	if end < len(all) {
		return page, strconv.Itoa(end)
	}
	return page, ""
}

func hasAnyScope(granted string, wanted ...string) bool {
	for _, have := range strings.Fields(granted) {
		if contains(wanted, have) {
			return true
		}
	}
	return false
}
