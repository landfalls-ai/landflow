package main

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// DirectoryNode reads the Workspace user directory (Admin SDK Directory API):
// every person's email, org unit, title, department and manager, the identity
// key that joins activity from other tools. Read-only.
//
// A service account must impersonate an admin (domain-wide delegation for the
// directory scope below); the node asks for that scope alone, so the scopes
// already delegated for the other Google nodes need not change.
type DirectoryNode struct{}

const directoryScope = "https://www.googleapis.com/auth/admin.directory.user.readonly"

func (DirectoryNode) Description() landflow.NodeDescriptor {
	getAll := show("user", "getAll")
	paging := returnAllLimit(getAll, 100, 500)
	return landflow.NodeDescriptor{
		Name:             "googleDirectory",
		DisplayName:      "Google Directory",
		Description:      "List and look up the people in your Google Workspace: email, org unit, title, department and manager",
		Version:          landflow.V(1),
		Kind:             landflow.KindAction,
		Categories:       []string{"Productivity"},
		Icon:             "file:icons/google-workspace.svg",
		Color:            "#4285F4",
		Subtitle:         "{{operation}}: {{resource}}",
		Inputs:           []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		DocumentationURL: "https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/list",
		Keywords:         []string{"directory", "users", "people", "employees", "org chart", "manager", "admin"},
		Credentials:      credentialRequirements(),
		UsableAsTool:     true,
		ToolDescription: "Read the Google Workspace directory. resource=user: getAll lists people (filters.orgUnitPath, filters.query, " +
			"filters.domain) with email, name, orgUnitPath, title, department and managerEmail; get returns one by userKey (email or id).",
		Properties: []landflow.PropertyDescriptor{
			authProperty(),
			resourceProperty("user", landflow.PropertyOption{Name: "User", Value: "user"}),
			operationProperty("user", "getAll",
				landflow.PropertyOption{Name: "Get", Value: "get", Description: "Get one person by email or id", Action: "Get a user", Idempotent: true},
				landflow.PropertyOption{Name: "Get Many", Value: "getAll", Description: "List the people in the directory", Action: "Get many users", Idempotent: true},
			),
			{Name: "adminEmail", DisplayName: "Admin to Impersonate", Type: landflow.PropString, Default: "",
				Placeholder: "admin@example.com",
				Description: "Service account only: an admin the service account acts as (domain-wide delegation for " + directoryScope + "). Empty: the credential's Delegated Email."},
			{Name: "userKey", DisplayName: "User", Type: landflow.PropString, Default: "", Required: true,
				Placeholder: "dana@example.com", Description: "Primary email, alias or user id", DisplayOptions: show("user", "get")},
			paging[0],
			paging[1],
			{Name: "filters", DisplayName: "Filters", Type: landflow.PropCollection, Default: map[string]any{},
				Placeholder: "Add Filter", DisplayOptions: getAll,
				Values: []landflow.PropertyDescriptor{
					{Name: "domain", DisplayName: "Domain", Type: landflow.PropString, Default: "",
						Description: "Only this domain of the account (default: all domains, customer my_customer)"},
					{Name: "orgUnitPath", DisplayName: "Org Unit", Type: landflow.PropString, Default: "", Placeholder: "/Engineering",
						Description: "Only people in this org unit or below it"},
					{Name: "showSuspended", DisplayName: "Include Suspended", Type: landflow.PropBoolean, Default: false},
					{Name: "query", DisplayName: "Query", Type: landflow.PropString, Default: "", Placeholder: "orgTitle:Engineer",
						Description: "More Directory search clauses (https://developers.google.com/workspace/admin/directory/v1/guides/search-users)"},
				}},
			simplifyProperty(show("user")),
		},
	}
}

