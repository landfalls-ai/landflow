"""Airtable: records (create, upsert, get, search, update, delete), with base and table pickers."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from landflow_sdk import CredentialType, Node, NodeOperationError

from .common import (
    Api,
    collection,
    count_written,
    fixed_entries,
    items_of,
    json_param,
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

BATCH_SIZE = 10  # Airtable accepts at most 10 records per write request
PAGE_SIZE = 100


def airtable_api(ctx: Any, creds: dict[str, Any]) -> Api:
    return Api(ctx, "airtable", creds.get("baseUrl") or "https://api.airtable.com", {"Authorization": f"Bearer {creds.get('accessToken', '')}"})


def test_airtable(data: dict[str, Any], ctx: Any) -> tuple[bool, str]:
    ok, reason, me = test_call(airtable_api(ctx, data), "/v0/meta/whoami")
    if not ok:
        return False, reason or "Airtable rejected the token"
    return True, f"authenticated as {me.get('email') or me.get('id')}" if isinstance(me, dict) else "authenticated"


AIRTABLE_TOKEN_API = CredentialType(
    name="airtableTokenApi",
    display_name="Airtable Personal Access Token API",
    documentation_url="https://airtable.com/developers/web/guides/personal-access-tokens",
    description="A personal access token with data.records:read/write and schema.bases:read scopes.",
    test=test_airtable,
    properties=[
        {"name": "accessToken", "displayName": "Access Token", "type": "string", "required": True,
         "typeOptions": {"password": True}, "placeholder": "pat…"},
        {"name": "baseUrl", "displayName": "API Base URL", "type": "string", "default": "https://api.airtable.com",
         "description": "Change only for a proxy or a test double"},
    ],
)


def flatten(record: dict[str, Any]) -> dict[str, Any]:
    """``{id, createdTime, fields: {...}}`` -> ``{id, createdTime, ...fields}`` (as n8n's Airtable v2 node)."""
    return {"id": record.get("id"), "createdTime": record.get("createdTime"), **(record.get("fields") or {})}


RECORD = {"resource": ["record"]}
WRITE_OPS = ["create", "upsert", "update"]


class Airtable(Node):
    description = {
        "name": "airtable",
        "displayName": "Airtable",
        "description": "Create, upsert, get, search, update and delete Airtable records",
        "version": 1,
        "kind": "action",
        "idempotent": False,  # creates, updates, archives and comments are at most once over a broker; the read operations opt in below
        "categories": ["Data & Storage", "Productivity"],
        "icon": "file:icons/airtable.svg",
        "color": "#18BFFF",
        "subtitle": "{{operation}}: {{resource}}",
        "documentationUrl": "https://airtable.com/developers/web/api/introduction",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "credentials": [{"name": "airtableTokenApi", "required": True}],
        "usableAsTool": True,
        "toolDescription": (
            "Read and write Airtable records in a table (`base` and `table` ids). Operations: `search` with an Airtable "
            "formula in `filterByFormula`, `get` / `deleteRecord` by record `id`, `create` / `update` / `upsert` with the "
            "record fields as a JSON object in `fieldsJson` (set `dataMode` to `json`)."
        ),
        "keywords": ["airtable", "spreadsheet", "database", "table", "records", "rows"],
        "properties": [
            resource_property([("Record", "record")], "record"),
            operation_property("record", [
                ("Create", "create", "Create a record"),
                ("Create or Update", "upsert", "Create or update a record"),
                ("Delete", "deleteRecord", "Delete a record"),
                ("Get", "get", "Get a record", True),
                ("Search", "search", "Search records", True),
                ("Update", "update", "Update a record"),
            ], "search"),
            {
                "name": "base", "displayName": "Base", "type": "options", "default": "", "required": True,
                "typeOptions": {"loadOptionsMethod": "getBases"}, "description": "Base id (app…)", "displayOptions": {"show": RECORD},
            },
            {
                "name": "table", "displayName": "Table", "type": "options", "default": "", "required": True,
                "typeOptions": {"loadOptionsMethod": "getTables", "loadOptionsDependsOn": ["base"]},
                "description": "Table id (tbl…) or name", "displayOptions": {"show": RECORD},
            },
            {
                "name": "id", "displayName": "Record ID", "type": "string", "default": "", "required": True, "placeholder": "rec…",
                "displayOptions": {"show": {**RECORD, "operation": ["get", "update", "deleteRecord"]}},
            },
            {
                "name": "fieldsToMergeOn", "displayName": "Fields to Merge On", "type": "string", "default": "", "required": True,
                "placeholder": "Email", "description": "Comma-separated fields that identify a record: a match is updated, otherwise a record is created",
                "displayOptions": {"show": {**RECORD, "operation": ["upsert"]}},
            },
            {
                "name": "dataMode", "displayName": "Fields", "type": "options", "default": "autoMapInputData",
                "displayOptions": {"show": {**RECORD, "operation": WRITE_OPS}},
                "options": [
                    {"name": "Map Automatically", "value": "autoMapInputData", "description": "Use the input item's fields as the record's fields"},
                    {"name": "Define Below", "value": "defineBelow", "description": "Set field names and values one by one"},
                    {"name": "JSON", "value": "json", "description": "A JSON object of field names to values"},
                ],
            },
            {
                "name": "fieldsUi", "displayName": "Fields to Send", "type": "fixedCollection", "default": {},
                "typeOptions": {"multipleValues": True}, "placeholder": "Add Field",
                "displayOptions": {"show": {**RECORD, "operation": WRITE_OPS, "dataMode": ["defineBelow"]}},
                "groups": [{
                    "name": "fieldValues", "displayName": "Field",
                    "values": [
                        {"name": "fieldName", "displayName": "Field Name", "type": "string", "default": ""},
                        {"name": "fieldValue", "displayName": "Field Value", "type": "string", "default": ""},
                    ],
                }],
            },
            {
                "name": "fieldsJson", "displayName": "Fields (JSON)", "type": "json", "default": "",
                "description": "e.g. {\"Name\": \"Ada\", \"Score\": 42}",
                "displayOptions": {"show": {**RECORD, "operation": WRITE_OPS, "dataMode": ["json"]}},
            },
            {
                "name": "filterByFormula", "displayName": "Filter By Formula", "type": "string", "default": "",
                "placeholder": "NOT({Name} = 'Admin')", "description": "An Airtable formula; only records for which it is true are returned",
                "displayOptions": {"show": {**RECORD, "operation": ["search"]}},
            },
            *return_all_properties({**RECORD, "operation": ["search"]}),
            {
                "name": "sort", "displayName": "Sort", "type": "fixedCollection", "default": {},
                "typeOptions": {"multipleValues": True}, "placeholder": "Add Sort Rule",
                "displayOptions": {"show": {**RECORD, "operation": ["search"]}},
                "groups": [{
                    "name": "property", "displayName": "Rule",
                    "values": [
                        {"name": "field", "displayName": "Field", "type": "string", "default": ""},
                        {"name": "direction", "displayName": "Direction", "type": "options", "default": "asc",
                         "options": [{"name": "Ascending", "value": "asc"}, {"name": "Descending", "value": "desc"}]},
                    ],
                }],
            },
            {
                "name": "searchOptions", "displayName": "Options", "type": "collection", "default": {}, "placeholder": "Add option",
                "displayOptions": {"show": {**RECORD, "operation": ["search"]}},
                "values": [
                    {"name": "view", "displayName": "View", "type": "string", "default": "", "description": "View name or id; its filters and order apply"},
                    {"name": "fields", "displayName": "Output Fields", "type": "string", "default": "", "description": "Comma-separated fields to return (all when empty)"},
                ],
            },
            {
                "name": "writeOptions", "displayName": "Options", "type": "collection", "default": {}, "placeholder": "Add option",
                "displayOptions": {"show": {**RECORD, "operation": WRITE_OPS}},
                "values": [
                    {"name": "typecast", "displayName": "Typecast", "type": "boolean", "default": False,
                     "description": "Let Airtable convert string values to the field types (and create missing select options)"},
                    {"name": "ignoreFields", "displayName": "Ignore Fields", "type": "string", "default": "",
                     "description": "Comma-separated input fields not to send (Map Automatically)"},
                ],
            },
        ],
    }

    def load_options(self, method, parameters, ctx=None):
        if method == "getBases":
            api = airtable_api(ctx, ctx.get_credentials("airtableTokenApi"))
            options, offset = [], None
            for _ in range(20):
                page = api.get("/v0/meta/bases", params={"offset": offset} if offset else None) or {}
                options += [{"name": b.get("name") or b.get("id"), "value": b.get("id"), "description": b.get("permissionLevel")} for b in page.get("bases") or []]
                offset = page.get("offset")
                if not offset:
                    break
            return options
        if method == "getTables":
            base = str((parameters or {}).get("base") or "").strip()
            if not base:
                return []
            api = airtable_api(ctx, ctx.get_credentials("airtableTokenApi"))
            body = api.get(f"/v0/meta/bases/{quote(base, safe='')}/tables") or {}
            return [{"name": t.get("name") or t.get("id"), "value": t.get("id"), "description": t.get("description")} for t in body.get("tables") or []]
        return super().load_options(method, parameters, ctx)

    def execute(self, ctx):
        api = airtable_api(ctx, ctx.get_credentials("airtableTokenApi"))
        items = items_of(ctx)
        results: list[dict[str, Any]] = []
        batch: list[tuple[int, dict[str, Any]]] = []  # (item index, record) waiting to be written
        batch_key: tuple | None = None

        def flush() -> None:
            nonlocal batch, batch_key
            if batch:
                results.extend(self._write(ctx, api, batch_key, batch))
            batch, batch_key = [], None

        for i, item in enumerate(items):
            api.item_index = i
            operation = ctx.get_node_parameter("operation", i)
            base = text_param(ctx, "base", i, required=True, label="Base")
            table = text_param(ctx, "table", i, required=True, label="Table")
            path = f"/v0/{quote(base, safe='')}/{quote(table, safe='')}"
            if operation in WRITE_OPS or operation == "deleteRecord":
                key, record = self._prepare(ctx, item, i, operation, path)
                if key != batch_key or len(batch) >= BATCH_SIZE:
                    flush()
                batch_key = key
                batch.append((i, record))
                continue
            flush()
            if operation == "get":
                record_id = text_param(ctx, "id", i, required=True, label="Record ID")
                results.append(out(flatten(api.get(f"{path}/{quote(record_id, safe='')}") or {}), i))
            elif operation == "search":
                results.extend(outs(map(flatten, self._search(ctx, api, i, path)), i))
            else:
                raise NodeOperationError(f"Unsupported operation record.{operation}", item_index=i)
        flush()
        return results

    # ------------------------------------------------------------ operations

    def _fields(self, ctx, item: dict[str, Any], i: int) -> dict[str, Any]:
        mode = ctx.get_node_parameter("dataMode", i)
        if mode == "json":
            return json_param(ctx, "fieldsJson", i, label="Fields (JSON)") or {}
        if mode == "defineBelow":
            rows = fixed_entries(ctx.get_node_parameter("fieldsUi", i), "fieldValues")
            return {str(r["fieldName"]).strip(): r.get("fieldValue") for r in rows if str(r.get("fieldName") or "").strip()}
        ignore = set(split_list(collection(ctx, "writeOptions", i).get("ignoreFields")))
        return {k: v for k, v in (item.get("json") or {}).items() if k not in ignore and k not in ("id", "createdTime")}

    def _prepare(self, ctx, item: dict[str, Any], i: int, operation: str, path: str) -> tuple[tuple, dict[str, Any]]:
        """``(batch key, record)``: consecutive items with the same key are written together, 10 at a time."""
        if operation == "deleteRecord":
            return (operation, path), {"id": text_param(ctx, "id", i, required=True, label="Record ID")}
        options = collection(ctx, "writeOptions", i)
        record: dict[str, Any] = {"fields": self._fields(ctx, item, i)}
        merge_on: tuple[str, ...] = ()
        if operation == "update":
            record["id"] = text_param(ctx, "id", i, required=True, label="Record ID")
        if operation == "upsert":
            merge_on = tuple(split_list(ctx.get_node_parameter("fieldsToMergeOn", i)))
            if not merge_on:
                raise NodeOperationError("'Fields to Merge On' is required", item_index=i)
        return (operation, path, bool(options.get("typecast")), merge_on), record

    def _write(self, ctx, api: Api, key: tuple, batch: list[tuple[int, dict[str, Any]]]) -> list[dict[str, Any]]:
        operation, path = key[0], key[1]
        indexes = [i for i, _ in batch]
        api.item_index = indexes[0]
        if operation == "deleteRecord":
            body = api.call("DELETE", path, params=[("records[]", r["id"]) for _, r in batch]) or {}
            count_written(ctx, "airtable", "delete", len(batch))
            records = body.get("records") or []
            return [out(records[n] if n < len(records) else {"id": r["id"], "deleted": True}, i) for n, (i, r) in enumerate(batch)]
        typecast, merge_on = key[2], key[3]
        payload: dict[str, Any] = {"records": [r for _, r in batch]}
        if typecast:
            payload["typecast"] = True
        if operation == "upsert":
            payload["performUpsert"] = {"fieldsToMergeOn": list(merge_on)}
        method = "POST" if operation == "create" else "PATCH"
        body = api.call(method, path, json=payload) or {}
        count_written(ctx, "airtable", operation, len(batch))
        records = body.get("records") or []
        return [out(flatten(record), indexes[min(n, len(indexes) - 1)]) for n, record in enumerate(records)]

    def _search(self, ctx, api: Api, i: int, path: str) -> list[dict[str, Any]]:
        limit = limit_of(ctx, i)
        options = collection(ctx, "searchOptions", i)
        params: list[tuple[str, Any]] = []
        formula = text_param(ctx, "filterByFormula", i)
        if formula:
            params.append(("filterByFormula", formula))
        if options.get("view"):
            params.append(("view", options["view"]))
        params += [("fields[]", f) for f in split_list(options.get("fields"))]
        for n, rule in enumerate(r for r in fixed_entries(ctx.get_node_parameter("sort", i), "property") if r.get("field")):
            params += [(f"sort[{n}][field]", rule["field"]), (f"sort[{n}][direction]", rule.get("direction") or "asc")]
        if limit is not None:
            params.append(("maxRecords", limit))
        found: list[dict[str, Any]] = []
        pages = 0
        with ctx.span("airtable.search", {"landflow.return_all": limit is None}) as span:
            offset = None
            while True:
                page_params = params + [("pageSize", PAGE_SIZE if limit is None else min(PAGE_SIZE, limit))]
                if offset:
                    page_params.append(("offset", offset))
                page = api.get(path, params=page_params) or {}
                pages += 1
                found.extend(page.get("records") or [])
                offset = page.get("offset")
                if not offset or (limit is not None and len(found) >= limit):
                    break
            span.set_attributes({"landflow.pages": pages, "landflow.items": len(found)})
        return found if limit is None else found[:limit]
