"""Airtable: records (create, upsert, get, search, update, delete), with base and table pickers."""

from __future__ import annotations

import base64
from typing import Any
from urllib.parse import quote

from landflow_sdk import CredentialType, Node, NodeOperationError

from .common import (
    Api,
    authentication_property,
    binary_input,
    binary_name_property,
    binary_out,
    collection,
    content_type_of,
    count_written,
    download,
    credential_requirements,
    fixed_entries,
    item_errors,
    items_of,
    json_param,
    limit_of,
    oauth2_properties,
    operation_property,
    out,
    outs,
    pick_credentials,
    resource_property,
    return_all_properties,
    split_list,
    test_call,
    text_param,
)

MAX_UPLOAD_BYTES = 5 * 1000 * 1000  # the uploadAttachment endpoint takes at most 5 MB
CONTENT_HOST = "https://content.airtable.com"  # uploadAttachment lives on its own host; a custom base URL (proxy, test double) serves both
BATCH_SIZE = 10  # Airtable accepts at most 10 records per write request
PAGE_SIZE = 100


def airtable_api(ctx: Any, creds: dict[str, Any]) -> Api:
    return Api(ctx, "airtable", creds.get("baseUrl") or "https://api.airtable.com", {"Authorization": f"Bearer {creds.get('accessToken', '')}"})


def airtable_credentials(ctx: Any, authentication: Any = None) -> dict[str, Any]:
    return pick_credentials(ctx, "airtableTokenApi", "airtableOAuth2Api", authentication)


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


