"""Notion pages as activity items (docs/protocol.md §16).

The Notion Trigger polls for edited pages; the Notion node's Page → Get Many Changed Since and Get Content read the same
items on demand, User → Get Many lists the workspace's people with their email, and Comment → Create comments on a page.

These calls send ``Notion-Version: 2026-03-11``: databases hold data sources (2025-09-03), so a database is read through
``POST /v1/data_sources/{id}/query``, and a page in the trash says ``in_trash``. The node's older operations keep
``2022-06-28`` so saved workflows behave as before.

Notion can send page events to a webhook, but a subscription is created by hand in the integration's settings and an
event carries ids only, never content; the trigger polls instead.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from landflow_sdk import ACTIVITY_ITEM_SCHEMA, Node, NodeOperationError, activity_item, poll_interval_property
from landflow_sdk.http_client import HttpResponse

from .common import Api, api_error, authentication_property, count_api_error, count_new_items, credential_requirements, split_list
from .notion import (
    ACTIVITY_WITH_TEXT_SCHEMA,  # noqa: F401 - re-exported
    PAGE_SIZE,
    ROOTS_DESCRIPTION,  # noqa: F401 - re-exported
    activity_options_property,
    notion_credentials,
    page_id,
    plain_text,
    property_value,
    rich_text,
)

ACTIVITY_VERSION = "2026-03-11"
# How far each poll looks back past the last edit it saw: Notion's search index lags behind edits, and edit times can be
# coarse, so a poll re-reads this window and drops the versions it already output.
LOOKBACK = timedelta(minutes=5)
SEEN_MAX = 1000  # page versions remembered from the lookback window
MAX_SEARCH_PAGES = 20  # 100 pages each: at most 2,000 edited pages a poll
MANUAL_ITEMS = 5
PARENT_DEPTH = 20  # levels walked up from a page to its roots
SUMMARY_BLOCKS = 40  # blocks read for a summary
SUMMARY_CHARS = 2000
CONTENT_BLOCKS = 2000  # blocks read for Get Content
CONTENT_DEPTH = 8
CONTENT_CHARS = 200_000
RATE_LIMIT_RETRIES = 3
RATE_LIMIT_MAX_WAIT = 30.0
_SKIPPED_PROPERTY_TYPES = {"title", "created_time", "last_edited_time", "created_by", "last_edited_by", "rollup", "formula", "relation", "files"}


class NotionActivityApi(Api):
    """``Api`` on Notion-Version 2026-03-11 that waits out a 429 (``Retry-After`` seconds, at most 30) up to three times."""

    def request(self, method: str, path: str, **kwargs: Any) -> HttpResponse:
        expect = tuple(kwargs.pop("expect", ()))
        for attempt in range(RATE_LIMIT_RETRIES + 1):
            resp = super().request(method, path, expect=expect + (429,), **kwargs)
            if resp.status != 429:
                return resp
            if attempt == RATE_LIMIT_RETRIES:
                break
            try:
                wait = float(resp.headers.get("Retry-After") or 1)
            except ValueError:
                wait = 1.0
            wait = min(max(wait, 0.0), RATE_LIMIT_MAX_WAIT)
            self.ctx.logger.warning(f"Notion rate limit: waiting {wait:g} s before retrying {method} {path}")
            time.sleep(wait)
        if 429 in expect:
            return resp
        count_api_error(self.ctx, self.service, 429)
        raise api_error(self.service, resp, self.item_index)


def activity_api(ctx: Any, creds: dict[str, Any]) -> NotionActivityApi:
    return NotionActivityApi(ctx, "notion", creds.get("baseUrl") or "https://api.notion.com", {
        "Authorization": f"Bearer {creds.get('apiKey') or creds.get('accessToken') or ''}",
        "Notion-Version": ACTIVITY_VERSION,
    })


# ------------------------------------------------------------------ helpers


def norm_id(value: Any) -> str:
    """A Notion id compared without dashes or case (URLs carry 32 hex digits, the API dashed UUIDs)."""
    return str(value or "").replace("-", "").strip().lower()


def parse_time(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def edited_at(page: dict[str, Any]) -> str:
    return str(page.get("last_edited_time") or page.get("created_time") or "")


def version_key(page: dict[str, Any]) -> str:
    """One version of a page: its id and edit time (what a poll remembers having output)."""
    return f"{norm_id(page.get('id'))}@{edited_at(page)}"


def object_title(obj: dict[str, Any]) -> str:
    """A page's title property, a database's or data source's title, or a child page block's title."""
    if obj.get("object") == "page":
        for prop in (obj.get("properties") or {}).values():
            if isinstance(prop, dict) and prop.get("type") == "title":
                return plain_text(prop.get("title"))
        return ""
    if obj.get("object") in ("database", "data_source"):
        return plain_text(obj.get("title"))
    if obj.get("object") == "block" and obj.get("type") in ("child_page", "child_database"):
        return str((obj.get(obj["type"]) or {}).get("title") or "")
    return ""


def block_text(block: dict[str, Any]) -> str:
    kind = block.get("type") or ""
    data = block.get(kind) or {}
    if not isinstance(data, dict):
        return ""
    if kind in ("child_page", "child_database"):
        return str(data.get("title") or "")
    if kind == "table_row":
        return " | ".join(plain_text(cell) for cell in data.get("cells") or [])
    if kind == "equation":
        return str(data.get("expression") or "")
    text = plain_text(data.get("rich_text"))
    if kind == "to_do":
        return f"[{'x' if data.get('checked') else ' '}] {text}"
    if kind in ("bulleted_list_item", "numbered_list_item"):
        return f"- {text}"
    return text


def hint_after(titles: list[str], name: str) -> str | None:
    """The title right below an ancestor called ``name`` (``Customers/Acme/…`` → ``Acme``)."""
    if not name:
        return None
    wanted = name.strip().lower()
    for k in range(len(titles) - 1):
        if titles[k].strip().lower() == wanted:
            return titles[k + 1]
    return None


def property_line(page: dict[str, Any]) -> str:
    """A database row's properties as ``Status: Doing · Owner: Dana`` (titles and bookkeeping left out)."""
    parts = []
    for key, prop in (page.get("properties") or {}).items():
        if not isinstance(prop, dict) or prop.get("type") in _SKIPPED_PROPERTY_TYPES:
            continue
        value = property_value(prop)
        if value in (None, "", []) or value is False:
            continue
        shown = ", ".join(str(v) for v in value) if isinstance(value, list) else str(value)
        parts.append(f"{key}: {shown}")
    return " · ".join(parts)


