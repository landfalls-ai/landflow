"""Notion: database pages (create, query), pages (get, archive, search) and blocks (append)."""

from __future__ import annotations

import re
from typing import Any

from landflow_sdk import CredentialType, Node, NodeOperationError

from .common import (
    Api,
    bool_param,
    chunks,
    collection,
    count_written,
    fixed_entries,
    item_errors,
    items_of,
    json_param,
    limit_of,
    operation_property,
    out,
    outs,
    resource_property,
    return_all_properties,
    simplify_property,
    split_list,
    test_call,
    text_param,
)

NOTION_VERSION = "2022-06-28"
PAGE_SIZE = 100  # Notion's maximum page_size
MAX_CHILDREN = 100  # blocks per append request
MAX_TEXT = 2000  # characters per rich_text object
_ID_RE = re.compile(r"([0-9a-f]{32})(?:[?#].*)?$", re.IGNORECASE)
_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)


def notion_api(ctx: Any, creds: dict[str, Any]) -> Api:
    return Api(ctx, "notion", creds.get("baseUrl") or "https://api.notion.com", {
        "Authorization": f"Bearer {creds.get('apiKey', '')}",
        "Notion-Version": NOTION_VERSION,
    })


def test_notion(data: dict[str, Any], ctx: Any) -> tuple[bool, str]:
    ok, reason, me = test_call(notion_api(ctx, data), "/v1/users/me")
    if not ok:
        return False, reason or "Notion rejected the token"
    return True, f"authenticated as {me.get('name') or me.get('id')}" if isinstance(me, dict) else "authenticated"


NOTION_API = CredentialType(
    name="notionApi",
    display_name="Notion API",
    documentation_url="https://developers.notion.com/docs/authorization",
    description="An internal integration secret. Share the pages and databases with the integration in Notion.",
    test=test_notion,
    properties=[
        {"name": "apiKey", "displayName": "Internal Integration Secret", "type": "string", "required": True,
         "typeOptions": {"password": True}, "placeholder": "secret_… / ntn_…"},
        {"name": "baseUrl", "displayName": "API Base URL", "type": "string", "default": "https://api.notion.com",
         "description": "Change only for a proxy or a test double"},
    ],
)


def page_id(value: Any, label: str = "Page", item_index: int | None = None) -> str:
    """An id, a dashed UUID or a Notion URL (``https://www.notion.so/Title-<32 hex>``) -> the id."""
    text = str(value or "").strip()
    if not text:
        raise NodeOperationError(f"'{label}' is required", item_index=item_index)
    match = _UUID_RE.search(text)
    if match:
        return match.group(0)
    match = _ID_RE.search(text.split("?")[0].rstrip("/")) or _ID_RE.search(text)
    return match.group(1) if match else text


# --------------------------------------------------------------- simplify


def plain_text(rich: Any) -> str:
    return "".join(part.get("plain_text") or (part.get("text") or {}).get("content", "") for part in rich or [] if isinstance(part, dict))


def _user_name(user: Any) -> Any:
    return (user.get("name") or user.get("id")) if isinstance(user, dict) else user


def property_value(prop: dict[str, Any]) -> Any:
    """One Notion property value -> a plain JSON value."""
    kind = prop.get("type")
    value = prop.get(kind) if kind else None
    if kind in ("title", "rich_text"):
        return plain_text(value)
    if kind in ("select", "status"):
        return value.get("name") if isinstance(value, dict) else None
    if kind == "multi_select":
        return [option.get("name") for option in value or []]
    if kind == "date":
        return value.get("start") if isinstance(value, dict) else None
    if kind == "people":
        return [_user_name(user) for user in value or []]
    if kind == "relation":
        return [ref.get("id") for ref in value or []]
    if kind in ("created_by", "last_edited_by"):
        return _user_name(value)
    if kind == "files":
        return [(f.get("file") or f.get("external") or {}).get("url") or f.get("name") for f in value or []]
    if kind == "formula" and isinstance(value, dict):
        inner = value.get(value.get("type"))
        return inner.get("start") if isinstance(inner, dict) else inner
    if kind == "rollup" and isinstance(value, dict):
        inner = value.get(value.get("type"))
        if value.get("type") == "array":
            return [property_value(entry) for entry in inner or []]
        return inner.get("start") if isinstance(inner, dict) else inner
    if kind == "unique_id" and isinstance(value, dict):
        return f"{value['prefix']}-{value.get('number')}" if value.get("prefix") else value.get("number")
    return value  # number, checkbox, url, email, phone_number, created_time, last_edited_time, …


