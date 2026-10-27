"""GitHub: issues, repositories, releases and files, the GitHub Trigger (polls new issues, PRs or releases) and the
GitHub Webhook Trigger (a repository webhook registered when the workflow is published)."""

from __future__ import annotations

import base64
import binascii
import re
import secrets
from typing import Any
from urllib.parse import quote

from landflow_sdk import CredentialType, Node, NodeOperationError, poll_interval_property, verify_github_signature

from .github_app import GITHUB_APP_API, PERMISSIONS_HINT, GitHubApi, github_api, test_github_app  # noqa: F401
from .common import (
    Api,
    api_error,
    authentication_property,
    binary_input,
    binary_name_property,
    binary_out,
    collection,
    content_type_of,
    credential_requirements,
    count_new_items,
    count_written,
    download,
    item_errors,
    items_of,
    limit_of,
    operation_property,
    oauth2_properties,
    out,
    outs,
    pick_credentials,
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


def test_github(data: dict[str, Any], ctx: Any) -> tuple[bool, str]:
    ok, reason, me = test_call(github_api(ctx, data), "/user")
    if not ok:
        return False, reason or "GitHub rejected the token"
    return True, f"authenticated as {me.get('login')}" if isinstance(me, dict) else "authenticated"


#: The third Authentication option of the GitHub nodes: ``(display name, value, credential type)``.
APP_AUTHENTICATION = [("GitHub App", "githubApp", "githubAppApi")]


def github_credentials(ctx: Any, authentication: Any = None) -> dict[str, Any]:
    """The node's GitHub credential (token, OAuth2 or GitHub App); ``github_api`` turns an app's into installation tokens."""
    return pick_credentials(ctx, "githubApi", "githubOAuth2Api", authentication, extra=APP_AUTHENTICATION)


def github_requirements() -> list[dict[str, Any]]:
    return credential_requirements("githubApi", "githubOAuth2Api", extra=APP_AUTHENTICATION)


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


GITHUB_OAUTH2_API = CredentialType(
    name="githubOAuth2Api",
    display_name="GitHub OAuth2 API",
    documentation_url="https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps",
    description="Sign in with GitHub: register an OAuth App (Settings, Developer settings), add the redirect URL shown below, then Connect. "
                "For GitHub Enterprise use the host's URLs for Authorization and Access Token and its /api/v3 base URL.",
    test=test_github,
    extends=["oAuth2Api"],
    properties=[
        *oauth2_properties("https://github.com/login/oauth/authorize", "https://github.com/login/oauth/access_token", "repo read:user admin:repo_hook",
                           user_info_url="https://api.github.com/user"),
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
        if isinstance(body, dict) and isinstance(body.get("repositories"), list):  # /installation/repositories
            body = body["repositories"]
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
            api = github_api(ctx, github_credentials(ctx, (parameters or {}).get("authentication")))
            # A GitHub App installation has no user: it lists the repositories it was installed on.
            repos, _ = paginate(api, "/installation/repositories" if api.app else "/user/repos", {} if api.app else {"sort": "updated"}, None, max_pages=5)
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
        "description": "Create, edit, comment on and list issues; get repositories, releases and files; upload and download files and release assets",
        "version": 1,
        "kind": "action",
        "idempotent": False,  # creates, updates, archives and comments are at most once over a broker; the read operations opt in below
        "categories": ["Development"],
        "icon": "file:icons/github.svg",
        "color": "#24292F",
        "subtitle": "{{operation}}: {{resource}}",
        "documentationUrl": "https://docs.github.com/en/rest",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "credentials": github_requirements(),
        "usableAsTool": True,
        "toolDescription": (
            "Work with a GitHub repository (`owner`, `repository`). Issues: `create` (`title`, `body`), `get` / `edit` / "
            "`createComment` by `issueNumber`, `getAll` (filters by state and labels). Also get the repository, list "
            "releases, or read a file's text (`filePath`). Files and release assets move as binary data on the item: Download File, "
            "Create or Update File, Download Asset, Upload Asset, Download Archive."
        ),
        "keywords": ["github", "git", "issues", "repository", "release", "code"],
        "properties": [
            authentication_property("Access Token", APP_AUTHENTICATION),
            resource_property([("File", "file"), ("Issue", "issue"), ("Release", "release"), ("Repository", "repository")], "issue"),
            operation_property("file", [
                ("Create or Update", "createOrUpdate", "Create or update a file from binary data"),
                ("Download", "download", "Download a file as binary data", True),
                ("Get", "get", "Get a file", True),
            ], "get"),
            operation_property("release", [
                ("Download Asset", "downloadAsset", "Download a release asset as binary data", True),
                ("Get Many", "getAll", "Get many releases", True),
                ("Upload Asset", "uploadAsset", "Upload binary data as a release asset"),
            ], "getAll"),
            operation_property("repository", [
                ("Download Archive", "downloadArchive", "Download a zip or tar archive as binary data", True),
                ("Get", "get", "Get a repository", True),
            ], "get"),
            operation_property("issue", [
                ("Create", "create", "Create an issue"),
                ("Create Comment", "createComment", "Create a comment on an issue"),
                ("Edit", "edit", "Edit an issue"),
                ("Get", "get", "Get an issue", True),
                ("Get Many", "getAll", "Get many issues", True),
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
                            "description": "Branch, tag or commit (default branch when empty); Create or Update commits to this branch"}],
            },
            {"name": "commitMessage", "displayName": "Commit Message", "type": "string", "default": "", "placeholder": "Add report",
             "description": "Defaults to 'Create <path>' or 'Update <path>'", "displayOptions": {"show": {"resource": ["file"], "operation": ["createOrUpdate"]}}},
            binary_name_property("binaryPropertyName", "Input Binary Field", {"resource": ["file", "release"], "operation": ["createOrUpdate", "uploadAsset"]},
                                 "Name of the binary property that holds the file to send"),
            binary_name_property("outputBinaryName", "Output Binary Field", {"operation": ["download", "downloadAsset", "downloadArchive"]},
                                 "Binary property that receives the downloaded file"),
            # ---- release assets and repository archives
            {"name": "releaseRef", "displayName": "Release", "type": "string", "default": "latest", "placeholder": "latest, v1.2.0 or a release id",
             "description": "A release id, a tag name or 'latest'", "displayOptions": {"show": {"resource": ["release"], "operation": ["downloadAsset", "uploadAsset"]}}},
            {"name": "assetRef", "displayName": "Asset", "type": "string", "default": "", "required": True, "placeholder": "app.zip or an asset id",
             "description": "The asset's file name (looked up in the release) or its numeric id",
             "displayOptions": {"show": {"resource": ["release"], "operation": ["downloadAsset"]}}},
            {"name": "assetOptions", "displayName": "Options", "type": "collection", "default": {}, "placeholder": "Add option",
             "displayOptions": {"show": {"resource": ["release"], "operation": ["uploadAsset"]}},
             "values": [
                 {"name": "name", "displayName": "Asset Name", "type": "string", "default": "", "description": "Defaults to the binary file's name"},
                 {"name": "label", "displayName": "Label", "type": "string", "default": "", "description": "Shown instead of the file name in the release"},
             ]},
            {"name": "archiveFormat", "displayName": "Format", "type": "options", "default": "zipball",
             "options": [{"name": "Zip", "value": "zipball"}, {"name": "Tar (gzip)", "value": "tarball"}],
             "displayOptions": {"show": {"resource": ["repository"], "operation": ["downloadArchive"]}}},
            {"name": "archiveRef", "displayName": "Reference", "type": "string", "default": "", "placeholder": "main",
             "description": "Branch, tag or commit (default branch when empty)",
             "displayOptions": {"show": {"resource": ["repository"], "operation": ["downloadArchive"]}}},
        ],
    }

    def execute(self, ctx):
        api = github_api(ctx, github_credentials(ctx, ctx.get_node_parameter("authentication")))
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
                elif resource == "repository" and operation == "downloadArchive":
                    results.append(self._archive(ctx, api, i, repo))
                elif resource == "release" and operation == "getAll":
                    limit = limit_of(ctx, i)
                    with ctx.span("github.list", {"github.resource": "release", "landflow.return_all": limit is None}) as span:
                        releases, pages = paginate(api, f"{repo}/releases", {}, limit)
                        span.set_attributes({"landflow.pages": pages, "landflow.items": len(releases)})
                    results.extend(outs(releases, i))
                elif resource == "file" and operation == "get":
                    results.extend(outs(self._file(ctx, api, i, repo), i))
                elif resource == "file" and operation == "download":
                    results.append(self._download_file(ctx, api, i, repo))
                elif resource == "file" and operation == "createOrUpdate":
                    results.append(out(self._put_file(ctx, api, i, repo), i))
                elif resource == "release" and operation == "downloadAsset":
                    results.append(self._download_asset(ctx, api, i, repo))
                elif resource == "release" and operation == "uploadAsset":
                    results.append(out(self._upload_asset(ctx, api, i, repo), i))
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

    # ------------------------------------------------------------ binary data

    @staticmethod
    def _output_name(ctx, i: int) -> str:
        return text_param(ctx, "outputBinaryName", i) or "data"

    def _download_file(self, ctx, api: Api, i: int, repo: str) -> dict[str, Any]:
        """The raw bytes of a file (any size up to 100 MB) as binary data; the JSON is the file's path, size and sha."""
        path = text_param(ctx, "filePath", i, required=True, label="File Path").strip("/")
        reference = str(collection(ctx, "fileOptions", i).get("reference") or "").strip()
        url = f"{repo}/contents/{quote(path)}"
        params = {"ref": reference} if reference else None
        meta = api.get(url, params=params)
        if isinstance(meta, list):
            raise NodeOperationError(f"'{path}' is a directory; Download needs a file path", item_index=i)
        meta = meta if isinstance(meta, dict) else {}
        if meta.get("type") != "file":
            raise NodeOperationError(f"'{path}' is a {meta.get('type') or 'non-file'}, not a file", item_index=i)
        if meta.get("encoding") == "base64" and isinstance(meta.get("content"), str):
            try:
                content = base64.b64decode(meta["content"])
            except (binascii.Error, ValueError):
                raise NodeOperationError(f"GitHub sent undecodable content for '{path}'", item_index=i) from None
        else:  # over 1 MB the contents API leaves the content out: fetch the raw bytes
            content = download(api, url, i, headers={"Accept": "application/vnd.github.raw+json"}).content
        name = str(meta.get("name") or path.rsplit("/", 1)[-1])
        info = {"path": path, "name": name, "size": len(content), "sha": meta.get("sha"), **({"ref": reference} if reference else {})}
        return binary_out(ctx, info, i, self._output_name(ctx, i), content, name)

    def _put_file(self, ctx, api: Api, i: int, repo: str) -> dict[str, Any]:
        """Create the file, or update it when it exists (its blob sha is looked up first), with the bytes of the item's binary file."""
        path = text_param(ctx, "filePath", i, required=True, label="File Path").strip("/")
        content, _ref, _name = binary_input(ctx, "binaryPropertyName", i)
        branch = str(collection(ctx, "fileOptions", i).get("reference") or "").strip()
        url = f"{repo}/contents/{quote(path)}"
        existing = api.request("GET", url, params={"ref": branch} if branch else None, expect=(404,))
        sha = existing.json.get("sha") if existing.status < 400 and isinstance(existing.json, dict) and existing.json.get("type") == "file" else None
        message = text_param(ctx, "commitMessage", i) or f"{'Update' if sha else 'Create'} {path}"
        body: dict[str, Any] = {"message": message, "content": base64.b64encode(content).decode("ascii")}
        if sha:
            body["sha"] = sha
        if branch:
            body["branch"] = branch
        result = api.call("PUT", url, json=body, timeout=120)
        count_written(ctx, "github", "update" if sha else "create")
        return {**(result or {}), "updated": bool(sha)}

    def _release(self, api: Api, repo: str, ref: str, i: int) -> dict[str, Any]:
        ref = (ref or "latest").strip()
        if ref == "latest":
            path = f"{repo}/releases/latest"
        elif ref.isdigit():
            path = f"{repo}/releases/{ref}"
        else:
            path = f"{repo}/releases/tags/{quote(ref, safe='')}"
        release = api.get(path)
        if not isinstance(release, dict):
            raise NodeOperationError(f"Release '{ref}' not found", item_index=i)
        return release

    def _download_asset(self, ctx, api: Api, i: int, repo: str) -> dict[str, Any]:
        """A release asset as binary data: by numeric id, or by file name within the release."""
        asset_ref = text_param(ctx, "assetRef", i, required=True, label="Asset")
        if asset_ref.isdigit():
            asset_id = asset_ref
        else:
            release = self._release(api, repo, text_param(ctx, "releaseRef", i), i)
            match = next((a for a in release.get("assets") or [] if isinstance(a, dict) and a.get("name") == asset_ref), None)
            if not match:
                raise NodeOperationError(f"Release '{release.get('tag_name')}' has no asset named '{asset_ref}'", item_index=i)
            asset_id = str(match["id"])
        url = f"{repo}/releases/assets/{asset_id}"
        meta = api.get(url) or {}
        resp = download(api, url, i, headers={"Accept": "application/octet-stream"})
        name = str(meta.get("name") or f"asset-{asset_id}")
        info = {"id": meta.get("id") or int(asset_id), "name": name, "size": len(resp.content), "contentType": meta.get("content_type")}
        return binary_out(ctx, info, i, self._output_name(ctx, i), resp.content, name, meta.get("content_type") or resp.headers.get("Content-Type"))

    def _upload_asset(self, ctx, api: Api, i: int, repo: str) -> dict[str, Any]:
        """Upload the item's binary file as an asset of a release (the release's own ``upload_url`` is used, so Enterprise works)."""
        content, ref, file_name = binary_input(ctx, "binaryPropertyName", i)
        options = collection(ctx, "assetOptions", i)
        name = str(options.get("name") or "").strip() or file_name
        release = self._release(api, repo, text_param(ctx, "releaseRef", i), i)
        upload_url = str(release.get("upload_url") or "").split("{")[0]
        if not upload_url:
            raise NodeOperationError("The release has no upload URL", item_index=i)
        params = {"name": name, **({"label": options["label"]} if options.get("label") else {})}
        asset = api.call("POST", upload_url, params=params, data=content, headers={"Content-Type": content_type_of(ref, name)}, timeout=120)
        count_written(ctx, "github", "upload")
        return asset or {}

    def _archive(self, ctx, api: Api, i: int, repo: str) -> dict[str, Any]:
        """The repository's zip or tar archive at a reference, as binary data (GitHub redirects to a download URL)."""
        kind = str(ctx.get_node_parameter("archiveFormat", i) or "zipball")
        if kind not in ("zipball", "tarball"):
            raise NodeOperationError(f"Unknown archive format {kind!r}", item_index=i)
        reference = text_param(ctx, "archiveRef", i)
        resp = download(api, f"{repo}/{kind}/{quote(reference, safe='/')}".rstrip("/"), i)
        suffix = "zip" if kind == "zipball" else "tar.gz"
        disposition = resp.headers.get("Content-Disposition", "")
        match = re.search(r'filename="?([^";]+)"?', disposition)
        name = match.group(1) if match else f"{repo.rsplit('/', 1)[-1]}-{reference or 'default'}.{suffix}".replace("/", "-")
        info = {"name": name, "size": len(resp.content), **({"ref": reference} if reference else {})}
        return binary_out(ctx, info, i, self._output_name(ctx, i), resp.content, name, "application/zip" if kind == "zipball" else "application/gzip")


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
        "credentials": github_requirements(),
        "keywords": ["github", "issues", "pull request", "release", "poll"],
        "properties": [
            poll_interval_property(60),
            authentication_property("Access Token", APP_AUTHENTICATION),
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
        api = github_api(ctx, github_credentials(ctx, ctx.get_node_parameter("authentication")))
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


# --------------------------------------------------------- webhook trigger

WEBHOOK_EVENTS = [
    ("Any Event", "*", "Every event GitHub sends for the repository"),
    ("Check Run", "check_run", None),
    ("Check Suite", "check_suite", None),
    ("Commit Comment", "commit_comment", None),
    ("Create", "create", "A branch or tag was created"),
    ("Delete", "delete", "A branch or tag was deleted"),
    ("Deployment", "deployment", None),
    ("Deployment Status", "deployment_status", None),
    ("Discussion", "discussion", None),
    ("Discussion Comment", "discussion_comment", None),
    ("Fork", "fork", None),
    ("Issue Comment", "issue_comment", "A comment on an issue or pull request"),
    ("Issues", "issues", "An issue was opened, edited, closed, labeled, …"),
    ("Label", "label", None),
    ("Member", "member", None),
    ("Milestone", "milestone", None),
    ("Public", "public", None),
    ("Pull Request", "pull_request", "A pull request was opened, synchronized, closed, …"),
    ("Pull Request Review", "pull_request_review", None),
    ("Pull Request Review Comment", "pull_request_review_comment", None),
    ("Push", "push", "Commits were pushed to a branch or tag"),
    ("Release", "release", None),
    ("Repository", "repository", None),
    ("Star", "star", None),
    ("Status", "status", "A commit status changed"),
    ("Watch", "watch", None),
    ("Wiki Page", "gollum", None),
    ("Workflow Job", "workflow_job", None),
    ("Workflow Run", "workflow_run", None),
]
#: Delivery headers copied into each item (the signature is checked, not passed on).
DELIVERY_HEADERS = ("x-github-event", "x-github-delivery", "x-github-hook-id", "x-github-hook-installation-target-id",
                    "x-github-hook-installation-target-type", "user-agent", "content-type")
HOOK_PERMISSION_HINT = ("The token needs admin:repo_hook (classic) or Webhooks read and write (fine-grained), and admin access to the repository. "
                        "A GitHub App needs the Repository webhooks (read and write) permission and to be installed on the repository.")


class GitHubWebhookTrigger(RepositoryPicker, Node):
    """Registers a repository webhook (with a random secret) when the workflow is published; verifies every delivery's
    ``X-Hub-Signature-256`` and starts a run per event. Redeliveries (same ``X-GitHub-Delivery``) start no second run."""

    description = {
        "name": "githubWebhookTrigger",
        "displayName": "GitHub Webhook Trigger",
        "description": "Starts the workflow on repository events as GitHub sends them: pushes, pull requests, issues, releases, …",
        "version": 1,
        "kind": "trigger",
        "triggerSource": "appWebhook",
        "categories": ["Development"],
        "icon": "file:icons/github.svg",
        "color": "#24292F",
        "subtitle": "{{events}}",
        "documentationUrl": "https://docs.github.com/en/webhooks/webhook-events-and-payloads",
        "inputs": [],
        "outputs": [{"type": "main"}],
        "credentials": github_requirements(),
        "keywords": ["github", "webhook", "push", "pull request", "issues", "release", "event"],
        "properties": [
            authentication_property("Access Token", APP_AUTHENTICATION),
            {
                "name": "webhookNotice", "type": "notice", "default": "",
                "displayName": "Landflow creates the repository webhook when you publish the workflow and deletes it when you unpublish. "
                               + HOOK_PERMISSION_HINT,
            },
            *REPO_PROPERTIES,
            {
                "name": "events", "displayName": "Events", "type": "multiOptions", "default": ["push"], "required": True,
                "noDataExpression": True,
                "options": [{"name": name, "value": value, **({"description": text} if text else {})} for name, value, text in WEBHOOK_EVENTS],
                "description": "The events GitHub delivers; each starts one run",
            },
            {
                "name": "options", "displayName": "Options", "type": "collection", "default": {}, "placeholder": "Add option",
                "values": [
                    {"name": "insecureSsl", "displayName": "Insecure SSL", "type": "boolean", "default": False,
                     "description": "Let GitHub deliver to a URL whose TLS certificate it cannot verify (self-signed); not recommended"},
                ],
            },
        ],
    }

    def execute(self, ctx):
        # A manual run has no delivery: the trigger outputs nothing (pin data from a past execution to test downstream nodes).
        ctx.logger.info("GitHub sends events to the published workflow; a manual run has no event to output")
        return []

    # -- lifecycle (docs/protocol.md §12)

    @staticmethod
    def _events(ctx) -> list[str]:
        raw = ctx.get_node_parameter("events") or ["push"]
        events = [str(e) for e in (raw if isinstance(raw, list) else split_list(raw)) if str(e).strip()]
        return ["*"] if "*" in events else sorted(set(events)) or ["push"]

    def webhook_check_exists(self, ctx):
        hook_id = ctx.get_static_data().get("webhookId")
        if not hook_id:
            return False
        api = github_api(ctx, github_credentials(ctx, ctx.get_node_parameter("authentication")))
        resp = api.request("GET", f"{self.repo_path(ctx, 0)}/hooks/{hook_id}", expect=(404,))
        if resp.status == 404:
            return False
        hook = resp.json if isinstance(resp.json, dict) else {}
        return (hook.get("config") or {}).get("url") == ctx.get_webhook_url() and bool(hook.get("active", True))

    def webhook_create(self, ctx):
        api = github_api(ctx, github_credentials(ctx, ctx.get_node_parameter("authentication")))
        repo = self.repo_path(ctx, 0)
        secret = secrets.token_hex(32)
        events = self._events(ctx)
        insecure = bool(collection(ctx, "options", 0).get("insecureSsl"))
        body = {
            "name": "web",
            "active": True,
            "events": events,
            "config": {"url": ctx.get_webhook_url(), "content_type": "json", "secret": secret, "insecure_ssl": "1" if insecure else "0"},
        }
        with ctx.span("github.webhook.create", {"github.events": ",".join(events)}):
            resp = api.request("POST", f"{repo}/hooks", json=body, expect=(404, 422))
            if resp.status == 422 and self._delete_hooks_for(api, repo, ctx.get_webhook_url()):
                # A hook for this URL already exists (left over, its secret unknown): replace it.
                ctx.logger.info("replaced an existing GitHub webhook for this URL")
                resp = api.request("POST", f"{repo}/hooks", json=body, expect=(404,))
        if resp.status == 404:
            raise NodeOperationError("GitHub API error (HTTP 404): the repository was not found or the token cannot manage its webhooks",
                                     description=HOOK_PERMISSION_HINT)
        if resp.status >= 400:
            raise api_error("github", resp)
        hook = resp.json if isinstance(resp.json, dict) else {}
        ctx.set_static_data({"webhookId": hook.get("id"), "webhookSecret": secret, "webhookEvents": events})
        count_written(ctx, "github", "webhook.create")
        ctx.logger.info(f"GitHub webhook {hook.get('id')} created", events=",".join(events))
        return True

    @staticmethod
    def _delete_hooks_for(api: Api, repo: str, url: str) -> bool:
        hooks, _ = paginate(api, f"{repo}/hooks", {}, None, max_pages=5)
        doomed = [h for h in hooks if isinstance(h, dict) and (h.get("config") or {}).get("url") == url]
        for hook in doomed:
            api.request("DELETE", f"{repo}/hooks/{hook['id']}", expect=(404,))
        return bool(doomed)

    def webhook_delete(self, ctx):
        hook_id = ctx.get_static_data().get("webhookId")
        if hook_id:
            api = github_api(ctx, github_credentials(ctx, ctx.get_node_parameter("authentication")))
            resp = api.request("DELETE", f"{self.repo_path(ctx, 0)}/hooks/{hook_id}", expect=(404,))
            if resp.status != 404:
                count_written(ctx, "github", "webhook.delete")
        ctx.set_static_data({})
        return True

    def webhook(self, ctx):
        static = ctx.get_static_data()
        secret = str(static.get("webhookSecret") or "")
        if not verify_github_signature(secret, ctx.get_raw_body(), ctx.get_header("X-Hub-Signature-256")):
            ctx.logger.warn("rejected a delivery with a missing or invalid X-Hub-Signature-256")
            return {"response": {"status": 401, "json": {"error": "invalid signature"}}}
        event = ctx.get_header("X-GitHub-Event") or "unknown"
        delivery = ctx.get_header("X-GitHub-Delivery")
        body = ctx.get_body()
        if event == "ping":  # sent once when the hook is created
            return {"response": {"status": 200, "json": {"ok": True, "hookId": (body or {}).get("hook_id") if isinstance(body, dict) else None}}}
        events = static.get("webhookEvents") or ["*"]
        if "*" not in events and event not in events:
            return {"response": {"status": 202, "json": {"ignored": event}}}
        headers = {name: ctx.get_header(name) for name in DELIVERY_HEADERS if ctx.get_header(name) is not None}
        item = {
            "event": event,
            "action": body.get("action") if isinstance(body, dict) else None,
            "deliveryId": delivery,
            "body": body,
            "headers": headers,
        }
        count_new_items(ctx, "githubWebhook", 1)
        return {"items": [item], **({"idempotencyKey": delivery} if delivery else {})}