def roots_of(value: Any) -> list[str]:
    """Pages or databases given as ids or links, separated by commas or new lines."""
    roots = []
    for entry in split_list(str(value or "").replace("\n", ",")):
        try:
            roots.append(page_id(entry, "Roots"))
        except NodeOperationError:
            continue
    return roots


# ------------------------------------------------------------------- reader


class NotionReader:
    """Pages to activity items for one run: caches users, ancestors and databases."""

    def __init__(self, ctx: Any, api: Api, options: dict[str, Any] | None = None) -> None:
        options = options or {}
        self.ctx = ctx
        self.api = api
        self.include_text = options.get("includeText", True) is not False
        self.customer_parent = str(options.get("customerParent", "Customers") or "")
        self.initiative_parent = str(options.get("initiativeParent", "Projects") or "")
        self._users: dict[str, dict[str, Any]] | None = None
        self._nodes: dict[str, dict[str, Any] | None] = {}
        self._databases: dict[str, dict[str, Any] | None] = {}

    # ---- people

    def users(self) -> list[dict[str, Any]]:
        if self._users is None:
            self._users = {}
            cursor = None
            for _ in range(100):
                params: dict[str, Any] = {"page_size": PAGE_SIZE}
                if cursor:
                    params["start_cursor"] = cursor
                resp = self.api.request("GET", "/v1/users", params=params, expect=(403,))
                if resp.status == 403:
                    self.ctx.logger.warning("The Notion integration can't read users: authors stay empty "
                                            "(turn on Read user information including email addresses)")
                    break
                body = resp.json or {}
                for user in body.get("results") or []:
                    if isinstance(user, dict) and user.get("id"):
                        self._users[norm_id(user["id"])] = user
                cursor = body.get("next_cursor")
                if not body.get("has_more") or not cursor:
                    break
        return list(self._users.values())

    def email_of(self, ref: Any) -> str | None:
        if not isinstance(ref, dict):
            return None
        email = (ref.get("person") or {}).get("email")
        if email or not ref.get("id"):
            return email
        self.users()
        return ((self._users or {}).get(norm_id(ref["id"])) or {}).get("person", {}).get("email")

    # ---- ancestry

    def _node(self, kind: str, node_id: str) -> dict[str, Any] | None:
        key = norm_id(node_id)
        if key not in self._nodes:
            path = {"page_id": "/v1/pages/", "database_id": "/v1/databases/", "block_id": "/v1/blocks/"}[kind] + node_id
            resp = self.api.request("GET", path, expect=(400, 403, 404))
            obj = resp.json if resp.ok and isinstance(resp.json, dict) else None
            self._nodes[key] = None if obj is None else {
                "id": obj.get("id") or node_id, "kind": kind, "title": object_title(obj), "parent": obj.get("parent")}
            if obj is not None and kind == "database_id":
                self._databases[key] = obj
        return self._nodes[key]

    def ancestors(self, obj: dict[str, Any]) -> list[dict[str, Any]]:
        """The pages, databases and blocks above ``obj``, nearest first: ``{id, kind, title}``."""
        chain: list[dict[str, Any]] = []
        parent = obj.get("parent")
        visited: set[str] = set()
        for _ in range(PARENT_DEPTH):
            if not isinstance(parent, dict):
                break
            kind = parent.get("type")
            node_id = parent.get(kind) if isinstance(kind, str) else None
            if kind == "data_source_id":  # a database row: the data source, then its database
                chain.append({"id": node_id, "kind": kind, "title": ""})
                kind, node_id = "database_id", parent.get("database_id")
            if kind not in ("page_id", "database_id", "block_id") or not node_id or norm_id(node_id) in visited:
                break
            visited.add(norm_id(node_id))
            node = self._node(kind, node_id)
            if node is None:  # not shared with the integration: the walk stops here
                chain.append({"id": node_id, "kind": kind, "title": ""})
                break
            chain.append(node)
            parent = node["parent"]
        return chain

    @staticmethod
    def under(page: dict[str, Any], chain: list[dict[str, Any]], roots: set[str]) -> bool:
        return norm_id(page.get("id")) in roots or any(norm_id(node["id"]) in roots for node in chain)

    # ---- text

    def text(self, block_id: str, max_blocks: int, max_depth: int, max_chars: int) -> str:
        lines: list[str] = []
        state = {"blocks": 0, "chars": 0}

        def walk(parent: str, depth: int) -> bool:  # True: a limit was reached
            cursor = None
            while True:
                params: dict[str, Any] = {"page_size": PAGE_SIZE}
                if cursor:
                    params["start_cursor"] = cursor
                body = self.api.get(f"/v1/blocks/{parent}/children", params=params) or {}
                for block in body.get("results") or []:
                    if not isinstance(block, dict):
                        continue
                    state["blocks"] += 1
                    line = block_text(block)
                    if line:
                        lines.append(line)
                        state["chars"] += len(line) + 1
                    if state["chars"] >= max_chars or state["blocks"] >= max_blocks:
                        return True
                    nested = block.get("has_children") and block.get("type") not in ("child_page", "child_database")
                    if nested and depth < max_depth and walk(block["id"], depth + 1):
                        return True
                cursor = body.get("next_cursor")
                if not body.get("has_more") or not cursor:
                    return False

        walk(block_id, 0)
        return "\n".join(lines)[:max_chars]

    # ---- items

    def item(self, page: dict[str, Any], *, cursor: Any = None, with_cursor: bool = False, with_text: bool = False) -> dict[str, Any]:
        pid = str(page.get("id") or "")
        chain = self.ancestors(page)
        titles = [node["title"] for node in reversed(chain) if node.get("title")]
        title = object_title(page) or "Untitled"
        text = ""
        if with_text:
            text = self.text(pid, CONTENT_BLOCKS, CONTENT_DEPTH, CONTENT_CHARS)
        elif self.include_text:
            text = self.text(pid, SUMMARY_BLOCKS, 1, SUMMARY_CHARS)
        props = property_line(page)
        location = "/".join(titles) or "the workspace"
        summary = " ".join(part for part in (props, text) if part) or f"Notion page in {location}"
        parent = page.get("parent") or {}
        raw = {
            "id": pid, "title": title, "path": location, "parentType": parent.get("type"),
            "databaseId": parent.get("database_id"), "dataSourceId": parent.get("data_source_id"),
            "createdTime": page.get("created_time"), "lastEditedTime": page.get("last_edited_time"),
            "createdBy": self.email_of(page.get("created_by")), "properties": props or None,
        }
        extra: dict[str, Any] = {"cursor": cursor} if with_cursor else {}
        item = activity_item(
            source="notion", source_id=f"notion:{pid}:{edited_at(page)}", url=page.get("url"),
            actor_email=self.email_of(page.get("last_edited_by")), occurred_at=edited_at(page), kind="work.doc_edited",
            title=title, summary=summary, customer_hint=hint_after(titles, self.customer_parent),
            initiative_hint=hint_after(titles, self.initiative_parent), raw=raw, **extra,
        )
        if with_text:
            item["text"] = text
        return item

    # ---- finding edits

    def _database(self, root: str) -> dict[str, Any] | None:
        key = norm_id(root)
        if key not in self._databases:
            resp = self.api.request("GET", f"/v1/databases/{root}", expect=(400, 403, 404))
            self._databases[key] = resp.json if resp.ok and isinstance(resp.json, dict) else None
        return self._databases[key]

    def _query_data_source(self, data_source: str, since: datetime) -> list[dict[str, Any]]:
        pages: list[dict[str, Any]] = []
        cursor = None
        for _ in range(MAX_SEARCH_PAGES):
            body: dict[str, Any] = {
                "filter": {"timestamp": "last_edited_time", "last_edited_time": {"on_or_after": iso(since)}},
                "sorts": [{"timestamp": "last_edited_time", "direction": "ascending"}],
                "page_size": PAGE_SIZE,
            }
            if cursor:
                body["start_cursor"] = cursor
            page = self.api.call("POST", f"/v1/data_sources/{data_source}/query", json=body) or {}
            pages.extend(p for p in page.get("results") or [] if isinstance(p, dict) and p.get("object") == "page")
            cursor = page.get("next_cursor")
            if not page.get("has_more") or not cursor:
                break
        return pages

    def changed(self, since: datetime, roots: list[str], *, max_pages: int = MAX_SEARCH_PAGES) -> list[dict[str, Any]]:
        """Pages edited on or after ``since`` (under ``roots`` when given), oldest first, not in the trash.

        Search sorted by last edit finds them everywhere; each root database's data sources are queried too, since the
        search index lags behind edits."""
        root_keys = {norm_id(r) for r in roots}
        found: dict[str, dict[str, Any]] = {}

        def keep(page: dict[str, Any]) -> None:
            if page.get("in_trash") or page.get("archived"):
                return
            if root_keys and not self.under(page, self.ancestors(page), root_keys):
                return
            key = norm_id(page.get("id"))
            if key not in found or edited_at(page) > edited_at(found[key]):
                found[key] = page

        with self.ctx.span("notion.changed", {"landflow.roots": len(roots)}) as span:
            cursor = None
            searched = 0
            for _ in range(max_pages):
                body: dict[str, Any] = {"filter": {"property": "object", "value": "page"},
                                        "sort": {"timestamp": "last_edited_time", "direction": "descending"}, "page_size": PAGE_SIZE}
                if cursor:
                    body["start_cursor"] = cursor
                page = self.api.call("POST", "/v1/search", json=body) or {}
                older = False
                for result in page.get("results") or []:
                    if not isinstance(result, dict) or result.get("object") != "page":
                        continue
                    searched += 1
                    edited = parse_time(edited_at(result))
                    if edited is not None and edited < since:
                        older = True
                        break
                    keep(result)
                cursor = page.get("next_cursor")
                if older or not page.get("has_more") or not cursor:
                    break
            for root in roots:
                database = self._database(root)
                for source in (database or {}).get("data_sources") or []:
                    if isinstance(source, dict) and source.get("id"):
                        for result in self._query_data_source(source["id"], since):
                            keep(result)
            span.set_attributes({"landflow.searched": searched, "landflow.items": len(found)})
        return sorted(found.values(), key=edited_at)

    def recent(self, roots: list[str], count: int) -> list[dict[str, Any]]:
        """The ``count`` pages edited last (under ``roots``), oldest first: one search page."""
        root_keys = {norm_id(r) for r in roots}
        body = {"filter": {"property": "object", "value": "page"}, "sort": {"timestamp": "last_edited_time", "direction": "descending"},
                "page_size": PAGE_SIZE}
        pages = []
        for result in (self.api.call("POST", "/v1/search", json=body) or {}).get("results") or []:
            if not isinstance(result, dict) or result.get("object") != "page" or result.get("in_trash") or result.get("archived"):
                continue
            if root_keys and not self.under(result, self.ancestors(result), root_keys):
                continue
            pages.append(result)
            if len(pages) == count:
                break
        return list(reversed(pages))


