package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Google groups and group members (Admin SDK Directory API) on the Directory
// node: how an access request adds someone to a Google group and, later,
// removes them. Add and Remove are idempotent in effect: adding someone who is
// already in the group, or removing someone who is not, answers with
// changed=false instead of Google's 409 / 404. Every operation answers with
// {group, member, role, status, changed}.

const groupAPI = "/admin/directory/v1/groups/"

var groupRoles = []string{"MEMBER", "MANAGER", "OWNER"}

func groupProperties() []landflow.PropertyDescriptor {
	groupGetAll := show("group", "getAll")
	memberGetAll := show("member", "getAll")
	groupPaging := returnAllLimit(groupGetAll, 100, 200)
	memberPaging := returnAllLimit(memberGetAll, 100, 200)
	// Writes are left out of the plugin's MCP tools (mcp false): an agent can read groups, but only a flow node
	// (behind an approval) changes who is in one.
	write := func(o landflow.PropertyOption) landflow.PropertyOption {
		o.MCP = landflow.Ptr(false)
		return o
	}
	return []landflow.PropertyDescriptor{
		operationProperty("group", "get",
			landflow.PropertyOption{Name: "Get", Value: "get", Description: "Get a group by email or id", Action: "Get a group", Idempotent: true},
			landflow.PropertyOption{Name: "Get Many", Value: "getAll", Description: "List the groups of the domain", Action: "Get many groups", Idempotent: true},
		),
		operationProperty("member", "getAll",
			write(landflow.PropertyOption{Name: "Add", Value: "add", Description: "Add a member to a group (a member already in it is returned unchanged)", Action: "Add a member to a group"}),
			landflow.PropertyOption{Name: "Get Many", Value: "getAll", Description: "List the members of a group", Action: "Get many group members", Idempotent: true},
			landflow.PropertyOption{Name: "Has Member", Value: "hasMember", Description: "Whether a person is a member of a group", Action: "Check a group member", Idempotent: true},
			write(landflow.PropertyOption{Name: "Remove", Value: "remove", Description: "Remove a member from a group (a person not in it is returned unchanged)", Action: "Remove a member from a group"}),
			write(landflow.PropertyOption{Name: "Update Role", Value: "updateRole", Description: "Change a member's role in a group", Action: "Update a member's role"}),
		),
		{Name: "groupKey", DisplayName: "Group", Type: landflow.PropString, Default: "", Required: true,
			Placeholder: "team@example.com", Description: "The group's email, alias or id", DisplayOptions: show("group", "get")},
		{Name: "groupKey", DisplayName: "Group", Type: landflow.PropString, Default: "", Required: true,
			Placeholder: "team@example.com", Description: "The group's email, alias or id", DisplayOptions: show("member")},
		{Name: "memberKey", DisplayName: "Member", Type: landflow.PropString, Default: "", Required: true,
			Placeholder: "dana@example.com", Description: "The member's email, alias or id", DisplayOptions: show("member", "add", "remove", "hasMember", "updateRole")},
		{Name: "role", DisplayName: "Role", Type: landflow.PropOptions, Default: "MEMBER",
			Description: "The member's role in the group", DisplayOptions: show("member", "add", "updateRole"),
			Options: []landflow.PropertyOption{
				{Name: "Member", Value: "MEMBER"}, {Name: "Manager", Value: "MANAGER"}, {Name: "Owner", Value: "OWNER"},
			}},
		groupPaging[0], groupPaging[1],
		memberPaging[0], memberPaging[1],
		{Name: "filters", DisplayName: "Filters", Type: landflow.PropCollection, Default: map[string]any{},
			Placeholder: "Add Filter", DisplayOptions: groupGetAll,
			Values: []landflow.PropertyDescriptor{
				{Name: "domain", DisplayName: "Domain", Type: landflow.PropString, Default: "",
					Description: "Only this domain of the account (default: all domains, customer my_customer)"},
				{Name: "query", DisplayName: "Query", Type: landflow.PropString, Default: "", Placeholder: "email:eng*",
					Description: "A Directory group search (https://developers.google.com/workspace/admin/directory/v1/guides/search-groups)"},
			}},
		{Name: "filters", DisplayName: "Filters", Type: landflow.PropCollection, Default: map[string]any{},
			Placeholder: "Add Filter", DisplayOptions: memberGetAll,
			Values: []landflow.PropertyDescriptor{
				{Name: "roles", DisplayName: "Roles", Type: landflow.PropMultiOptions, Default: []any{},
					Description: "Only members with these roles (default: all)",
					Options: []landflow.PropertyOption{
						{Name: "Member", Value: "MEMBER"}, {Name: "Manager", Value: "MANAGER"}, {Name: "Owner", Value: "OWNER"},
					}},
			}},
		simplifyProperty(show("group")),
	}
}