AIRTABLE_OAUTH2_API = CredentialType(
    name="airtableOAuth2Api",
    display_name="Airtable OAuth2 API",
    documentation_url="https://airtable.com/developers/web/guides/oauth-integrations",
    description="Sign in with Airtable: register an OAuth integration at airtable.com/create/oauth, add the redirect URL shown below, then Connect. "
                "Airtable requires PKCE and rotates refresh tokens; Landflow keeps them.",
    test=test_airtable,
    extends=["oAuth2Api"],
    properties=[
        *oauth2_properties("https://airtable.com/oauth2/v1/authorize", "https://airtable.com/oauth2/v1/token",
                           "data.records:read data.records:write schema.bases:read user.email:read",
                           authentication="header", user_info_url="https://api.airtable.com/v0/meta/whoami"),
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
        "description": "Create, upsert, get, search, update and delete Airtable records; upload and download attachments",
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
        "credentials": credential_requirements("airtableTokenApi", "airtableOAuth2Api"),
        "usableAsTool": True,
        "toolDescription": (
            "Read and write Airtable records in a table (`base` and `table` ids). Operations: `search` with an Airtable "
            "formula in `filterByFormula`, `get` / `deleteRecord` by record `id`, `create` / `update` / `upsert` with the "
            "record fields as a JSON object in `fieldsJson` (set `dataMode` to `json`). Attachments (resource `attachment`): `upload` "
            "sends the item's binary file (`binaryPropertyName`) to `attachmentField` of record `attachmentRecordId` (up to 5 MB); "
            "`download` returns each file of that field as binary data."
        ),
        "keywords": ["airtable", "spreadsheet", "database", "table", "records", "rows"],
        "properties": [
            authentication_property("Personal Access Token"),
            resource_property([("Attachment", "attachment"), ("Record", "record")], "record"),
            operation_property("attachment", [
                ("Download", "download", "Download the attachments of a record field as binary data", True),
                ("Upload", "upload", "Upload binary data to an attachment field of a record"),
            ], "download"),
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
                "typeOptions": {"loadOptionsMethod": "getBases"}, "description": "Base id (app…)", "displayOptions": {"show": {"resource": ["record", "attachment"]}},
            },
            {
                "name": "table", "displayName": "Table", "type": "options", "default": "", "required": True,
                "typeOptions": {"loadOptionsMethod": "getTables", "loadOptionsDependsOn": ["base"]},
                "description": "Table id (tbl…) or name",
                "displayOptions": {"show": {"resource": ["record", "attachment"], "operation": ["create", "upsert", "update", "deleteRecord", "get", "search", "download"]}},
            },
            {
                "name": "attachmentRecordId", "displayName": "Record ID", "type": "string", "default": "", "required": True, "placeholder": "rec…",
                "displayOptions": {"show": {"resource": ["attachment"]}},
            },
            {
                "name": "attachmentField", "displayName": "Attachment Field", "type": "string", "default": "", "required": True, "placeholder": "Attachments",
                "description": "Name or id of the attachment field", "displayOptions": {"show": {"resource": ["attachment"]}},
            },
            binary_name_property("binaryPropertyName", "Input Binary Field", {"resource": ["attachment"], "operation": ["upload"]},
                                 "Name of the binary property that holds the file to upload (up to 5 MB)"),
            binary_name_property("outputBinaryName", "Output Binary Field", {"resource": ["attachment"], "operation": ["download"]},
                                 "Binary property that receives each file (one output item per attachment)"),
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
            api = airtable_api(ctx, airtable_credentials(ctx, (parameters or {}).get("authentication")))
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
            api = airtable_api(ctx, airtable_credentials(ctx, (parameters or {}).get("authentication")))
            body = api.get(f"/v0/meta/bases/{quote(base, safe='')}/tables") or {}
            return [{"name": t.get("name") or t.get("id"), "value": t.get("id"), "description": t.get("description")} for t in body.get("tables") or []]
        return super().load_options(method, parameters, ctx)

    def execute(self, ctx):
        api = airtable_api(ctx, airtable_credentials(ctx, ctx.get_node_parameter("authentication")))
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
            if ctx.get_node_parameter("resource", i, "record") == "attachment":
                flush()  # attachments are one request per item and keep the order of the batches before them
                with item_errors(ctx, results, i):
                    if operation == "upload":
                        results.append(out(self._upload(ctx, api, i, base), i))
                    elif operation == "download":
                        results.extend(self._download(ctx, api, i, base))
                    else:
                        raise NodeOperationError(f"Unsupported operation attachment.{operation}", item_index=i)
                continue
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

    # ------------------------------------------------------------ attachments

    @staticmethod
    def _upload(ctx, api: Api, i: int, base: str) -> dict[str, Any]:
        """``uploadAttachment``: the file as base64 JSON, added to the record's attachment field (existing files stay)."""
        record_id = text_param(ctx, "attachmentRecordId", i, required=True, label="Record ID")
        field = text_param(ctx, "attachmentField", i, required=True, label="Attachment Field")
        content, ref, file_name = binary_input(ctx, "binaryPropertyName", i)
        if len(content) > MAX_UPLOAD_BYTES:
            raise NodeOperationError(f"'{file_name}' is {len(content)} bytes; Airtable takes up to 5 MB per upload", item_index=i)
        host = CONTENT_HOST if api.base_url == "https://api.airtable.com" else api.base_url
        url = f"{host}/v0/{quote(base, safe='')}/{quote(record_id, safe='')}/{quote(field, safe='')}/uploadAttachment"
        record = api.call("POST", url, timeout=120, json={"contentType": content_type_of(ref, file_name), "file": base64.b64encode(content).decode("ascii"), "filename": file_name}) or {}
        count_written(ctx, "airtable", "upload")
        return flatten(record)

    @staticmethod
    def _download(ctx, api: Api, i: int, base: str) -> list[dict[str, Any]]:
        """One output item per file of the record's attachment field, the bytes in ``outputBinaryName``."""
        table = text_param(ctx, "table", i, required=True, label="Table")
        record_id = text_param(ctx, "attachmentRecordId", i, required=True, label="Record ID")
        field = text_param(ctx, "attachmentField", i, required=True, label="Attachment Field")
        record = api.get(f"/v0/{quote(base, safe='')}/{quote(table, safe='')}/{quote(record_id, safe='')}", params={"returnFieldsByFieldId": "false"}) or {}
        files = (record.get("fields") or {}).get(field)
        if files is not None and not isinstance(files, list):
            raise NodeOperationError(f"Field '{field}' is not an attachment field", item_index=i)
        prop = text_param(ctx, "outputBinaryName", i) or "data"
        results = []
        for attachment in files or []:
            if not isinstance(attachment, dict) or not attachment.get("url"):
                continue
            resp = download(api, attachment["url"], i, auth=False)  # a signed URL on Airtable's CDN: the token stays off it
            name = str(attachment.get("filename") or attachment.get("id") or "attachment")
            info = {"recordId": record_id, "field": field, "id": attachment.get("id"), "filename": name, "type": attachment.get("type"), "size": len(resp.content)}
            results.append(binary_out(ctx, info, i, prop, resp.content, name, attachment.get("type")))
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