# ------------------------------------------------------------------- trigger


class NotionTrigger(Node):
    description = {
        "name": "notionTrigger",
        "displayName": "Notion Trigger",
        "description": "Starts the workflow when pages are created or edited in Notion (under chosen pages or databases), each as an activity item",
        "version": 1,
        "kind": "trigger",
        "triggerSource": "poll",
        "categories": ["Productivity"],
        "icon": "file:icons/notion.svg",
        "color": "#000000",
        "documentationUrl": "https://developers.notion.com/reference/post-search",
        "inputs": [],
        "outputs": [{"type": "main"}],
        "credentials": credential_requirements("notionApi", "notionOAuth2Api"),
        "keywords": ["notion", "page edited", "page updated", "wiki", "activity", "poll"],
        "outputSchema": ACTIVITY_ITEM_SCHEMA,
        "properties": [
            poll_interval_property(300),
            authentication_property("Internal Integration Secret"),
            {"name": "pollNotice", "type": "notice", "default": "",
             "displayName": "The first poll only records the time; later polls output each page edited since, once per edit. "
                            "Executing the node in the editor returns the 5 pages edited last."},
            {"name": "roots", "displayName": "Roots", "type": "string", "default": "", "typeOptions": {"rows": 2},
             "placeholder": "https://www.notion.so/Team-wiki-0123456789abcdef0123456789abcdef", "description": ROOTS_DESCRIPTION},
            activity_options_property(),
        ],
    }

    def execute(self, ctx):
        api = activity_api(ctx, notion_credentials(ctx, ctx.get_node_parameter("authentication")))
        reader = NotionReader(ctx, api, ctx.get_node_parameter("activityOptions", 0, {}) or {})
        roots = roots_of(ctx.get_node_parameter("roots", 0, ""))
        if ctx.mode != "poll":
            return [{"json": reader.item(page)} for page in reader.recent(roots, MANUAL_ITEMS)]

        now = datetime.now(timezone.utc)
        state = ctx.get_poll_state() or {}
        since = parse_time(state.get("since")) if state.get("since") else None
        if since is None:  # baseline: remember what was edited in the lookback window, output nothing
            recent = reader.changed(now - LOOKBACK, roots, max_pages=1)
            ctx.set_poll_state({"since": iso(now), "seen": [version_key(p) for p in recent][-SEEN_MAX:]})
            return []

        seen = set(state.get("seen") or [])
        pages = reader.changed(since - LOOKBACK, roots)
        fresh = [page for page in pages if version_key(page) not in seen]
        latest = max([since, *(t for t in (parse_time(edited_at(p)) for p in pages) if t is not None)])
        floor = latest - LOOKBACK

        def recent_enough(key: str) -> bool:
            moment = parse_time(key.partition("@")[2])
            return moment is not None and moment >= floor

        kept = [version_key(p) for p in pages if recent_enough(version_key(p))]
        kept += [key for key in state.get("seen") or [] if isinstance(key, str) and recent_enough(key)]
        ctx.set_poll_state({"since": iso(latest), "seen": list(dict.fromkeys(kept))[-SEEN_MAX:]})
        items = [{"json": reader.item(page)} for page in fresh]
        count_new_items(ctx, "notion", len(items))
        if items:
            ctx.logger.info(f"{len(items)} edited Notion page(s)")
        return items