// groupKeyOf reads the group parameter: an email is lowercased (Google ignores case), an id is kept.
func groupKeyOf(ctx *landflow.ExecuteContext, i int) (string, error) {
	key, err := requireParam(ctx, "groupKey", "Group", i)
	return strings.ToLower(key), err
}

func memberKeyOf(ctx *landflow.ExecuteContext, i int) (string, error) {
	key, err := requireParam(ctx, "memberKey", "Member", i)
	return strings.ToLower(key), err
}

func roleOf(ctx *landflow.ExecuteContext, i int) (string, error) {
	role := strings.ToUpper(strings.TrimSpace(ctx.ParamString("role", i, "MEMBER")))
	if role == "" {
		role = "MEMBER"
	}
	if !slices.Contains(groupRoles, role) {
		return "", userError("Pick Member, Manager or Owner.", "Role must be MEMBER, MANAGER or OWNER, not %q", role)
	}
	return role, nil
}

func groupPath(group string, rest ...string) string {
	return groupAPI + url.PathEscape(group) + strings.Join(rest, "")
}

func memberPath(group, member string) string {
	return groupPath(group, "/members/", url.PathEscape(member))
}

// groupFailure rewrites a Directory error from a group call so the item says
// what went wrong in the person's terms: no such group, no such user, or not
// allowed (and which scope and delegation fix it). Anything else passes through.
func groupFailure(err error, scope, group, member string) error {
	var ae *apiError
	if !errors.As(err, &ae) {
		return err
	}
	switch {
	case ae.status == http.StatusNotFound && strings.Contains(ae.message, "memberKey"):
		ae.message = fmt.Sprintf("No user %s (%s)", member, ae.message)
		ae.hint = "Check the member's email: it must be a user (or group) in the Workspace, or an outside address the group accepts."
	case ae.status == http.StatusNotFound:
		ae.message = fmt.Sprintf("No group %s (%s)", group, ae.message)
		ae.hint = "Check the group's email or id, and that the admin being impersonated is in the same Workspace account."
	case ae.status == http.StatusForbidden:
		ae.hint = "Google lets only an admin manage groups. A service account must impersonate a Workspace admin (set Admin to Impersonate) " +
			"and its client ID needs domain-wide delegation for " + scope + ". With OAuth2 the signed-in user must be an admin and grant that scope."
	}
	return ae
}

// isNotFound reports a Directory 404 whose message names what is missing ("memberKey", "groupKey").
func isNotFound(err error, what string) bool {
	var ae *apiError
	return errors.As(err, &ae) && ae.status == http.StatusNotFound && strings.Contains(ae.message, what)
}

// groupOutcome is the one output shape of the member operations.
func groupOutcome(group, member, role, status string, changed bool) map[string]any {
	return map[string]any{"group": group, "member": member, "role": role, "status": status, "changed": changed}
}

