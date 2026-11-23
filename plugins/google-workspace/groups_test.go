package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/landflow/landflow/plugins/google-workspace/internal/fakegoogle"
)

// ---------------------------------------------------------------------------
// Directory: groups and group members (access grants), all against the fake
// ---------------------------------------------------------------------------

const adminEmail = "admin@example.com"

func groupHarness(t *testing.T) *harness {
	h := newHarness(t)
	directoryUsers(h)
	h.fake.DirectoryAdmins = []string{adminEmail}
	for _, g := range []fakegoogle.DirectoryGroup{
		{"id": "g1", "email": "eng@example.com", "name": "Engineering", "description": "All engineers"},
		{"id": "g2", "email": "sales@example.com", "name": "Sales"},
		{"id": "g3", "email": "ops@other.org", "name": "Ops"},
	} {
		h.fake.AddDirectoryGroup(g)
	}
	h.fake.AddDirectoryMember("eng@example.com", fakegoogle.DirectoryMember{"email": "lee@example.com", "role": "OWNER"})
	h.fake.AddDirectoryMember("eng@example.com", fakegoogle.DirectoryMember{"email": "ana@example.com", "role": "MEMBER"})
	return h
}

func groupParams(resource, op string, extra map[string]any) map[string]any {
	p := map[string]any{"resource": resource, "operation": op, "adminEmail": adminEmail}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func TestGroupGet(t *testing.T) {
	h := groupHarness(t)
	for _, key := range []string{"eng@example.com", "g1", " ENG@example.com "} {
		out := h.ok(h.exec("googleDirectory", groupParams("group", "get", map[string]any{"groupKey": key}), execOpts{}))
		if len(out) != 1 || out[0]["email"] != "eng@example.com" || out[0]["name"] != "Engineering" || out[0]["id"] != "g1" ||
			out[0]["description"] != "All engineers" || out[0]["directMembersCount"] != "2" {
			t.Errorf("get %q = %v", key, out)
		}
	}
	// The token asks for the group scope alone, acting as the admin.
	ex := h.fake.ExchangeList()
	if ex[0].Claims["scope"] != directoryGroupScope || ex[0].Claims["sub"] != adminEmail {
		t.Errorf("claims = %v", ex[0].Claims)
	}
	// Simplify off: Google's own resource.
	raw := h.ok(h.exec("googleDirectory", groupParams("group", "get", map[string]any{"groupKey": "g1", "simple": false}), execOpts{}))
	if raw[0]["id"] != "g1" || raw[0]["description"] != "All engineers" {
		t.Errorf("raw = %v", raw)
	}
}

func TestGroupGetErrors(t *testing.T) {
	h := groupHarness(t)
	resp := h.exec("googleDirectory", groupParams("group", "get", map[string]any{"groupKey": "nope@example.com"}), execOpts{})
	if text := errorText(resp); resp.Error == nil || !strings.Contains(text, "No group nope@example.com") || !strings.Contains(text, "404") {
		t.Errorf("not found = %q", text)
	}
	resp = h.exec("googleDirectory", groupParams("group", "get", map[string]any{"groupKey": ""}), execOpts{})
	if resp.Error == nil || !strings.Contains(errorText(resp), "Group is required") {
		t.Errorf("no key = %+v", resp.Error)
	}
	// Not an admin: the error names the scope and the delegation.
	p := groupParams("group", "get", map[string]any{"groupKey": "g1", "adminEmail": "me@example.com"})
	resp = h.exec("googleDirectory", p, execOpts{})
	text := errorText(resp)
	if resp.Error == nil || !strings.Contains(text, "403") || !strings.Contains(text, directoryGroupScope) || !strings.Contains(text, "admin") {
		t.Errorf("403 = %q", text)
	}
}

func TestGroupGetMany(t *testing.T) {
	h := groupHarness(t)
	h.fake.PageSize = 1
	all := h.ok(h.exec("googleDirectory", groupParams("group", "getAll", map[string]any{"returnAll": true}), execOpts{}))
	if len(all) != 3 || all[0]["email"] != "eng@example.com" || all[2]["email"] != "sales@example.com" {
		t.Errorf("all = %v", all)
	}
	if calls := h.fake.Calls("GET", "/admin/directory/v1/groups"); len(calls) != 3 || calls[0].Query.Get("customer") != "my_customer" {
		t.Errorf("calls = %v", calls)
	}
	dom := h.ok(h.exec("googleDirectory", groupParams("group", "getAll", map[string]any{"returnAll": true, "filters": map[string]any{"domain": "other.org"}}), execOpts{}))
	if len(dom) != 1 || dom[0]["email"] != "ops@other.org" {
		t.Errorf("domain = %v", dom)
	}
	q := h.ok(h.exec("googleDirectory", groupParams("group", "getAll", map[string]any{"returnAll": true, "filters": map[string]any{"query": "email:sa*"}}), execOpts{}))
	if len(q) != 1 || q[0]["email"] != "sales@example.com" {
		t.Errorf("query = %v", q)
	}
	two := h.ok(h.exec("googleDirectory", groupParams("group", "getAll", map[string]any{"limit": 2}), execOpts{}))
	if len(two) != 2 {
		t.Errorf("limit = %v", two)
	}
}

func TestMemberAdd(t *testing.T) {
	h := groupHarness(t)
	add := func(group, member, role string) map[string]any {
		t.Helper()
		out := h.ok(h.exec("googleDirectory", groupParams("member", "add", map[string]any{"groupKey": group, "memberKey": member, "role": role}), execOpts{}))
		if len(out) != 1 {
			t.Fatalf("add = %v", out)
		}
		return out[0]
	}
	got := add("eng@example.com", "Dana@Example.com", "MANAGER")
	if got["group"] != "eng@example.com" || got["member"] != "dana@example.com" || got["role"] != "MANAGER" || got["status"] != "added" || got["changed"] != true {
		t.Errorf("added = %v", got)
	}
	if m := h.fake.DirectoryMembers("g1"); m["dana@example.com"] != "MANAGER" || len(m) != 3 {
		t.Errorf("fake members = %v", m)
	}
	ex := h.fake.ExchangeList()
	if ex[len(ex)-1].Claims["scope"] != directoryMemberScope {
		t.Errorf("scope = %v", ex[len(ex)-1].Claims["scope"])
	}

	// Default role is MEMBER.
	out := h.ok(h.exec("googleDirectory", groupParams("member", "add", map[string]any{"groupKey": "g1", "memberKey": "kim@example.com"}), execOpts{}))
	if out[0]["role"] != "MEMBER" || out[0]["changed"] != true {
		t.Errorf("default role = %v", out)
	}

	// Again: the existing member comes back, nothing changed, no error (the 409 is absorbed).
	again := add("eng@example.com", "dana@example.com", "MEMBER")
	if again["changed"] != false || again["status"] != "already_member" || again["role"] != "MANAGER" || again["member"] != "dana@example.com" {
		t.Errorf("again = %v", again)
	}
	if m := h.fake.DirectoryMembers("g1"); m["dana@example.com"] != "MANAGER" {
		t.Errorf("role was changed by a repeated add: %v", m)
	}

	// An address outside the domain is accepted.
	if ext := add("g1", "guest@partner.io", "MEMBER"); ext["status"] != "added" {
		t.Errorf("external = %v", ext)
	}
}

func TestMemberAddErrors(t *testing.T) {
	h := groupHarness(t)
	resp := h.exec("googleDirectory", groupParams("member", "add", map[string]any{"groupKey": "nope@example.com", "memberKey": "dana@example.com"}), execOpts{})
	if text := errorText(resp); resp.Error == nil || !strings.Contains(text, "No group nope@example.com") {
		t.Errorf("no group = %q", text)
	}
	resp = h.exec("googleDirectory", groupParams("member", "add", map[string]any{"groupKey": "g1", "memberKey": "ghost@example.com"}), execOpts{})
	if text := errorText(resp); resp.Error == nil || !strings.Contains(text, "No user ghost@example.com") {
		t.Errorf("no user = %q", text)
	}
	resp = h.exec("googleDirectory", groupParams("member", "add", map[string]any{"groupKey": "g1", "memberKey": ""}), execOpts{})
	if resp.Error == nil || !strings.Contains(errorText(resp), "Member is required") {
		t.Errorf("no member = %+v", resp.Error)
	}
	resp = h.exec("googleDirectory", groupParams("member", "add", map[string]any{"groupKey": "g1", "memberKey": "dana@example.com", "role": "BOSS"}), execOpts{})
	if resp.Error == nil || !strings.Contains(errorText(resp), "MEMBER, MANAGER or OWNER") {
		t.Errorf("bad role = %+v", resp.Error)
	}
	// Not an admin.
	resp = h.exec("googleDirectory", groupParams("member", "add", map[string]any{"groupKey": "g1", "memberKey": "dana@example.com", "adminEmail": "me@example.com"}), execOpts{})
	text := errorText(resp)
	if resp.Error == nil || !strings.Contains(text, directoryMemberScope) || !strings.Contains(text, "domain-wide delegation") {
		t.Errorf("403 = %q", text)
	}
	if len(h.fake.DirectoryMembers("g1")) != 2 {
		t.Error("a failed add changed the group")
	}
}

func TestMemberRemove(t *testing.T) {
	h := groupHarness(t)
	rm := func(group, member string) map[string]any {
		t.Helper()
		out := h.ok(h.exec("googleDirectory", groupParams("member", "remove", map[string]any{"groupKey": group, "memberKey": member}), execOpts{}))
		return out[0]
	}
	got := rm("eng@example.com", "ANA@example.com")
	if got["group"] != "eng@example.com" || got["member"] != "ana@example.com" || got["status"] != "removed" || got["changed"] != true || got["role"] != "MEMBER" {
		t.Errorf("removed = %v", got)
	}
	if m := h.fake.DirectoryMembers("g1"); len(m) != 1 || m["ana@example.com"] != "" {
		t.Errorf("fake members = %v", m)
	}
	// Removing someone who is not a member is not an error.
	again := rm("eng@example.com", "ana@example.com")
	if again["changed"] != false || again["status"] != "not_member" {
		t.Errorf("again = %v", again)
	}
	// But a missing group is.
	resp := h.exec("googleDirectory", groupParams("member", "remove", map[string]any{"groupKey": "nope@example.com", "memberKey": "ana@example.com"}), execOpts{})
	if text := errorText(resp); resp.Error == nil || !strings.Contains(text, "No group nope@example.com") {
		t.Errorf("no group = %q", text)
	}
	resp = h.exec("googleDirectory", groupParams("member", "remove", map[string]any{"groupKey": "g1", "memberKey": "lee@example.com", "adminEmail": "me@example.com"}), execOpts{})
	if text := errorText(resp); resp.Error == nil || !strings.Contains(text, directoryMemberScope) {
		t.Errorf("403 = %q", text)
	}
}

func TestMemberGetMany(t *testing.T) {
	h := groupHarness(t)
	h.fake.AddDirectoryMember("g1", fakegoogle.DirectoryMember{"email": "dana@example.com", "role": "MANAGER"})
	h.fake.PageSize = 1
	all := h.ok(h.exec("googleDirectory", groupParams("member", "getAll", map[string]any{"groupKey": "eng@example.com", "returnAll": true}), execOpts{}))
	if len(all) != 3 {
		t.Fatalf("all = %v", all)
	}
	first := all[0]
	if first["group"] != "eng@example.com" || first["member"] != "lee@example.com" || first["role"] != "OWNER" || first["status"] != "ACTIVE" || first["changed"] != false {
		t.Errorf("first = %v", first)
	}
	managers := h.ok(h.exec("googleDirectory", groupParams("member", "getAll",
		map[string]any{"groupKey": "g1", "returnAll": true, "filters": map[string]any{"roles": []any{"MANAGER", "OWNER"}}}), execOpts{}))
	if len(managers) != 2 || managers[0]["role"] == "MEMBER" || managers[1]["role"] == "MEMBER" {
		t.Errorf("roles = %v", managers)
	}
	one := h.ok(h.exec("googleDirectory", groupParams("member", "getAll", map[string]any{"groupKey": "g1", "limit": 1}), execOpts{}))
	if len(one) != 1 {
		t.Errorf("limit = %v", one)
	}
	resp := h.exec("googleDirectory", groupParams("member", "getAll", map[string]any{"groupKey": "nope@example.com"}), execOpts{})
	if resp.Error == nil || !strings.Contains(errorText(resp), "No group") {
		t.Errorf("no group = %+v", resp.Error)
	}
}

func TestMemberHasMember(t *testing.T) {
	h := groupHarness(t)
	yes := h.ok(h.exec("googleDirectory", groupParams("member", "hasMember", map[string]any{"groupKey": "eng@example.com", "memberKey": "Ana@example.com"}), execOpts{}))[0]
	if yes["isMember"] != true || yes["status"] != "member" || yes["changed"] != false || yes["group"] != "eng@example.com" || yes["member"] != "ana@example.com" {
		t.Errorf("yes = %v", yes)
	}
	no := h.ok(h.exec("googleDirectory", groupParams("member", "hasMember", map[string]any{"groupKey": "g1", "memberKey": "kim@example.com"}), execOpts{}))[0]
	if no["isMember"] != false || no["status"] != "not_member" {
		t.Errorf("no = %v", no)
	}
	resp := h.exec("googleDirectory", groupParams("member", "hasMember", map[string]any{"groupKey": "nope@example.com", "memberKey": "kim@example.com"}), execOpts{})
	if resp.Error == nil || !strings.Contains(errorText(resp), "No group") {
		t.Errorf("no group = %+v", resp.Error)
	}
}

func TestMemberUpdateRole(t *testing.T) {
	h := groupHarness(t)
	up := h.ok(h.exec("googleDirectory", groupParams("member", "updateRole", map[string]any{"groupKey": "eng@example.com", "memberKey": "ana@example.com", "role": "MANAGER"}), execOpts{}))[0]
	if up["role"] != "MANAGER" || up["status"] != "updated" || up["changed"] != true || up["member"] != "ana@example.com" {
		t.Errorf("updated = %v", up)
	}
	if m := h.fake.DirectoryMembers("g1"); m["ana@example.com"] != "MANAGER" {
		t.Errorf("fake = %v", m)
	}
	same := h.ok(h.exec("googleDirectory", groupParams("member", "updateRole", map[string]any{"groupKey": "g1", "memberKey": "ana@example.com", "role": "MANAGER"}), execOpts{}))[0]
	if same["changed"] != false || same["status"] != "unchanged" {
		t.Errorf("same = %v", same)
	}
	if n := len(h.fake.Calls("PATCH", "/admin/directory/v1/groups")); n != 1 {
		t.Errorf("patches = %d, want 1 (an unchanged role sends nothing)", n)
	}
	resp := h.exec("googleDirectory", groupParams("member", "updateRole", map[string]any{"groupKey": "g1", "memberKey": "kim@example.com", "role": "MEMBER"}), execOpts{})
	if text := errorText(resp); resp.Error == nil || !strings.Contains(text, "kim@example.com is not a member of g1") {
		t.Errorf("not a member = %q", text)
	}
}

// Writes stay out of the plugin's MCP tools, so an agent cannot grant access on its own;
// the reads are there.
func TestGroupWritesAreNotAgentTools(t *testing.T) {
	tools := mcpTools(t)
	for _, name := range []string{"googleDirectory_member_add", "googleDirectory_member_remove", "googleDirectory_member_updateRole"} {
		if _, ok := tools[name]; ok {
			t.Errorf("%s is offered as a tool", name)
		}
	}
	for _, name := range []string{"googleDirectory_group_get", "googleDirectory_group_getAll", "googleDirectory_member_getAll", "googleDirectory_member_hasMember"} {
		if hint, ok := tools[name]; !ok || !hint {
			t.Errorf("%s: listed=%v idempotentHint=%v", name, ok, hint)
		}
	}
}

// The standalone fake's control endpoint seeds a group while a flow runs.
func TestFakeGroupEndpoint(t *testing.T) {
	h := newHarness(t)
	h.fake.DirectoryAdmins = []string{adminEmail}
	resp, err := http.Post(h.url+"/_fake/directory/groups", "application/json",
		strings.NewReader(`{"email":"devs@example.com","name":"Devs","members":[{"email":"x@partner.io","role":"OWNER"}]}`))
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("POST: %v %v", err, resp)
	}
	resp.Body.Close()
	out := h.ok(h.exec("googleDirectory", groupParams("member", "getAll", map[string]any{"groupKey": "devs@example.com"}), execOpts{}))
	if len(out) != 1 || out[0]["member"] != "x@partner.io" || out[0]["role"] != "OWNER" {
		t.Errorf("members = %v", out)
	}
}
