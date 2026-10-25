"""Jira Software: issues (create, get, search, update, transition) and comments, on Cloud (REST v3) or Server / Data Center (REST v2)."""

from __future__ import annotations

import base64
import re
from typing import Any
from urllib.parse import quote

from landflow_sdk import CredentialType, Node, NodeOperationError

from .common import (
    Api,
    bool_param,
    collection,
    count_written,
    item_errors,
    items_of,
    limit_of,
    operation_property,
    out,
    outs,
    parse_json,
    resource_property,
    return_all_properties,
    simplify_property,
    split_list,
    test_call,
    text_param,
)

PAGE_SIZE = 100
CLOUD, SERVER = "cloud", "serverPat"
CREDENTIAL_FOR = {CLOUD: "jiraSoftwareCloudApi", SERVER: "jiraSoftwareServerPatApi"}


def normalize_domain(domain: Any) -> str:
    text = str(domain or "").strip().rstrip("/")
    if text and not re.match(r"^https?://", text, re.IGNORECASE):
        text = f"https://{text}"
    return text


def cloud_api(ctx: Any, creds: dict[str, Any]) -> Api:
    token = base64.b64encode(f"{creds.get('email', '')}:{creds.get('apiToken', '')}".encode()).decode("ascii")
    return Api(ctx, "jira", normalize_domain(creds.get("domain")), {"Authorization": f"Basic {token}", "Accept": "application/json"})


def server_api(ctx: Any, creds: dict[str, Any]) -> Api:
    return Api(ctx, "jira", normalize_domain(creds.get("domain")), {"Authorization": f"Bearer {creds.get('personalAccessToken', '')}", "Accept": "application/json"})


def _test(api: Api, path: str) -> tuple[bool, str]:
    if not api.base_url:
        return False, "Set the Jira domain, e.g. https://your-domain.atlassian.net"
    ok, reason, me = test_call(api, path)
    if not ok:
        return False, reason or "Jira rejected the credentials"
    return True, f"authenticated as {me.get('displayName') or me.get('name') or me.get('accountId')}" if isinstance(me, dict) else "authenticated"


def test_cloud(data: dict[str, Any], ctx: Any) -> tuple[bool, str]:
    return _test(cloud_api(ctx, data), "/rest/api/3/myself")


def test_server(data: dict[str, Any], ctx: Any) -> tuple[bool, str]:
    return _test(server_api(ctx, data), "/rest/api/2/myself")


JIRA_CLOUD_API = CredentialType(
    name="jiraSoftwareCloudApi",
    display_name="Jira SW Cloud API",
    documentation_url="https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/",
    description="Your Atlassian account email and an API token (Basic auth).",
    test=test_cloud,
    properties=[
        {"name": "email", "displayName": "Email", "type": "string", "required": True, "placeholder": "name@example.com"},
        {"name": "apiToken", "displayName": "API Token", "type": "string", "required": True, "typeOptions": {"password": True}},
        {"name": "domain", "displayName": "Domain", "type": "string", "required": True, "default": "",
         "placeholder": "https://your-domain.atlassian.net"},
    ],
)

JIRA_SERVER_PAT_API = CredentialType(
    name="jiraSoftwareServerPatApi",
    display_name="Jira SW Server (PAT) API",
    documentation_url="https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html",
    description="Jira Server / Data Center 8.14+ with a personal access token (Bearer auth).",
    test=test_server,
    properties=[
        {"name": "domain", "displayName": "Domain", "type": "string", "required": True, "default": "",
         "placeholder": "https://jira.example.com"},
        {"name": "personalAccessToken", "displayName": "Personal Access Token", "type": "string", "required": True,
         "typeOptions": {"password": True}},
    ],
)


class Jira:
    """One Jira deployment: the API client plus the REST version and the description format."""

    def __init__(self, ctx: Any, version: str) -> None:
        if version not in CREDENTIAL_FOR:
            raise NodeOperationError(f"Unknown Jira version {version!r}")
        self.cloud = version == CLOUD
        creds = ctx.get_credentials(CREDENTIAL_FOR[version])
        self.api = cloud_api(ctx, creds) if self.cloud else server_api(ctx, creds)
        self.rest = "/rest/api/3" if self.cloud else "/rest/api/2"

    def text(self, value: str) -> Any:
        """Cloud (v3) takes rich text as ADF; Server (v2) takes wiki-markup strings."""
        return text_to_adf(value) if self.cloud else value


