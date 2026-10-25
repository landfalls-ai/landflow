"""GitHub: issues, repositories, releases and files, plus the GitHub Trigger (polls new issues, PRs or releases)."""

from __future__ import annotations

import base64
import binascii
import re
from typing import Any
from urllib.parse import quote

from landflow_sdk import CredentialType, Node, NodeOperationError, poll_interval_property

from .common import (
    Api,
    collection,
    count_new_items,
    count_written,
    item_errors,
    items_of,
    limit_of,
    operation_property,
    out,
    outs,
    resource_property,
    return_all_properties,
    split_list,
    test_call,
    text_param,
)

PER_PAGE = 100
MANUAL_ITEMS = 5
MAX_POLL_PAGES = 10
_NEXT_RE = re.compile(r'<([^>]+)>\s*;\s*rel="?next"?')


def github_api(ctx: Any, creds: dict[str, Any]) -> Api:
    return Api(ctx, "github", creds.get("baseUrl") or "https://api.github.com", {
        "Authorization": f"Bearer {creds.get('accessToken', '')}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })


def test_github(data: dict[str, Any], ctx: Any) -> tuple[bool, str]:
    ok, reason, me = test_call(github_api(ctx, data), "/user")
    if not ok:
        return False, reason or "GitHub rejected the token"
    return True, f"authenticated as {me.get('login')}" if isinstance(me, dict) else "authenticated"


GITHUB_API = CredentialType(
    name="githubApi",
    display_name="GitHub API",
    documentation_url="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    description="A personal access token (classic or fine-grained). For GitHub Enterprise use https://<host>/api/v3 as the base URL.",
    test=test_github,
    properties=[
        {"name": "accessToken", "displayName": "Access Token", "type": "string", "required": True,
         "typeOptions": {"password": True}, "placeholder": "ghp_… / github_pat_…"},
        {"name": "baseUrl", "displayName": "API Base URL", "type": "string", "default": "https://api.github.com",
         "description": "GitHub Enterprise Server: https://<host>/api/v3"},
    ],
)


def next_link(resp: Any) -> str | None:
    """The ``rel="next"`` URL of a ``Link`` header."""
    match = _NEXT_RE.search(resp.headers.get("Link", ""))
    return match.group(1) if match else None


def paginate(api: Api, path: str, params: dict[str, Any], limit: int | None, keep: Any = None, max_pages: int | None = None) -> tuple[list[Any], int]:
    """GET ``path`` and follow ``Link: rel="next"`` until ``limit`` kept results (``keep(item)`` filters) -> ``(results, pages)``."""
    found: list[Any] = []
    pages = 0
    url: str | None = path
    query: dict[str, Any] | None = {**params, "per_page": PER_PAGE if limit is None or keep else min(PER_PAGE, limit)}
    while url:
        resp = api.request("GET", url, params=query)
        query = None  # the next link carries the query string
        pages += 1
        body = resp.json
        found.extend(entry for entry in (body if isinstance(body, list) else []) if keep is None or keep(entry))
        if (limit is not None and len(found) >= limit) or (max_pages and pages >= max_pages):
            break
        url = next_link(resp)
    return (found if limit is None else found[:limit]), pages


# ------------------------------------------------------------- repository

REPO_PROPERTIES = [
    {
        "name": "repo", "displayName": "Repository", "type": "options", "default": "",
        "typeOptions": {"loadOptionsMethod": "getRepositories"},
        "options": [{"name": "Enter Owner and Name", "value": ""}],
        "description": "Pick one of your repositories, or enter the owner and name below",
    },
    {
        "name": "owner", "displayName": "Repository Owner", "type": "string", "default": "", "placeholder": "n8n-io",
        "displayOptions": {"show": {"repo": [""]}},
    },
    {
        "name": "repository", "displayName": "Repository Name", "type": "string", "default": "", "placeholder": "n8n",
        "displayOptions": {"show": {"repo": [""]}},
    },
]


class RepositoryPicker:
    """``getRepositories`` (``/user/repos``) and owner/name resolution, shared by the GitHub node and trigger."""

    def load_options(self, method, parameters, ctx=None):
        if method == "getRepositories":
            api = github_api(ctx, ctx.get_credentials("githubApi"))
            repos, _ = paginate(api, "/user/repos", {"sort": "updated"}, None, max_pages=5)
            return [{"name": "Enter Owner and Name", "value": ""}] + [
                {"name": r.get("full_name"), "value": r.get("full_name"), "description": r.get("description")} for r in repos if isinstance(r, dict)
            ]
        return super().load_options(method, parameters, ctx)  # type: ignore[misc]

    @staticmethod
    def repo_path(ctx: Any, i: int) -> str:
        """``/repos/{owner}/{name}`` from the picker (``owner/name``) or the two string parameters."""
        picked = str(ctx.get_node_parameter("repo", i) or "").strip()
        if picked and "/" in picked:
            owner, _, name = picked.partition("/")
        else:
            owner = text_param(ctx, "owner", i, required=True, label="Repository Owner")
            name = text_param(ctx, "repository", i, required=True, label="Repository Name")
        return f"/repos/{quote(owner.strip(), safe='')}/{quote(name.strip(), safe='')}"


def decode_file(entry: dict[str, Any]) -> dict[str, Any]:
    """Contents API file -> the same object with ``content`` decoded (UTF-8 text, else base64 kept)."""
    if entry.get("encoding") != "base64" or not isinstance(entry.get("content"), str):
        return entry
    try:
        raw = base64.b64decode(entry["content"])
    except (binascii.Error, ValueError):
        return entry
    try:
        return {**entry, "content": raw.decode("utf-8"), "encoding": "utf-8"}
    except UnicodeDecodeError:
        return {**entry, "content": base64.b64encode(raw).decode("ascii"), "encoding": "base64"}


ISSUE = {"resource": ["issue"]}


class GitHub(RepositoryPicker, Node):
    description = {
        "name": "github",
        "displayName": "GitHub",
        "description": "Create, edit, comment on and list issues; get repositories, releases and files",
        "version": 1,
        "kind": "action",
        "categories": ["Development"],
        "icon": "file:icons/github.svg",
        "color": "#24292F",
        "subtitle": "{{operation}}: {{resource}}",
        "documentationUrl": "https://docs.github.com/en/rest",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "credentials": [{"name": "githubApi", "required": True}],
        "usableAsTool": True,
        "toolDescription": (
            "Work with a GitHub repository (`owner`, `repository`). Issues: `create` (`title`, `body`), `get` / `edit` / "
            "`createComment` by `issueNumber`, `getAll` (filters by state and labels). Also get the repository, list "
            "releases, or read a file's text (`filePath`)."
        ),
        "keywords": ["github", "git", "issues", "repository", "release", "code"],
        "properties": [
            resource_property([("File", "file"), ("Issue", "issue"), ("Release", "release"), ("Repository", "repository")], "issue"),
            operation_property("file", [("Get", "get", "Get a file")], "get"),
            operation_property("release", [("Get Many", "getAll", "Get many releases")], "getAll"),
            operation_property("repository", [("Get", "get", "Get a repository")], "get"),
            operation_property("issue", [
                ("Create", "create", "Create an issue"),
                ("Create Comment", "createComment", "Create a comment on an issue"),
                ("Edit", "edit", "Edit an issue"),
                ("Get", "get", "Get an issue"),
                ("Get Many", "getAll", "Get many issues"),
            ], "create"),
            *REPO_PROPERTIES,
            # ---- issue
            {"name": "title", "displayName": "Title", "type": "string", "default": "", "required": True,
             "displayOptions": {"show": {**ISSUE, "operation": ["create"]}}},
            {"name": "body", "displayName": "Body", "type": "string", "default": "", "typeOptions": {"rows": 5},
             "description": "Markdown", "displayOptions": {"show": {**ISSUE, "operation": ["create", "createComment"]}}},
            {"name": "labels", "displayName": "Labels", "type": "string", "default": "", "placeholder": "bug, triage",
             "description": "Comma-separated label names", "displayOptions": {"show": {**ISSUE, "operation": ["create"]}}},
            {"name": "assignees", "displayName": "Assignees", "type": "string", "default": "", "placeholder": "octocat",
             "description": "Comma-separated user logins", "displayOptions": {"show": {**ISSUE, "operation": ["create"]}}},
            {"name": "issueNumber", "displayName": "Issue Number", "type": "number", "default": 0, "required": True,
             "typeOptions": {"minValue": 1}, "displayOptions": {"show": {**ISSUE, "operation": ["get", "edit", "createComment"]}}},
            {
                "name": "editFields", "displayName": "Edit Fields", "type": "collection", "default": {}, "placeholder": "Add Field",
                "displayOptions": {"show": {**ISSUE, "operation": ["edit"]}},
                "values": [
                    {"name": "title", "displayName": "Title", "type": "string", "default": ""},
                    {"name": "body", "displayName": "Body", "type": "string", "default": "", "typeOptions": {"rows": 5}},
                    {"name": "state", "displayName": "State", "type": "options", "default": "open",
                     "options": [{"name": "Open", "value": "open"}, {"name": "Closed", "value": "closed"}]},
                    {"name": "stateReason", "displayName": "State Reason", "type": "options", "default": "completed",
                     "options": [{"name": "Completed", "value": "completed"}, {"name": "Not Planned", "value": "not_planned"},
                                 {"name": "Reopened", "value": "reopened"}]},
                    {"name": "labels", "displayName": "Labels", "type": "string", "default": "", "description": "Comma-separated; replaces the current labels"},
                    {"name": "assignees", "displayName": "Assignees", "type": "string", "default": "", "description": "Comma-separated logins; replaces the current assignees"},
                ],
            },
            *return_all_properties({"resource": ["issue", "release"], "operation": ["getAll"]}),
            {
                "name": "getRepositoryIssuesFilters", "displayName": "Filters", "type": "collection", "default": {}, "placeholder": "Add Filter",
                "displayOptions": {"show": {**ISSUE, "operation": ["getAll"]}},
                "values": [
                    {"name": "state", "displayName": "State", "type": "options", "default": "open",
                     "options": [{"name": "All", "value": "all"}, {"name": "Closed", "value": "closed"}, {"name": "Open", "value": "open"}]},
                    {"name": "labels", "displayName": "Labels", "type": "string", "default": "", "description": "Comma-separated; issues must have all of them"},
                    {"name": "since", "displayName": "Updated Since", "type": "dateTime", "default": "", "description": "Only issues updated at or after this time"},
                    {"name": "assignee", "displayName": "Assignee", "type": "string", "default": "", "description": "A login, 'none' or '*'"},
                    {"name": "creator", "displayName": "Creator", "type": "string", "default": ""},
                    {"name": "sort", "displayName": "Sort", "type": "options", "default": "created",
                     "options": [{"name": "Created", "value": "created"}, {"name": "Updated", "value": "updated"}, {"name": "Comments", "value": "comments"}]},
                    {"name": "direction", "displayName": "Direction", "type": "options", "default": "desc",
                     "options": [{"name": "Descending", "value": "desc"}, {"name": "Ascending", "value": "asc"}]},
                ],
            },
            # ---- file
            {"name": "filePath", "displayName": "File Path", "type": "string", "default": "", "required": True, "placeholder": "docs/README.md",
             "displayOptions": {"show": {"resource": ["file"]}}},
            {
                "name": "fileOptions", "displayName": "Options", "type": "collection", "default": {}, "placeholder": "Add option",
                "displayOptions": {"show": {"resource": ["file"]}},
                "values": [{"name": "reference", "displayName": "Reference", "type": "string", "default": "",
                            "description": "Branch, tag or commit (default branch when empty)"}],
            },
        ],
    }

    def execute(self, ctx):
        api = github_api(ctx, ctx.get_credentials("githubApi"))
        results = []
        for i, _item in enumerate(items_of(ctx)):
            with item_errors(ctx, results, i):
                api.item_index = i
                resource = ctx.get_node_parameter("resource", i)
                operation = ctx.get_node_parameter("operation", i)
                repo = self.repo_path(ctx, i)
                if resource == "issue":
                    results.extend(self._issue(ctx, api, i, repo, operation))
                elif resource == "repository" and operation == "get":
                    results.append(out(api.get(repo), i))
                elif resource == "release" and operation == "getAll":
                    limit = limit_of(ctx, i)
                    with ctx.span("github.list", {"github.resource": "release", "landflow.return_all": limit is None}) as span:
                        releases, pages = paginate(api, f"{repo}/releases", {}, limit)
                        span.set_attributes({"landflow.pages": pages, "landflow.items": len(releases)})
                    results.extend(outs(releases, i))
                elif resource == "file" and operation == "get":
                    results.extend(outs(self._file(ctx, api, i, repo), i))
                else:
                    raise NodeOperationError(f"Unsupported operation {resource}.{operation}", item_index=i)
        return results

    def _issue(self, ctx, api: Api, i: int, repo: str, operation: str) -> list[dict[str, Any]]:
        if operation == "create":
            body: dict[str, Any] = {"title": text_param(ctx, "title", i, required=True, label="Title")}
            text = str(ctx.get_node_parameter("body", i) or "")
            if text:
                body["body"] = text
            for key in ("labels", "assignees"):
                if split_list(ctx.get_node_parameter(key, i)):
                    body[key] = split_list(ctx.get_node_parameter(key, i))
            issue = api.call("POST", f"{repo}/issues", json=body)
            count_written(ctx, "github", "create")
            return [out(issue, i)]
        if operation == "getAll":
            return outs(self._list_issues(ctx, api, i, repo), i)
        number = self._issue_number(ctx, i)
        if operation == "get":
            return [out(api.get(f"{repo}/issues/{number}"), i)]
        if operation == "edit":
            fields = collection(ctx, "editFields", i)
            body = {k: fields[k] for k in ("title", "body", "state") if fields.get(k) not in (None, "")}
            if fields.get("stateReason") and fields.get("state"):
                body["state_reason"] = fields["stateReason"]
            for key in ("labels", "assignees"):
                if key in fields:
                    body[key] = split_list(fields[key])
            if not body:
                raise NodeOperationError("Nothing to edit: add at least one field under 'Edit Fields'", item_index=i)
            issue = api.call("PATCH", f"{repo}/issues/{number}", json=body)
            count_written(ctx, "github", "update")
            return [out(issue, i)]
        if operation == "createComment":
            text = text_param(ctx, "body", i, required=True, label="Body")
            comment = api.call("POST", f"{repo}/issues/{number}/comments", json={"body": text})
            count_written(ctx, "github", "comment")
            return [out(comment, i)]
        raise NodeOperationError(f"Unsupported operation issue.{operation}", item_index=i)

    @staticmethod
    def _issue_number(ctx, i: int) -> int:
        raw = ctx.get_node_parameter("issueNumber", i)
        try:
            number = int(float(str(raw).lstrip("#")))
        except (TypeError, ValueError):
            number = 0
        if number < 1:
            raise NodeOperationError(f"'Issue Number' must be a positive number, got {raw!r}", item_index=i)
        return number

    def _list_issues(self, ctx, api: Api, i: int, repo: str) -> list[dict[str, Any]]:
        filters = collection(ctx, "getRepositoryIssuesFilters", i)
        params: dict[str, Any] = {k: filters[k] for k in ("state", "since", "assignee", "creator", "sort", "direction") if filters.get(k)}
        if split_list(filters.get("labels")):
            params["labels"] = ",".join(split_list(filters["labels"]))
        limit = limit_of(ctx, i)
        with ctx.span("github.list", {"github.resource": "issue", "landflow.return_all": limit is None}) as span:
            issues, pages = paginate(api, f"{repo}/issues", params, limit, keep=lambda issue: "pull_request" not in issue)
            span.set_attributes({"landflow.pages": pages, "landflow.items": len(issues)})
        return issues

    def _file(self, ctx, api: Api, i: int, repo: str) -> list[dict[str, Any]]:
        path = text_param(ctx, "filePath", i, required=True, label="File Path").strip("/")
        reference = str(collection(ctx, "fileOptions", i).get("reference") or "").strip()
        params = {"ref": reference} if reference else None
        url = f"{repo}/contents/{quote(path)}"
        body = api.get(url, params=params)
        if isinstance(body, list):  # a directory: one item per entry
            return body
        if isinstance(body, dict) and body.get("type") == "file" and body.get("encoding") == "none":  # > 1 MB: fetch the raw bytes
            raw = api.request("GET", url, params=params, headers={"Accept": "application/vnd.github.raw+json"})
            body = {**body, "content": base64.b64encode(raw.content).decode("ascii"), "encoding": "base64"}
        return [decode_file(body or {})]


# ----------------------------------------------------------------- trigger

EVENTS = {
    "newIssue": ("issues", {"state": "all", "sort": "created", "direction": "desc"}),
    "newPullRequest": ("pulls", {"state": "all", "sort": "created", "direction": "desc"}),
    "newRelease": ("releases", {}),
}


class GitHubTrigger(RepositoryPicker, Node):
    description = {
        "name": "githubTrigger",
        "displayName": "GitHub Trigger",
        "description": "Starts the workflow when a repository gets a new issue, pull request or release (polling)",
        "version": 1,
        "kind": "trigger",
        "triggerSource": "poll",
        "categories": ["Development"],
        "icon": "file:icons/github.svg",
        "color": "#24292F",
        "subtitle": "{{event}}",
        "documentationUrl": "https://docs.github.com/en/rest/issues/issues#list-repository-issues",
        "inputs": [],
        "outputs": [{"type": "main"}],
        "credentials": [{"name": "githubApi", "required": True}],
        "keywords": ["github", "issues", "pull request", "release", "poll"],
        "properties": [
            poll_interval_property(60),
            *REPO_PROPERTIES,
            {
                "name": "event", "displayName": "Event", "type": "options", "default": "newIssue", "noDataExpression": True,
                "options": [
                    {"name": "New Issue", "value": "newIssue", "description": "An issue was opened (pull requests excluded)"},
                    {"name": "New Pull Request", "value": "newPullRequest"},
                    {"name": "New Release", "value": "newRelease", "description": "A release was published (or drafted, with push access)"},
                ],
            },
            {
                "name": "pollNotice", "displayName": "The first poll after activation only records the newest item; later polls emit what is newer, oldest first.",
                "type": "notice", "default": "",
            },
        ],
    }

    def execute(self, ctx):
        api = github_api(ctx, ctx.get_credentials("githubApi"))
        event = ctx.get_node_parameter("event") or "newIssue"
        if event not in EVENTS:
            raise NodeOperationError(f"Unknown event {event!r}")
        endpoint, params = EVENTS[event]
        path = f"{self.repo_path(ctx, 0)}/{endpoint}"
        keep = (lambda issue: "pull_request" not in issue) if event == "newIssue" else None
        state = ctx.get_poll_state() or {}
        last_id = int(state.get("lastId") or 0)

        if ctx.mode != "poll":  # editor run: the latest few, oldest first, state untouched
            latest, _ = paginate(api, path, params, MANUAL_ITEMS, keep=keep, max_pages=3)
            return [{"json": e} for e in sorted(latest, key=lambda e: e.get("id") or 0)]

        found: list[dict[str, Any]] = []
        with ctx.span("github.list", {"github.resource": endpoint, "landflow.poll.first": ctx.is_first_poll()}) as span:
            url: str | None = path
            query: dict[str, Any] | None = {**params, "per_page": PER_PAGE}
            pages = 0
            while url and pages < MAX_POLL_PAGES:  # newest first: stop at the first page that reaches lastId
                resp = api.request("GET", url, params=query)
                query, pages = None, pages + 1
                page = [e for e in (resp.json if isinstance(resp.json, list) else []) if isinstance(e, dict) and (keep is None or keep(e))]
                found.extend(page)
                if ctx.is_first_poll() or not page or min(e.get("id") or 0 for e in page) <= last_id:
                    break
                url = next_link(resp)
            span.set_attributes({"landflow.pages": pages, "landflow.items": len(found)})

        newest = max((e.get("id") or 0 for e in found), default=0)
        if ctx.is_first_poll():
            ctx.set_poll_state({"lastId": newest})
            return []
        fresh = sorted((e for e in found if (e.get("id") or 0) > last_id), key=lambda e: e["id"])
        ctx.set_poll_state({"lastId": max(last_id, newest)})
        count_new_items(ctx, "github", len(fresh))
        if fresh:
            ctx.logger.info(f"{len(fresh)} new {endpoint}", event=event)
        return [{"json": e} for e in fresh]