def simplify_page(page: dict[str, Any]) -> dict[str, Any]:
    """``{id, name, url, <property>: <plain value>, …}`` for a page; ``{id, name, url, object}`` for a database."""
    if page.get("object") == "database":
        return {"id": page.get("id"), "name": plain_text(page.get("title")), "url": page.get("url"), "object": "database"}
    properties = page.get("properties") or {}
    name = next((plain_text(p.get("title")) for p in properties.values() if isinstance(p, dict) and p.get("type") == "title"), "")
    simple: dict[str, Any] = {"id": page.get("id"), "name": name, "url": page.get("url")}
    for key, prop in properties.items():
        if isinstance(prop, dict):
            simple[f"property_{key}" if key in ("id", "name", "url") else key] = property_value(prop)
    return simple


# ------------------------------------------------------------ write values


def rich_text(text: str) -> list[dict[str, Any]]:
    """Text -> rich_text objects of at most 2000 characters each (Notion's limit)."""
    return [{"type": "text", "text": {"content": text[i:i + MAX_TEXT]}} for i in range(0, len(text), MAX_TEXT)] or []


def _number(value: Any, key: str, i: int) -> float | int | None:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise NodeOperationError(f"Property '{key}' must be a number, got {value!r}", item_index=i) from None
    return int(number) if number.is_integer() else number


def property_payload(kind: str, value: Any, key: str, i: int) -> dict[str, Any]:
    """A key/value row (text / title / number / select / multi_select / checkbox / date / url / email) -> a Notion property value."""
    text = "" if value is None else str(value)
    if kind == "title":
        return {"title": rich_text(text)}
    if kind in ("text", "rich_text"):
        return {"rich_text": rich_text(text)}
    if kind == "number":
        return {"number": _number(value, key, i)}
    if kind == "select":
        return {"select": {"name": text} if text else None}
    if kind == "multi_select":
        return {"multi_select": [{"name": name} for name in split_list(value)]}
    if kind == "status":
        return {"status": {"name": text} if text else None}
    if kind == "checkbox":
        return {"checkbox": value if isinstance(value, bool) else text.strip().lower() in ("true", "1", "yes", "on")}
    if kind == "date":
        return {"date": {"start": text} if text else None}
    if kind in ("url", "email", "phone_number"):
        return {kind: text or None}
    raise NodeOperationError(f"Unsupported property type {kind!r} for '{key}'", item_index=i)


def paragraph_blocks(text: str) -> list[dict[str, Any]]:
    """Blank-line separated paragraphs -> paragraph blocks."""
    paragraphs = [p.strip("\n") for p in re.split(r"\n\s*\n", text.replace("\r\n", "\n")) if p.strip()]
    return [{"object": "block", "type": "paragraph", "paragraph": {"rich_text": rich_text(p)}} for p in paragraphs]


# -------------------------------------------------------------------- node

DB_PAGE = {"resource": ["databasePage"]}

PROPERTY_TYPES = [
    ("Text", "text"), ("Number", "number"), ("Select", "select"), ("Multi-Select", "multi_select"), ("Status", "status"),
    ("Checkbox", "checkbox"), ("Date", "date"), ("URL", "url"), ("Email", "email"), ("Phone", "phone_number"), ("Title", "title"),
]