# --------------------------------------------------------------------- ADF


def text_to_adf(text: str) -> dict[str, Any]:
    """Plain text -> an Atlassian Document: one paragraph per blank-line separated block, line breaks kept."""
    content = []
    for paragraph in re.split(r"\n\s*\n", (text or "").replace("\r\n", "\n")):
        lines = [line for line in paragraph.strip("\n").split("\n")]
        if not "".join(lines).strip():
            continue
        nodes: list[dict[str, Any]] = []
        for n, line in enumerate(lines):
            if n:
                nodes.append({"type": "hardBreak"})
            if line:
                nodes.append({"type": "text", "text": line})
        content.append({"type": "paragraph", "content": nodes})
    return {"type": "doc", "version": 1, "content": content}


def adf_to_text(node: Any) -> str:
    """An Atlassian Document (or a v2 string) -> plain text."""
    if node is None or isinstance(node, str):
        return node or ""
    if not isinstance(node, dict):
        return str(node)
    kind = node.get("type")
    if kind == "text":
        return node.get("text", "")
    if kind == "hardBreak":
        return "\n"
    if kind in ("mention", "emoji"):
        return (node.get("attrs") or {}).get("text") or ""
    inner = "".join(adf_to_text(child) for child in node.get("content") or [])
    if kind == "doc":
        return "\n".join(adf_to_text(child) for child in node.get("content") or []).strip()
    if kind == "listItem":
        return f"- {inner}"
    if kind in ("bulletList", "orderedList"):
        return "\n".join(adf_to_text(child) for child in node.get("content") or [])
    return inner


def _name(value: Any, *keys: str) -> Any:
    if not isinstance(value, dict):
        return value
    return next((value[k] for k in keys if value.get(k) not in (None, "")), None)


def simplify_issue(issue: dict[str, Any]) -> dict[str, Any]:
    fields = issue.get("fields") or {}
    return {
        "id": issue.get("id"),
        "key": issue.get("key"),
        "self": issue.get("self"),
        "summary": fields.get("summary"),
        "status": _name(fields.get("status"), "name"),
        "issueType": _name(fields.get("issuetype"), "name"),
        "priority": _name(fields.get("priority"), "name"),
        "project": _name(fields.get("project"), "key"),
        "assignee": _name(fields.get("assignee"), "displayName", "name", "accountId"),
        "reporter": _name(fields.get("reporter"), "displayName", "name", "accountId"),
        "labels": fields.get("labels") or [],
        "created": fields.get("created"),
        "updated": fields.get("updated"),
        "description": adf_to_text(fields.get("description")),
    }


# -------------------------------------------------------------------- node

ISSUE = {"resource": ["issue"]}
FIELD_VALUES = [
    {"name": "description", "displayName": "Description", "type": "string", "default": "", "typeOptions": {"rows": 4},
     "description": "Plain text; blank lines start new paragraphs (converted to ADF on Cloud)"},
    {"name": "labels", "displayName": "Labels", "type": "string", "default": "", "description": "Comma-separated"},
    {"name": "priority", "displayName": "Priority", "type": "options", "default": "",
     "typeOptions": {"loadOptionsMethod": "getPriorities", "loadOptionsDependsOn": ["jiraVersion"]}},
    {"name": "assignee", "displayName": "Assignee", "type": "string", "default": "",
     "description": "Account id (Cloud) or user name (Server)"},
    {"name": "fieldsJson", "displayName": "Other Fields (JSON)", "type": "json", "default": "",
     "description": "Merged into `fields`, e.g. {\"customfield_10011\": \"Epic name\"}"},
]