# ------------------------------------------------------------ node operations


def changed_since(ctx: Any, api: Api, i: int, limit: int | None) -> list[dict[str, Any]]:
    """Page → Get Many Changed Since: pages edited on or after Since (an ISO time; empty: 24 hours ago), oldest first,
    each with ``cursor`` = its edit time (pass the last one as the next Since)."""
    raw_since = str(ctx.get_node_parameter("since", i, "") or "").strip()
    since = parse_time(raw_since) if raw_since else datetime.now(timezone.utc) - timedelta(hours=24)
    if since is None:
        raise NodeOperationError(f"'Since' must be an ISO time such as 2026-11-12T08:00:00Z, got {raw_since!r}", item_index=i)
    reader = NotionReader(ctx, api, ctx.get_node_parameter("activityOptions", i, {}) or {})
    pages = reader.changed(since, roots_of(ctx.get_node_parameter("roots", i, "")))
    if limit is not None:
        pages = pages[:limit]
    return [reader.item(page, cursor=edited_at(page), with_cursor=True) for page in pages]


def get_content(ctx: Any, api: Api, i: int) -> dict[str, Any]:
    """Page → Get Content: one page as an activity item plus its whole text (nested blocks, up to 2,000 blocks)."""
    page = api.get(f"/v1/pages/{page_id(ctx.get_node_parameter('pageId', i), 'Page', i)}") or {}
    return NotionReader(ctx, api, ctx.get_node_parameter("activityOptions", i, {}) or {}).item(page, with_text=True)