func executeGroup(ctx *landflow.ExecuteContext, c *client, i int) ([]map[string]any, error) {
	simple := ctx.ParamBool("simple", i, true)
	switch op := ctx.ParamString("operation", i, "get"); op {
	case "get":
		key, err := groupKeyOf(ctx, i)
		if err != nil {
			return nil, err
		}
		var g map[string]any
		if err := c.do(ctx, apiDirectory, http.MethodGet, groupPath(key), nil, nil, &g); err != nil {
			return nil, groupFailure(err, directoryGroupScope, key, "")
		}
		return []map[string]any{groupShape(g, simple)}, nil
	case "getAll":
		groups, err := listGroups(ctx, c, asMap(ctx.Param("filters", i)), limitFor(ctx, i, 100))
		if err != nil {
			return nil, groupFailure(err, directoryGroupScope, "", "")
		}
		for k, g := range groups {
			groups[k] = groupShape(g, simple)
		}
		return groups, nil
	default:
		return nil, userError("Pick an operation listed for the group resource.", "Unsupported operation %q", op)
	}
}

func groupShape(g map[string]any, simple bool) map[string]any {
	if !simple {
		return g
	}
	return map[string]any{
		"id": g["id"], "email": strings.ToLower(getString(g, "email", "")), "name": g["name"], "description": g["description"],
		"directMembersCount": g["directMembersCount"], "adminCreated": g["adminCreated"], "aliases": g["aliases"],
	}
}

// listGroups pages groups.list (200 a page at most).
func listGroups(ctx *landflow.ExecuteContext, c *client, filters map[string]any, want int) ([]map[string]any, error) {
	var groups []map[string]any
	err := paginate(ctx, "google.directory.groups.list", want, func(cctx context.Context, token string, remaining int) (int, string, error) {
		query := url.Values{"maxResults": {strconv.Itoa(pageSize(remaining, 200))}}
		if domain := strings.TrimSpace(getString(filters, "domain", "")); domain != "" {
			query.Set("domain", domain)
		} else {
			query.Set("customer", "my_customer")
		}
		if q := strings.TrimSpace(getString(filters, "query", "")); q != "" {
			query.Set("query", q)
		}
		if token != "" {
			query.Set("pageToken", token)
		}
		var page struct {
			Groups        []map[string]any `json:"groups"`
			NextPageToken string           `json:"nextPageToken"`
		}
		if err := c.do(cctx, apiDirectory, http.MethodGet, "/admin/directory/v1/groups", query, nil, &page); err != nil {
			return 0, "", err
		}
		if remaining >= 0 && len(page.Groups) > remaining {
			page.Groups = page.Groups[:remaining]
		}
		groups = append(groups, page.Groups...)
		return len(page.Groups), page.NextPageToken, nil
	})
	return groups, err
}