func (DirectoryNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	items := ctx.InputData(0)
	if len(items) == 0 {
		return nil, nil
	}
	auth := ctx.ParamString("authentication", 0, "serviceAccount")
	c, err := newClient(ctx, auth)
	if err != nil {
		return nil, err
	}
	c.ts.narrow([]string{directoryScope}, ctx.ParamString("adminEmail", 0, ""))
	if c.ts.kind == authServiceAccount && c.ts.subject == "" {
		return nil, userError("Reading the directory needs an admin: set Admin to Impersonate, or the credential's Delegated Email, and authorize "+
			directoryScope+" for the service account's client ID under domain-wide delegation.", "No admin to impersonate")
	}
	var out []landflow.Item
	for i := range items {
		var results []map[string]any
		switch op := ctx.ParamString("operation", i, "getAll"); op {
		case "getAll":
			results, err = listDirectoryUsers(ctx, c, asMap(ctx.Param("filters", i)), limitFor(ctx, i, 100))
		case "get":
			var key string
			if key, err = requireParam(ctx, "userKey", "User", i); err == nil {
				var u map[string]any
				err = c.do(ctx, apiDirectory, http.MethodGet, "/admin/directory/v1/users/"+url.PathEscape(strings.TrimSpace(key)),
					url.Values{"projection": {"full"}, "viewType": {"admin_view"}}, nil, &u)
				results = []map[string]any{u}
			}
		default:
			err = userError("Pick an operation listed for the user resource.", "Unsupported operation %q", op)
		}
		if err == nil && ctx.ParamBool("simple", i, true) {
			for k, u := range results {
				results[k] = directoryPerson(u)
			}
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

// listDirectoryUsers pages users.list (500 a page at most).
func listDirectoryUsers(ctx *landflow.ExecuteContext, c *client, filters map[string]any, want int) ([]map[string]any, error) {
	var clauses []string
	if ou := strings.TrimSpace(getString(filters, "orgUnitPath", "")); ou != "" {
		clauses = append(clauses, "orgUnitPath='"+strings.ReplaceAll(ou, "'", `\'`)+"'")
	}
	if !getBool(filters, "showSuspended", false) {
		clauses = append(clauses, "isSuspended=false")
	}
	if q := strings.TrimSpace(getString(filters, "query", "")); q != "" {
		clauses = append(clauses, q)
	}
	var users []map[string]any
	err := paginate(ctx, "google.directory.users.list", want, func(cctx context.Context, token string, remaining int) (int, string, error) {
		query := url.Values{"maxResults": {strconv.Itoa(pageSize(remaining, 500))}, "projection": {"full"}, "viewType": {"admin_view"}, "orderBy": {"email"}}
		if domain := strings.TrimSpace(getString(filters, "domain", "")); domain != "" {
			query.Set("domain", domain)
		} else {
			query.Set("customer", "my_customer")
		}
		if len(clauses) > 0 {
			query.Set("query", strings.Join(clauses, " "))
		}
		if token != "" {
			query.Set("pageToken", token)
		}
		var page struct {
			Users         []map[string]any `json:"users"`
			NextPageToken string           `json:"nextPageToken"`
		}
		if err := c.do(cctx, apiDirectory, http.MethodGet, "/admin/directory/v1/users", query, nil, &page); err != nil {
			return 0, "", err
		}
		if remaining >= 0 && len(page.Users) > remaining {
			page.Users = page.Users[:remaining]
		}
		users = append(users, page.Users...)
		return len(page.Users), page.NextPageToken, nil
	})
	return users, err
}

// directoryPerson is a user's flat, simplified shape: the primary (else first)
// organization's title and department, the manager from relations.
func directoryPerson(u map[string]any) map[string]any {
	name := asMap(u["name"])
	var org map[string]any
	for _, o := range asSlice(u["organizations"]) {
		if m := asMap(o); org == nil || getBool(m, "primary", false) {
			org = m
		}
	}
	manager := ""
	for _, r := range asSlice(u["relations"]) {
		if m := asMap(r); getString(m, "type", "") == "manager" {
			manager = getString(m, "value", "")
			break
		}
	}
	return map[string]any{
		"id":            u["id"],
		"email":         strings.ToLower(getString(u, "primaryEmail", "")),
		"name":          firstNonEmpty(getString(name, "fullName", ""), strings.TrimSpace(getString(name, "givenName", "")+" "+getString(name, "familyName", ""))),
		"orgUnitPath":   u["orgUnitPath"],
		"title":         getString(org, "title", ""),
		"department":    getString(org, "department", ""),
		"managerEmail":  strings.ToLower(manager),
		"suspended":     getBool(u, "suspended", false),
		"archived":      getBool(u, "archived", false),
		"isAdmin":       getBool(u, "isAdmin", false),
		"aliases":       u["aliases"],
		"lastLoginTime": u["lastLoginTime"],
		"creationTime":  u["creationTime"],
	}
}