class Notion(Node):
    description = {
        "name": "notion",
        "displayName": "Notion",
        "description": "Create and query Notion database pages, get, archive and search pages, append blocks",
        "version": 1,
        "kind": "action",
        "idempotent": False,  # creates, updates, archives and comments are at most once over a broker; the read operations opt in below
        "categories": ["Productivity"],
        "icon": "file:icons/notion.svg",
        "color": "#000000",
        "subtitle": "{{operation}}: {{resource}}",
        "documentationUrl": "https://developers.notion.com/reference/intro",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "credentials": [{"name": "notionApi", "required": True}],
        "usableAsTool": True,
        "toolDescription": (
            "Work with Notion. Pick `resource` (databasePage, page, block) and `operation`: create a database page "
            "(`databaseId`, `title`), query a database (`databaseId`, optional `filterJson`), get or archive a page "
            "(`pageId`), search pages (`text`), or append paragraphs to a page (`blockId`, `text`)."
        ),
        "keywords": ["notion", "wiki", "database", "page", "notes", "docs"],
        "properties": [
            resource_property([("Block", "block"), ("Database Page", "databasePage"), ("Page", "page")], "databasePage"),
            # The default resource's operation comes last: fresh nodes take the last default of a repeated name.
            operation_property("block", [("Append After", "append", "Append a block")], "append"),
            operation_property("page", [
                ("Archive", "archive", "Archive a page"),
                ("Get", "get", "Get a page", True),
                ("Search", "search", "Search pages", True),
            ], "get"),
            operation_property("databasePage", [
                ("Create", "create", "Create a database page"),
                ("Get Many", "getAll", "Get many database pages", True),
            ], "create"),
            # ---- database page
            {
                "name": "databaseId", "displayName": "Database", "type": "options", "default": "", "required": True,
                "typeOptions": {"loadOptionsMethod": "getDatabases"},
                "description": "Databases shared with the integration (or an id / URL through an expression)",
                "displayOptions": {"show": {**DB_PAGE, "operation": ["create", "getAll"]}},
            },
            {
                "name": "title", "displayName": "Title", "type": "string", "default": "",
                "description": "Value of the database's title property",
                "displayOptions": {"show": {**DB_PAGE, "operation": ["create"]}},
            },
            {
                "name": "propertiesUi", "displayName": "Properties", "type": "fixedCollection", "default": {},
                "typeOptions": {"multipleValues": True}, "placeholder": "Add Property",
                "displayOptions": {"show": {**DB_PAGE, "operation": ["create"]}},
                "groups": [{
                    "name": "propertyValues", "displayName": "Property",
                    "values": [
                        {"name": "key", "displayName": "Name", "type": "string", "default": "", "description": "Property name as shown in Notion"},
                        {"name": "type", "displayName": "Type", "type": "options", "default": "text",
                         "options": [{"name": n, "value": v} for n, v in PROPERTY_TYPES]},
                        {"name": "value", "displayName": "Value", "type": "string", "default": "",
                         "description": "Multi-select: comma-separated; checkbox: true/false; date: ISO 8601"},
                    ],
                }],
            },
            {
                "name": "propertiesJson", "displayName": "Properties (JSON)", "type": "json", "default": "",
                "description": "Raw Notion property values, merged over the fields above, e.g. {\"Tags\": {\"multi_select\": [{\"name\": \"a\"}]}}",
                "displayOptions": {"show": {**DB_PAGE, "operation": ["create"]}},
            },
            *return_all_properties({**DB_PAGE, "operation": ["getAll"]}),
            {
                "name": "filterJson", "displayName": "Filter (JSON)", "type": "json", "default": "",
                "description": "A Notion filter object, e.g. {\"property\": \"Status\", \"status\": {\"equals\": \"Done\"}}",
                "displayOptions": {"show": {**DB_PAGE, "operation": ["getAll"]}},
            },
            {
                "name": "sortsJson", "displayName": "Sorts (JSON)", "type": "json", "default": "",
                "description": "An array of Notion sort objects, e.g. [{\"property\": \"Due\", \"direction\": \"ascending\"}]",
                "displayOptions": {"show": {**DB_PAGE, "operation": ["getAll"]}},
            },
            # ---- page
            {
                "name": "pageId", "displayName": "Page", "type": "string", "default": "", "required": True,
                "placeholder": "https://www.notion.so/My-page-0123456789abcdef0123456789abcdef",
                "description": "Page id or URL",
                "displayOptions": {"show": {"resource": ["page"], "operation": ["archive", "get"]}},
            },
            {
                "name": "text", "displayName": "Search Text", "type": "string", "default": "",
                "description": "Text to search for in page titles (empty: everything shared with the integration)",
                "displayOptions": {"show": {"resource": ["page"], "operation": ["search"]}},
            },
            *return_all_properties({"resource": ["page"], "operation": ["search"]}),
            {
                "name": "searchOptions", "displayName": "Options", "type": "collection", "default": {}, "placeholder": "Add option",
                "displayOptions": {"show": {"resource": ["page"], "operation": ["search"]}},
                "values": [
                    {"name": "objectType", "displayName": "Object Type", "type": "options", "default": "page",
                     "options": [{"name": "Pages", "value": "page"}, {"name": "Databases", "value": "database"}]},
                    {"name": "sortDirection", "displayName": "Sort by Last Edited", "type": "options", "default": "descending",
                     "options": [{"name": "Newest First", "value": "descending"}, {"name": "Oldest First", "value": "ascending"}]},
                ],
            },
            simplify_property({"resource": ["databasePage", "page"], "operation": ["create", "getAll", "get", "archive", "search"]}),
            # ---- block
            {
                "name": "blockId", "displayName": "Page or Block", "type": "string", "default": "", "required": True,
                "description": "Page or block id or URL; the new blocks are appended to its children",
                "displayOptions": {"show": {"resource": ["block"]}},
            },
            {
                "name": "blockSource", "displayName": "Content", "type": "options", "default": "text",
                "displayOptions": {"show": {"resource": ["block"]}},
                "options": [
                    {"name": "Paragraph Text", "value": "text", "description": "One paragraph per blank-line separated block of text"},
                    {"name": "Blocks (JSON)", "value": "json", "description": "An array of Notion block objects"},
                ],
            },
            {
                "name": "blockText", "displayName": "Text", "type": "string", "default": "", "typeOptions": {"rows": 4},
                "displayOptions": {"show": {"resource": ["block"], "blockSource": ["text"]}},
            },
            {
                "name": "blocksJson", "displayName": "Blocks (JSON)", "type": "json", "default": "",
                "description": "e.g. [{\"type\": \"to_do\", \"to_do\": {\"rich_text\": [{\"text\": {\"content\": \"Ship it\"}}]}}]",
                "displayOptions": {"show": {"resource": ["block"], "blockSource": ["json"]}},
            },
        ],
    }

    def load_options(self, method, parameters, ctx=None):
        if method == "getDatabases":
            api = notion_api(ctx, ctx.get_credentials("notionApi"))
            options, cursor = [], None
            for _ in range(10):
                body = {"filter": {"property": "object", "value": "database"}, "page_size": PAGE_SIZE}
                if cursor:
                    body["start_cursor"] = cursor
                page = api.call("POST", "/v1/search", json=body) or {}
                for db in page.get("results") or []:
                    options.append({"name": plain_text(db.get("title")) or db.get("id"), "value": db.get("id"), "description": db.get("url")})
                cursor = page.get("next_cursor")
                if not page.get("has_more") or not cursor:
                    break
            return sorted(options, key=lambda o: str(o["name"]).lower())
        return super().load_options(method, parameters, ctx)

    def execute(self, ctx):
        api = notion_api(ctx, ctx.get_credentials("notionApi"))
        schemas: dict[str, dict[str, Any]] = {}
        results = []
        for i, _item in enumerate(items_of(ctx)):
            with item_errors(ctx, results, i):
                api.item_index = i
                resource = ctx.get_node_parameter("resource", i)
                operation = ctx.get_node_parameter("operation", i)
                simplify = bool_param(ctx, "simplify", i, True)
                shape = simplify_page if simplify else (lambda page: page)
                if resource == "databasePage" and operation == "create":
                    results.append(out(shape(self._create_page(ctx, api, i, schemas)), i))
                    count_written(ctx, "notion", "create")
                elif resource == "databasePage" and operation == "getAll":
                    results.extend(outs(map(shape, self._query(ctx, api, i)), i))
                elif resource == "page" and operation == "get":
                    results.append(out(shape(api.get(f"/v1/pages/{page_id(ctx.get_node_parameter('pageId', i), 'Page', i)}")), i))
                elif resource == "page" and operation == "archive":
                    page = api.call("PATCH", f"/v1/pages/{page_id(ctx.get_node_parameter('pageId', i), 'Page', i)}", json={"archived": True})
                    results.append(out(shape(page), i))
                    count_written(ctx, "notion", "archive")
                elif resource == "page" and operation == "search":
                    results.extend(outs(map(shape, self._search(ctx, api, i)), i))
                elif resource == "block" and operation == "append":
                    results.append(out(self._append(ctx, api, i), i))
                else:
                    raise NodeOperationError(f"Unsupported operation {resource}.{operation}", item_index=i)
        return results

    # ------------------------------------------------------------ operations

    def _create_page(self, ctx, api: Api, i: int, schemas: dict[str, dict[str, Any]]) -> dict[str, Any]:
        database = page_id(ctx.get_node_parameter("databaseId", i), "Database", i)
        properties: dict[str, Any] = {}
        title = text_param(ctx, "title", i)
        rows = fixed_entries(ctx.get_node_parameter("propertiesUi", i), "propertyValues")
        if title or any(row.get("type", "text") == "text" for row in rows):
            if database not in schemas:  # the title property's name and the real type of "text" rows
                schemas[database] = (api.get(f"/v1/databases/{database}") or {}).get("properties") or {}
            schema = schemas[database]
        else:
            schema = {}
        if title:
            title_key = next((key for key, prop in schema.items() if prop.get("type") == "title"), "Name")
            properties[title_key] = {"title": rich_text(title)}
        for row in rows:
            key = str(row.get("key") or "").strip()
            if not key:
                continue
            kind = row.get("type") or "text"
            if kind == "text" and (schema.get(key) or {}).get("type") == "title":
                kind = "title"
            properties[key] = property_payload(kind, row.get("value"), key, i)
        properties.update(json_param(ctx, "propertiesJson", i, label="Properties (JSON)") or {})
        return api.call("POST", "/v1/pages", json={"parent": {"database_id": database}, "properties": properties})

    def _query(self, ctx, api: Api, i: int) -> list[dict[str, Any]]:
        database = page_id(ctx.get_node_parameter("databaseId", i), "Database", i)
        body: dict[str, Any] = {}
        filter_ = json_param(ctx, "filterJson", i, label="Filter (JSON)")
        sorts = json_param(ctx, "sortsJson", i, expect=list, label="Sorts (JSON)")
        if filter_:
            body["filter"] = filter_
        if sorts:
            body["sorts"] = sorts
        return self._paginate(ctx, api, "notion.query", f"/v1/databases/{database}/query", body, limit_of(ctx, i))

    def _search(self, ctx, api: Api, i: int) -> list[dict[str, Any]]:
        options = collection(ctx, "searchOptions", i)
        body: dict[str, Any] = {}
        text = text_param(ctx, "text", i)
        if text:
            body["query"] = text
        if options.get("objectType"):
            body["filter"] = {"property": "object", "value": options["objectType"]}
        if options.get("sortDirection"):
            body["sort"] = {"direction": options["sortDirection"], "timestamp": "last_edited_time"}
        return self._paginate(ctx, api, "notion.search", "/v1/search", body, limit_of(ctx, i))

    @staticmethod
    def _paginate(ctx, api: Api, span_name: str, path: str, body: dict[str, Any], limit: int | None) -> list[dict[str, Any]]:
        """POST ``path`` page by page (``start_cursor`` / ``next_cursor``) until ``limit`` results or the end."""
        found: list[dict[str, Any]] = []
        pages = 0
        with ctx.span(span_name, {"landflow.return_all": limit is None}) as span:
            cursor = None
            while True:
                request = {**body, "page_size": PAGE_SIZE if limit is None else min(PAGE_SIZE, limit - len(found))}
                if cursor:
                    request["start_cursor"] = cursor
                page = api.call("POST", path, json=request) or {}
                pages += 1
                found.extend(page.get("results") or [])
                cursor = page.get("next_cursor")
                if not page.get("has_more") or not cursor or (limit is not None and len(found) >= limit):
                    break
            span.set_attributes({"landflow.pages": pages, "landflow.items": len(found)})
        return found if limit is None else found[:limit]

    def _append(self, ctx, api: Api, i: int) -> dict[str, Any]:
        block = page_id(ctx.get_node_parameter("blockId", i), "Page or Block", i)
        if ctx.get_node_parameter("blockSource", i) == "json":
            blocks = json_param(ctx, "blocksJson", i, expect=(list, dict), label="Blocks (JSON)") or []
            if isinstance(blocks, dict):
                blocks = blocks.get("children") or [blocks]
        else:
            blocks = paragraph_blocks(str(ctx.get_node_parameter("blockText", i) or ""))
        if not blocks:
            raise NodeOperationError("Nothing to append: the text or the blocks JSON is empty", item_index=i)
        appended: list[Any] = []
        for chunk in chunks(blocks, MAX_CHILDREN):
            response = api.call("PATCH", f"/v1/blocks/{block}/children", json={"children": chunk}) or {}
            appended.extend(response.get("results") or [])
            count_written(ctx, "notion", "append", len(chunk))
        return {"blockId": block, "appended": len(blocks), "results": appended}