func executeMember(ctx *landflow.ExecuteContext, c *client, i int) ([]map[string]any, error) {
	op := ctx.ParamString("operation", i, "getAll")
	group, err := groupKeyOf(ctx, i)
	if err != nil {
		return nil, err
	}
	scope := directoryMemberScope
	fail := func(err error, member string) error { return groupFailure(err, scope, group, member) }
	if op == "getAll" {
		members, err := listMembers(ctx, c, group, ctx.Param("filters", i), limitFor(ctx, i, 100))
		if err != nil {
			return nil, fail(err, "")
		}
		out := make([]map[string]any, 0, len(members))
		for _, m := range members {
			o := groupOutcome(group, strings.ToLower(getString(m, "email", "")), getString(m, "role", ""), getString(m, "status", ""), false)
			o["type"], o["id"] = m["type"], m["id"]
			out = append(out, o)
		}
		return out, nil
	}
	if !slices.Contains([]string{"add", "remove", "hasMember", "updateRole"}, op) {
		return nil, userError("Pick an operation listed for the group member resource.", "Unsupported operation %q", op)
	}
	member, err := memberKeyOf(ctx, i)
	if err != nil {
		return nil, err
	}
	// getMember reads the current membership: nil when the person is not in the group.
	getMember := func() (map[string]any, error) {
		var m map[string]any
		err := c.do(ctx, apiDirectory, http.MethodGet, memberPath(group, member), nil, nil, &m)
		if isNotFound(err, "memberKey") {
			return nil, nil
		}
		return m, err
	}
	switch op {
	case "hasMember":
		var res struct {
			IsMember bool `json:"isMember"`
		}
		if err := c.do(ctx, apiDirectory, http.MethodGet, groupPath(group, "/hasMember/", url.PathEscape(member)), nil, nil, &res); err != nil {
			return nil, fail(err, member)
		}
		status := "not_member"
		if res.IsMember {
			status = "member"
		}
		o := groupOutcome(group, member, "", status, false)
		o["isMember"] = res.IsMember
		return []map[string]any{o}, nil
	case "add":
		role, err := roleOf(ctx, i)
		if err != nil {
			return nil, err
		}
		var m map[string]any
		err = c.do(ctx, apiDirectory, http.MethodPost, groupPath(group, "/members"), nil, map[string]any{"email": member, "role": role}, &m)
		var ae *apiError
		if errors.As(err, &ae) && ae.status == http.StatusConflict {
			// Already in the group: report what is there, change nothing (a different role is Update Role's job).
			if m, err = getMember(); err == nil && m != nil {
				return []map[string]any{groupOutcome(group, member, getString(m, "role", role), "already_member", false)}, nil
			}
			if err == nil {
				err = ae
			}
		}
		if err != nil {
			return nil, fail(err, member)
		}
		return []map[string]any{groupOutcome(group, member, getString(m, "role", role), "added", true)}, nil
	case "remove":
		m, err := getMember()
		if err != nil {
			return nil, fail(err, member)
		}
		if m == nil {
			return []map[string]any{groupOutcome(group, member, "", "not_member", false)}, nil
		}
		if err := c.do(ctx, apiDirectory, http.MethodDelete, memberPath(group, member), nil, nil, nil); err != nil && !isNotFound(err, "memberKey") {
			return nil, fail(err, member)
		}
		return []map[string]any{groupOutcome(group, member, getString(m, "role", ""), "removed", true)}, nil
	default: // updateRole
		role, err := roleOf(ctx, i)
		if err != nil {
			return nil, err
		}
		m, err := getMember()
		if err != nil {
			return nil, fail(err, member)
		}
		if m == nil {
			return nil, userError("Add them first (Group Member → Add).", "%s is not a member of %s", member, group)
		}
		if getString(m, "role", "") == role {
			return []map[string]any{groupOutcome(group, member, role, "unchanged", false)}, nil
		}
		if err := c.do(ctx, apiDirectory, http.MethodPatch, memberPath(group, member), nil, map[string]any{"role": role}, &m); err != nil {
			return nil, fail(err, member)
		}
		return []map[string]any{groupOutcome(group, member, getString(m, "role", role), "updated", true)}, nil
	}
}

// rolesFilter reads Filters → Roles (a list, or a comma-separated string) as the API's roles parameter.
func rolesFilter(filters any) string {
	f := asMap(filters)
	var roles []string
	switch v := f["roles"].(type) {
	case []any:
		for _, r := range v {
			roles = append(roles, strings.ToUpper(strings.TrimSpace(fmt.Sprint(r))))
		}
	case string:
		for _, r := range strings.Split(v, ",") {
			if r = strings.ToUpper(strings.TrimSpace(r)); r != "" {
				roles = append(roles, r)
			}
		}
	}
	return strings.Join(roles, ",")
}

// listMembers pages members.list (200 a page at most), optionally only some roles.
func listMembers(ctx *landflow.ExecuteContext, c *client, group string, filters any, want int) ([]map[string]any, error) {
	roles := rolesFilter(filters)
	var members []map[string]any
	err := paginate(ctx, "google.directory.members.list", want, func(cctx context.Context, token string, remaining int) (int, string, error) {
		query := url.Values{"maxResults": {strconv.Itoa(pageSize(remaining, 200))}}
		if roles != "" {
			query.Set("roles", roles)
		}
		if token != "" {
			query.Set("pageToken", token)
		}
		var page struct {
			Members       []map[string]any `json:"members"`
			NextPageToken string           `json:"nextPageToken"`
		}
		if err := c.do(cctx, apiDirectory, http.MethodGet, groupPath(group, "/members"), query, nil, &page); err != nil {
			return 0, "", err
		}
		if remaining >= 0 && len(page.Members) > remaining {
			page.Members = page.Members[:remaining]
		}
		members = append(members, page.Members...)
		return len(page.Members), page.NextPageToken, nil
	})
	return members, err
}