class JiraNode(Node):
    description = {
        "name": "jira",
        "displayName": "Jira Software",
        "description": "Create, get, search, update and transition Jira issues, and add comments",
        "version": 1,
        "kind": "action",
        "categories": ["Development", "Productivity"],
        "icon": "file:icons/jira.svg",
        "color": "#0052CC",
        "subtitle": "{{operation}}: {{resource}}",
        "documentationUrl": "https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "credentials": [
            {"name": "jiraSoftwareCloudApi", "required": True, "displayOptions": {"show": {"jiraVersion": [CLOUD]}}},
            {"name": "jiraSoftwareServerPatApi", "required": True, "displayOptions": {"show": {"jiraVersion": [SERVER]}}},
        ],
        "usableAsTool": True,
        "toolDescription": (
            "Work with Jira issues. `getAll` searches with a JQL query in `jql`; `get` / `update` / `transition` take an "
            "`issueKey` like PROJ-123; `create` needs `project` and `issueType` ids and a `summary`; comments are added "
            "with resource `issueComment`, operation `add` and the `comment` text."
        ),
        "keywords": ["jira", "atlassian", "issue", "ticket", "bug", "jql", "sprint"],
        "properties": [
            {
                "name": "jiraVersion", "displayName": "Jira Version", "type": "options", "default": CLOUD, "noDataExpression": True,
                "options": [{"name": "Cloud", "value": CLOUD}, {"name": "Server / Data Center (PAT)", "value": SERVER}],
            },
            resource_property([("Issue", "issue"), ("Issue Comment", "issueComment")], "issue"),
            operation_property("issueComment", [("Add", "add", "Add a comment")], "add"),
            operation_property("issue", [
                ("Create", "create", "Create an issue"),
                ("Get", "get", "Get an issue"),
                ("Get Many", "getAll", "Get many issues"),
                ("Transition", "transition", "Move an issue to another status"),
                ("Update", "update", "Update an issue"),
            ], "create"),
            # ---- create
            {
                "name": "project", "displayName": "Project", "type": "options", "default": "", "required": True,
                "typeOptions": {"loadOptionsMethod": "getProjects", "loadOptionsDependsOn": ["jiraVersion"]},
                "displayOptions": {"show": {**ISSUE, "operation": ["create"]}},
            },
            {
                "name": "issueType", "displayName": "Issue Type", "type": "options", "default": "", "required": True,
                "typeOptions": {"loadOptionsMethod": "getIssueTypes", "loadOptionsDependsOn": ["jiraVersion", "project"]},
                "displayOptions": {"show": {**ISSUE, "operation": ["create"]}},
            },
            {"name": "summary", "displayName": "Summary", "type": "string", "default": "", "required": True,
             "displayOptions": {"show": {**ISSUE, "operation": ["create"]}}},
            {"name": "additionalFields", "displayName": "Additional Fields", "type": "collection", "default": {}, "placeholder": "Add Field",
             "displayOptions": {"show": {**ISSUE, "operation": ["create"]}}, "values": FIELD_VALUES},
            # ---- issue key
            {
                "name": "issueKey", "displayName": "Issue Key", "type": "string", "default": "", "required": True, "placeholder": "PROJ-123",
                "displayOptions": {"show": {"resource": ["issue", "issueComment"], "operation": ["get", "update", "transition", "add"]}},
            },
            # ---- update
            {"name": "updateFields", "displayName": "Update Fields", "type": "collection", "default": {}, "placeholder": "Add Field",
             "displayOptions": {"show": {**ISSUE, "operation": ["update"]}},
             "values": [{"name": "summary", "displayName": "Summary", "type": "string", "default": ""}, *FIELD_VALUES]},
            # ---- transition
            {
                "name": "transitionId", "displayName": "Transition", "type": "options", "default": "", "required": True,
                "typeOptions": {"loadOptionsMethod": "getTransitions", "loadOptionsDependsOn": ["jiraVersion", "issueKey"]},
                "description": "Transitions available for the issue (enter the issue key first)",
                "displayOptions": {"show": {**ISSUE, "operation": ["transition"]}},
            },
            # ---- get many
            {"name": "jql", "displayName": "JQL", "type": "string", "default": "", "placeholder": "project = PROJ AND status != Done ORDER BY created DESC",
             "description": "Jira Query Language (Cloud requires a bounded query, e.g. with a project)",
             "displayOptions": {"show": {**ISSUE, "operation": ["getAll"]}}},
            *return_all_properties({**ISSUE, "operation": ["getAll"]}),
            {
                "name": "options", "displayName": "Options", "type": "collection", "default": {}, "placeholder": "Add option",
                "displayOptions": {"show": {**ISSUE, "operation": ["get", "getAll"]}},
                "values": [
                    {"name": "fields", "displayName": "Fields", "type": "string", "default": "",
                     "description": "Comma-separated fields to return (default: all navigable fields)"},
                    {"name": "expand", "displayName": "Expand", "type": "string", "default": "", "placeholder": "renderedFields,changelog"},
                ],
            },
            simplify_property({**ISSUE, "operation": ["get", "getAll"]}),
            # ---- comment
            {"name": "comment", "displayName": "Comment", "type": "string", "default": "", "required": True, "typeOptions": {"rows": 4},
             "displayOptions": {"show": {"resource": ["issueComment"], "operation": ["add"]}}},
        ],
    }

    def load_options(self, method, parameters, ctx=None):
        parameters = parameters or {}
        if method not in ("getProjects", "getIssueTypes", "getPriorities", "getTransitions"):
            return super().load_options(method, parameters, ctx)
        jira = Jira(ctx, parameters.get("jiraVersion") or CLOUD)
        api, rest = jira.api, jira.rest
        if method == "getProjects":
            if jira.cloud:
                projects, start = [], 0
                for _ in range(20):
                    page = api.get(f"{rest}/project/search", params={"startAt": start, "maxResults": 50}) or {}
                    projects += page.get("values") or []
                    start += len(page.get("values") or [])
                    if page.get("isLast", True) or not page.get("values"):
                        break
            else:
                projects = api.get(f"{rest}/project") or []
            return sorted(({"name": f"{p.get('name')} ({p.get('key')})", "value": p.get("id")} for p in projects), key=lambda o: o["name"].lower())
        if method == "getIssueTypes":
            project = str(parameters.get("project") or "").strip()
            types = (api.get(f"{rest}/project/{quote(project, safe='')}") or {}).get("issueTypes") if project else api.get(f"{rest}/issuetype")
            return [{"name": t.get("name"), "value": t.get("id"), "description": "Sub-task" if t.get("subtask") else t.get("description")} for t in types or []]
        if method == "getPriorities":
            return [{"name": p.get("name"), "value": p.get("id")} for p in api.get(f"{rest}/priority") or []]
        key = str(parameters.get("issueKey") or "").strip()
        if not key:
            return []
        transitions = (api.get(f"{rest}/issue/{quote(key, safe='')}/transitions") or {}).get("transitions") or []
        return [{"name": t.get("name"), "value": t.get("id"), "description": f"to {_name(t.get('to'), 'name')}"} for t in transitions]

    def execute(self, ctx):
        jiras: dict[str, Jira] = {}
        results = []
        for i, _item in enumerate(items_of(ctx)):
            with item_errors(ctx, results, i):
                version = ctx.get_node_parameter("jiraVersion", i) or CLOUD
                if version not in jiras:
                    try:
                        jiras[version] = Jira(ctx, version)
                    except NodeOperationError as exc:
                        raise NodeOperationError(exc.message, exc.description, item_index=i) from None
                jira = jiras[version]
                jira.api.item_index = i
                resource = ctx.get_node_parameter("resource", i)
                operation = ctx.get_node_parameter("operation", i)
                if resource == "issue" and operation == "create":
                    results.append(out(self._create(ctx, jira, i), i))
                elif resource == "issue" and operation == "get":
                    results.append(out(self._get(ctx, jira, i), i))
                elif resource == "issue" and operation == "getAll":
                    results.extend(outs(self._search(ctx, jira, i), i))
                elif resource == "issue" and operation == "update":
                    results.append(out(self._update(ctx, jira, i), i))
                elif resource == "issue" and operation == "transition":
                    results.append(out(self._transition(ctx, jira, i), i))
                elif resource == "issueComment" and operation == "add":
                    key = self._key(ctx, i)
                    comment = text_param(ctx, "comment", i, required=True, label="Comment")
                    body = jira.api.call("POST", f"{jira.rest}/issue/{quote(key, safe='')}/comment", json={"body": jira.text(comment)})
                    count_written(ctx, "jira", "comment")
                    results.append(out(body, i))
                else:
                    raise NodeOperationError(f"Unsupported operation {resource}.{operation}", item_index=i)
        return results

    # ------------------------------------------------------------ operations

    @staticmethod
    def _key(ctx, i: int) -> str:
        return text_param(ctx, "issueKey", i, required=True, label="Issue Key")

    @staticmethod
    def _fields(ctx, jira: Jira, values: dict[str, Any], i: int) -> dict[str, Any]:
        fields: dict[str, Any] = {}
        if str(values.get("summary") or "").strip():
            fields["summary"] = str(values["summary"]).strip()
        if str(values.get("description") or "").strip():
            fields["description"] = jira.text(str(values["description"]))
        if "labels" in values:
            fields["labels"] = [label.replace(" ", "_") for label in split_list(values["labels"])]
        if values.get("priority"):
            fields["priority"] = {"id": str(values["priority"])}
        if str(values.get("assignee") or "").strip():
            fields["assignee"] = {"accountId" if jira.cloud else "name": str(values["assignee"]).strip()}
        fields.update(parse_json(values.get("fieldsJson"), "Other Fields (JSON)", i) or {})
        return fields

    def _create(self, ctx, jira: Jira, i: int) -> dict[str, Any]:
        project = text_param(ctx, "project", i, required=True, label="Project")
        issue_type = text_param(ctx, "issueType", i, required=True, label="Issue Type")
        values = {**collection(ctx, "additionalFields", i), "summary": text_param(ctx, "summary", i, required=True, label="Summary")}
        fields = {
            "project": {"key": project} if not project.isdigit() else {"id": project},
            "issuetype": {"id": issue_type} if issue_type.isdigit() else {"name": issue_type},
            **self._fields(ctx, jira, values, i),
        }
        issue = jira.api.call("POST", f"{jira.rest}/issue", json={"fields": fields})
        count_written(ctx, "jira", "create")
        return issue

    def _get(self, ctx, jira: Jira, i: int) -> dict[str, Any]:
        options = collection(ctx, "options", i)
        params = {k: ",".join(split_list(options[k])) for k in ("fields", "expand") if split_list(options.get(k))}
        issue = jira.api.get(f"{jira.rest}/issue/{quote(self._key(ctx, i), safe='')}", params=params or None) or {}
        return simplify_issue(issue) if bool_param(ctx, "simplify", i, True) else issue

    def _search(self, ctx, jira: Jira, i: int) -> list[dict[str, Any]]:
        limit = limit_of(ctx, i)
        options = collection(ctx, "options", i)
        jql = text_param(ctx, "jql", i)
        fields = split_list(options.get("fields")) or ["*navigable"]
        body: dict[str, Any] = {"jql": jql, "fields": fields}
        if split_list(options.get("expand")):
            body["expand"] = ",".join(split_list(options["expand"])) if jira.cloud else split_list(options["expand"])
        found: list[dict[str, Any]] = []
        pages = 0
        with ctx.span("jira.search", {"jira.deployment": "cloud" if jira.cloud else "server", "landflow.return_all": limit is None}) as span:
            token, start = None, 0
            while True:
                size = PAGE_SIZE if limit is None else min(PAGE_SIZE, limit - len(found))
                if jira.cloud:  # enhanced search: cursor pagination with nextPageToken
                    request = {**body, "maxResults": size, **({"nextPageToken": token} if token else {})}
                    page = jira.api.call("POST", f"{jira.rest}/search/jql", json=request) or {}
                else:  # classic search: offset pagination with startAt
                    page = jira.api.call("POST", f"{jira.rest}/search", json={**body, "startAt": start, "maxResults": size}) or {}
                pages += 1
                issues = page.get("issues") or []
                found.extend(issues)
                if limit is not None and len(found) >= limit:
                    break
                if jira.cloud:
                    token = page.get("nextPageToken")
                    if not token or page.get("isLast"):
                        break
                else:
                    start += len(issues)
                    if not issues or start >= int(page.get("total") or 0):
                        break
            span.set_attributes({"landflow.pages": pages, "landflow.items": len(found)})
        found = found if limit is None else found[:limit]
        return [simplify_issue(issue) for issue in found] if bool_param(ctx, "simplify", i, True) else found

    def _update(self, ctx, jira: Jira, i: int) -> dict[str, Any]:
        key = self._key(ctx, i)
        fields = self._fields(ctx, jira, collection(ctx, "updateFields", i), i)
        if not fields:
            raise NodeOperationError("Nothing to update: add at least one field under 'Update Fields'", item_index=i)
        jira.api.call("PUT", f"{jira.rest}/issue/{quote(key, safe='')}", json={"fields": fields})
        count_written(ctx, "jira", "update")
        return {"success": True, "key": key}

    def _transition(self, ctx, jira: Jira, i: int) -> dict[str, Any]:
        key = self._key(ctx, i)
        transition = text_param(ctx, "transitionId", i, required=True, label="Transition")
        jira.api.call("POST", f"{jira.rest}/issue/{quote(key, safe='')}/transitions", json={"transition": {"id": transition}})
        count_written(ctx, "jira", "transition")
        return {"success": True, "key": key, "transitionId": transition}