def list_users(ctx: Any, api: Api, i: int, limit: int | None) -> list[dict[str, Any]]:
    """User → Get Many: people and bots with email (people only, when the integration may read emails)."""
    users = NotionReader(ctx, api).users()
    if not users and api.request("GET", "/v1/users", params={"page_size": 1}, expect=(403,)).status == 403:
        raise NodeOperationError("The Notion integration can't read users", item_index=i,
                                 description="In the integration's Capabilities, turn on Read user information including email addresses.")
    simple = [{
        "id": user.get("id"), "name": user.get("name"), "email": (user.get("person") or {}).get("email"),
        "type": user.get("type"), "avatarUrl": user.get("avatar_url"),
    } for user in users]
    return simple if limit is None else simple[:limit]


def create_comment(ctx: Any, api: Api, i: int) -> dict[str, Any]:
    """Comment → Create: a comment on a page, or a reply in a discussion."""
    text = str(ctx.get_node_parameter("commentText", i, "") or "").strip()
    if not text:
        raise NodeOperationError("'Comment' is required", item_index=i)
    discussion = str(ctx.get_node_parameter("discussionId", i, "") or "").strip()
    body: dict[str, Any] = {"rich_text": rich_text(text)}
    if discussion:
        body["discussion_id"] = discussion
    else:
        body["parent"] = {"page_id": page_id(ctx.get_node_parameter("commentPageId", i), "Page", i)}
    return api.call("POST", "/v1/comments", json=body) or {}
