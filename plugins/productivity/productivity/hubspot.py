"""HubSpot CRM: contacts (create or update by email, get, search) and deals (create, associated with contacts)."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from landflow_sdk import CredentialType, Node, NodeOperationError

from .common import (
    Api,
    authentication_property,
    binary_input,
    binary_name_property,
    binary_out,
    bool_param,
    collection,
    content_type_of,
    count_written,
    credential_requirements,
    download,
    fixed_entries,
    item_errors,
    items_of,
    limit_of,
    multipart,
    oauth2_properties,
    operation_property,
    out,
    outs,
    pick_credentials,
    resource_property,
    return_all_properties,
    simplify_property,
    split_list,
    test_call,
    text_param,
)

SEARCH_PAGE_SIZE = 200  # HubSpot's maximum for CRM search
DEAL_TO_CONTACT = 3  # HUBSPOT_DEFINED association type id: deal -> contact
CONTACTS = "/crm/v3/objects/contacts"


def hubspot_api(ctx: Any, creds: dict[str, Any]) -> Api:
    return Api(ctx, "hubspot", creds.get("baseUrl") or "https://api.hubapi.com", {"Authorization": f"Bearer {creds.get('appToken') or creds.get('accessToken') or ''}"})


def hubspot_credentials(ctx: Any, authentication: Any = None) -> dict[str, Any]:
    return pick_credentials(ctx, "hubspotAppToken", "hubspotOAuth2Api", authentication)


def test_hubspot(data: dict[str, Any], ctx: Any) -> tuple[bool, str]:
    ok, reason, _ = test_call(hubspot_api(ctx, data), f"{CONTACTS}?limit=1")
    return (True, "HubSpot accepted the token") if ok else (False, reason or "HubSpot rejected the token")


HUBSPOT_APP_TOKEN = CredentialType(
    name="hubspotAppToken",
    display_name="HubSpot App Token",
    documentation_url="https://developers.hubspot.com/docs/api/private-apps",
    description="A private app access token with crm.objects.contacts and crm.objects.deals scopes.",
    test=test_hubspot,
    properties=[
        {"name": "appToken", "displayName": "App Token", "type": "string", "required": True,
         "typeOptions": {"password": True}, "placeholder": "pat-na1-…"},
        {"name": "baseUrl", "displayName": "API Base URL", "type": "string", "default": "https://api.hubapi.com",
         "description": "Change only for a proxy or a test double"},
    ],
)


HUBSPOT_OAUTH2_API = CredentialType(
    name="hubspotOAuth2Api",
    display_name="HubSpot OAuth2 API",
    documentation_url="https://developers.hubspot.com/docs/api/oauth-quickstart-guide",
    description="Sign in with HubSpot: create a public app in a developer account, add the redirect URL shown below, then Connect. "
                "HubSpot access tokens last 30 minutes; Landflow renews them with the refresh token.",
    test=test_hubspot,
    extends=["oAuth2Api"],
    properties=[
        *oauth2_properties("https://app.hubspot.com/oauth/authorize", "https://api.hubapi.com/oauth/v1/token",
                           "oauth crm.objects.contacts.read crm.objects.contacts.write crm.objects.deals.read crm.objects.deals.write",
                           grant_type="authorizationCode"),
        {"name": "baseUrl", "displayName": "API Base URL", "type": "string", "default": "https://api.hubapi.com",
         "description": "Change only for a proxy or a test double"},
    ],
)


def simplify(record: dict[str, Any]) -> dict[str, Any]:
    """``{id, properties: {...}, …}`` -> ``{id, ...properties}``."""
    return {"id": record.get("id"), **(record.get("properties") or {})}


CONTACT_FIELDS = [  # (parameter name, display name, HubSpot property)
    ("firstName", "First Name", "firstname"),
    ("lastName", "Last Name", "lastname"),
    ("phone", "Phone Number", "phone"),
    ("companyName", "Company Name", "company"),
    ("jobTitle", "Job Title", "jobtitle"),
    ("websiteUrl", "Website URL", "website"),
    ("lifeCycleStage", "Lifecycle Stage", "lifecyclestage"),
]
OPERATORS = ["EQ", "NEQ", "LT", "LTE", "GT", "GTE", "CONTAINS_TOKEN", "NOT_CONTAINS_TOKEN", "HAS_PROPERTY", "NOT_HAS_PROPERTY"]
CONTACT = {"resource": ["contact"]}
DEAL = {"resource": ["deal"]}

CUSTOM_PROPERTIES = {
    "name": "customPropertiesUi", "displayName": "Custom Properties", "type": "fixedCollection", "default": {},
    "typeOptions": {"multipleValues": True}, "placeholder": "Add Property",
    "groups": [{
        "name": "customPropertiesValues", "displayName": "Property",
        "values": [
            {"name": "property", "displayName": "Property", "type": "string", "default": "", "description": "Internal property name"},
            {"name": "value", "displayName": "Value", "type": "string", "default": ""},
        ],
    }],
}


def custom_properties(ctx: Any, name: str, i: int) -> dict[str, Any]:
    rows = fixed_entries(ctx.get_node_parameter(name, i), "customPropertiesValues")
    return {str(r["property"]).strip(): r.get("value") for r in rows if str(r.get("property") or "").strip()}


class HubSpot(Node):
    description = {
        "name": "hubspot",
        "displayName": "HubSpot",
        "description": "Create or update, get and search HubSpot contacts; create deals; upload and download files",
        "version": 1,
        "kind": "action",
        "idempotent": False,  # creates, updates, archives and comments are at most once over a broker; the read operations opt in below
        "categories": ["Sales", "Marketing"],
        "icon": "file:icons/hubspot.svg",
        "color": "#FF7A59",
        "subtitle": "{{operation}}: {{resource}}",
        "documentationUrl": "https://developers.hubspot.com/docs/api/crm/understanding-the-crm",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "credentials": credential_requirements("hubspotAppToken", "hubspotOAuth2Api"),
        "usableAsTool": True,
        "toolDescription": (
            "Work with HubSpot CRM. Contacts: `upsert` by `email` (with optional names, phone, company), `get` by "
            "`contactId`, `search` with property filters. Deals: `create` with `dealName`, `stage`, `amount` and "
            "optional `associatedContactIds`. Files (Files API, needs the `files` scope): `upload` stores the item's binary file "
            "(`binaryPropertyName`) in the file manager, `get` returns a file's details by `fileId` and can download it as binary data."
        ),
        "keywords": ["hubspot", "crm", "contact", "deal", "sales", "lead"],
        "properties": [
            authentication_property("App Token"),
            resource_property([("Contact", "contact"), ("Deal", "deal"), ("File", "file")], "contact"),
            operation_property("file", [
                ("Get", "get", "Get a file, optionally downloading it as binary data", True),
                ("Upload", "upload", "Upload binary data to the file manager"),
            ], "upload"),
            operation_property("deal", [("Create", "create", "Create a deal")], "create"),
            operation_property("contact", [
                ("Create or Update", "upsert", "Create or update a contact"),
                ("Get", "get", "Get a contact", True),
                ("Search", "search", "Search contacts", True),
            ], "upsert"),
            # ---- contact upsert
            {"name": "email", "displayName": "Email", "type": "string", "default": "", "required": True, "placeholder": "name@email.com",
             "description": "The contact is looked up by email: updated when found, created otherwise",
             "displayOptions": {"show": {**CONTACT, "operation": ["upsert"]}}},
            {
                "name": "additionalFields", "displayName": "Additional Fields", "type": "collection", "default": {}, "placeholder": "Add Field",
                "displayOptions": {"show": {**CONTACT, "operation": ["upsert"]}},
                "values": [{"name": name, "displayName": label, "type": "string", "default": ""} for name, label, _ in CONTACT_FIELDS],
            },
            {**CUSTOM_PROPERTIES, "displayOptions": {"show": {**CONTACT, "operation": ["upsert"]}}},
            # ---- contact get
            {"name": "contactId", "displayName": "Contact ID", "type": "string", "default": "", "required": True,
             "displayOptions": {"show": {**CONTACT, "operation": ["get"]}}},
            # ---- contact search
            {
                "name": "filtersUi", "displayName": "Filters", "type": "fixedCollection", "default": {},
                "typeOptions": {"multipleValues": True}, "placeholder": "Add Filter",
                "description": "All filters must match (AND)",
                "displayOptions": {"show": {**CONTACT, "operation": ["search"]}},
                "groups": [{
                    "name": "filterValues", "displayName": "Filter",
                    "values": [
                        {"name": "propertyName", "displayName": "Property", "type": "string", "default": "", "placeholder": "email"},
                        {"name": "operator", "displayName": "Operator", "type": "options", "default": "EQ",
                         "options": [{"name": op.replace("_", " ").title(), "value": op} for op in OPERATORS]},
                        {"name": "value", "displayName": "Value", "type": "string", "default": ""},
                    ],
                }],
            },
            {"name": "query", "displayName": "Search Text", "type": "string", "default": "",
             "description": "Free text matched against the default searchable properties (name, email, phone, company)",
             "displayOptions": {"show": {**CONTACT, "operation": ["search"]}}},
            *return_all_properties({**CONTACT, "operation": ["search"]}, max_limit=None),
            {
                "name": "options", "displayName": "Options", "type": "collection", "default": {}, "placeholder": "Add option",
                "displayOptions": {"show": {**CONTACT, "operation": ["get", "search"]}},
                "values": [
                    {"name": "properties", "displayName": "Properties", "type": "string", "default": "",
                     "description": "Comma-separated properties to return (HubSpot's defaults when empty)"},
                    {"name": "sortBy", "displayName": "Sort By", "type": "string", "default": "", "placeholder": "createdate",
                     "description": "Search only"},
                    {"name": "direction", "displayName": "Sort Direction", "type": "options", "default": "DESCENDING",
                     "options": [{"name": "Descending", "value": "DESCENDING"}, {"name": "Ascending", "value": "ASCENDING"}]},
                ],
            },
            simplify_property({**CONTACT, "operation": ["upsert", "get", "search"]}, "Whether to return the id and the properties as flat fields"),
            # ---- file
            binary_name_property("binaryPropertyName", "Input Binary Field", {"resource": ["file"], "operation": ["upload"]},
                                 "Name of the binary property that holds the file to upload"),
            {
                "name": "fileOptions", "displayName": "Options", "type": "collection", "default": {}, "placeholder": "Add option",
                "displayOptions": {"show": {"resource": ["file"], "operation": ["upload"]}},
                "values": [
                    {"name": "folderPath", "displayName": "Folder Path", "type": "string", "default": "", "placeholder": "/landflow/reports",
                     "description": "Folder in the file manager (created when missing); the root when empty"},
                    {"name": "fileName", "displayName": "File Name", "type": "string", "default": "", "description": "Defaults to the binary file's name"},
                    {"name": "access", "displayName": "Access", "type": "options", "default": "PRIVATE",
                     "options": [{"name": "Private", "value": "PRIVATE"}, {"name": "Public, Indexable", "value": "PUBLIC_INDEXABLE"},
                                 {"name": "Public, Not Indexable", "value": "PUBLIC_NOT_INDEXABLE"}]},
                    {"name": "overwrite", "displayName": "Overwrite", "type": "boolean", "default": False,
                     "description": "Whether to replace a file with the same name in the folder"},
                ],
            },
            {"name": "fileId", "displayName": "File ID", "type": "string", "default": "", "required": True,
             "displayOptions": {"show": {"resource": ["file"], "operation": ["get"]}}},
            {"name": "download", "displayName": "Download File", "type": "boolean", "default": False,
             "description": "Whether to put the file's content in a binary property of the item",
             "displayOptions": {"show": {"resource": ["file"], "operation": ["get"]}}},
            binary_name_property("outputBinaryName", "Output Binary Field", {"resource": ["file"], "operation": ["get"], "download": [True]},
                                 "Binary property that receives the file"),
            # ---- deal create
            {"name": "dealName", "displayName": "Deal Name", "type": "string", "default": "", "required": True,
             "displayOptions": {"show": {**DEAL, "operation": ["create"]}}},
            {
                "name": "pipeline", "displayName": "Pipeline", "type": "options", "default": "default",
                "typeOptions": {"loadOptionsMethod": "getDealPipelines"}, "options": [{"name": "Sales Pipeline", "value": "default"}],
                "displayOptions": {"show": {**DEAL, "operation": ["create"]}},
            },
            {
                "name": "stage", "displayName": "Deal Stage", "type": "options", "default": "appointmentscheduled", "required": True,
                "typeOptions": {"loadOptionsMethod": "getDealStages", "loadOptionsDependsOn": ["pipeline"]},
                "options": [{"name": "Appointment Scheduled", "value": "appointmentscheduled"}],
                "displayOptions": {"show": {**DEAL, "operation": ["create"]}},
            },
            {
                "name": "dealFields", "displayName": "Additional Fields", "type": "collection", "default": {}, "placeholder": "Add Field",
                "displayOptions": {"show": {**DEAL, "operation": ["create"]}},
                "values": [
                    {"name": "amount", "displayName": "Amount", "type": "string", "default": ""},
                    {"name": "closeDate", "displayName": "Close Date", "type": "dateTime", "default": ""},
                    {"name": "dealType", "displayName": "Deal Type", "type": "options", "default": "newbusiness",
                     "options": [{"name": "New Business", "value": "newbusiness"}, {"name": "Existing Business", "value": "existingbusiness"}]},
                    {"name": "description", "displayName": "Description", "type": "string", "default": ""},
                    {"name": "associatedContactIds", "displayName": "Associated Contact IDs", "type": "string", "default": "",
                     "description": "Comma-separated contact ids to associate with the deal"},
                ],
            },
            {**CUSTOM_PROPERTIES, "displayOptions": {"show": {**DEAL, "operation": ["create"]}}},
            simplify_property({**DEAL, "operation": ["create"]}, "Whether to return the id and the properties as flat fields"),
        ],
    }

    def load_options(self, method, parameters, ctx=None):
        if method in ("getDealPipelines", "getDealStages"):
            api = hubspot_api(ctx, hubspot_credentials(ctx, (parameters or {}).get("authentication")))
            pipelines = sorted((api.get("/crm/v3/pipelines/deals") or {}).get("results") or [], key=lambda p: p.get("displayOrder") or 0)
            if method == "getDealPipelines":
                return [{"name": p.get("label"), "value": p.get("id")} for p in pipelines]
            chosen = str((parameters or {}).get("pipeline") or "")
            options = []
            for pipeline in pipelines:
                if chosen and pipeline.get("id") != chosen:
                    continue
                for stage in sorted(pipeline.get("stages") or [], key=lambda s: s.get("displayOrder") or 0):
                    label = stage.get("label") if chosen else f"{pipeline.get('label')} / {stage.get('label')}"
                    options.append({"name": label, "value": stage.get("id")})
            return options
        return super().load_options(method, parameters, ctx)

    def execute(self, ctx):
        api = hubspot_api(ctx, hubspot_credentials(ctx, ctx.get_node_parameter("authentication")))
        results = []
        for i, _item in enumerate(items_of(ctx)):
            with item_errors(ctx, results, i):
                api.item_index = i
                resource = ctx.get_node_parameter("resource", i)
                operation = ctx.get_node_parameter("operation", i)
                shape = simplify if bool_param(ctx, "simplify", i, True) else (lambda record: record)
                if resource == "contact" and operation == "upsert":
                    results.append(out(shape(self._upsert_contact(ctx, api, i)), i))
                elif resource == "contact" and operation == "get":
                    contact_id = text_param(ctx, "contactId", i, required=True, label="Contact ID")
                    props = split_list(collection(ctx, "options", i).get("properties"))
                    record = api.get(f"{CONTACTS}/{quote(contact_id, safe='')}", params={"properties": ",".join(props)} if props else None)
                    results.append(out(shape(record or {}), i))
                elif resource == "contact" and operation == "search":
                    results.extend(outs(map(shape, self._search(ctx, api, i)), i))
                elif resource == "file" and operation == "upload":
                    results.append(out(self._upload_file(ctx, api, i), i))
                elif resource == "file" and operation == "get":
                    results.append(self._get_file(ctx, api, i))
                elif resource == "deal" and operation == "create":
                    results.append(out(shape(self._create_deal(ctx, api, i)), i))
                else:
                    raise NodeOperationError(f"Unsupported operation {resource}.{operation}", item_index=i)
        return results

    # ------------------------------------------------------------ files

    @staticmethod
    def _upload_file(ctx, api: Api, i: int) -> dict[str, Any]:
        """Files API: ``POST /files/v3/files`` (multipart: the file, ``options`` JSON, the folder)."""
        content, ref, file_name = binary_input(ctx, "binaryPropertyName", i)
        options = collection(ctx, "fileOptions", i)
        name = str(options.get("fileName") or "").strip() or file_name
        fields = {
            "options": json.dumps({"access": options.get("access") or "PRIVATE", "overwrite": bool(options.get("overwrite")),
                                   "duplicateValidationStrategy": "NONE", "duplicateValidationScope": "EXACT_FOLDER"}),
            "folderPath": str(options.get("folderPath") or "").strip() or "/",
            "fileName": name,
        }
        body, content_type = multipart(fields, [("file", name, content, content_type_of(ref, name))])
        uploaded = api.call("POST", "/files/v3/files", data=body, headers={"Content-Type": content_type}, timeout=120) or {}
        count_written(ctx, "hubspot", "upload")
        return uploaded

    @staticmethod
    def _get_file(ctx, api: Api, i: int) -> dict[str, Any]:
        file_id = text_param(ctx, "fileId", i, required=True, label="File ID")
        meta = api.get(f"/files/v3/files/{quote(file_id, safe='')}") or {}
        if not bool_param(ctx, "download", i):
            return out(meta, i)
        url = meta.get("url")
        if str(meta.get("access") or "").upper() == "PRIVATE" or not url:  # a private file is fetched through a short-lived signed URL
            signed = api.get(f"/files/v3/files/{quote(file_id, safe='')}/signed-url") or {}
            url = signed.get("url") or url
        if not url:
            raise NodeOperationError(f"HubSpot returned no download URL for file {file_id}", item_index=i)
        resp = download(api, url, i, auth=False)
        name = f"{meta.get('name') or file_id}{('.' + meta['extension']) if meta.get('extension') and not str(meta.get('name') or '').endswith('.' + meta['extension']) else ''}"
        mime = resp.headers.get("Content-Type", "").split(";")[0].strip() or None
        return binary_out(ctx, meta, i, text_param(ctx, "outputBinaryName", i) or "data", resp.content, name, mime)

    # ------------------------------------------------------------ operations

    def _upsert_contact(self, ctx, api: Api, i: int) -> dict[str, Any]:
        email = text_param(ctx, "email", i, required=True, label="Email")
        fields = collection(ctx, "additionalFields", i)
        properties: dict[str, Any] = {"email": email}
        properties.update({prop: fields[name] for name, _, prop in CONTACT_FIELDS if fields.get(name) not in (None, "")})
        properties.update(custom_properties(ctx, "customPropertiesUi", i))
        match = api.call("POST", f"{CONTACTS}/search", json={
            "filterGroups": [{"filters": [{"propertyName": "email", "operator": "EQ", "value": email}]}],
            "properties": ["email"], "limit": 1,
        }) or {}
        existing = (match.get("results") or [None])[0]
        if existing:
            record = api.call("PATCH", f"{CONTACTS}/{quote(str(existing['id']), safe='')}", json={"properties": properties})
        else:
            record = api.call("POST", CONTACTS, json={"properties": properties})
        count_written(ctx, "hubspot", "upsert")
        ctx.logger.debug("contact " + ("updated" if existing else "created"))
        return record or {}

    def _search(self, ctx, api: Api, i: int) -> list[dict[str, Any]]:
        limit = limit_of(ctx, i)
        options = collection(ctx, "options", i)
        filters = []
        for row in fixed_entries(ctx.get_node_parameter("filtersUi", i), "filterValues"):
            name = str(row.get("propertyName") or "").strip()
            if not name:
                continue
            operator = row.get("operator") or "EQ"
            entry: dict[str, Any] = {"propertyName": name, "operator": operator}
            if operator not in ("HAS_PROPERTY", "NOT_HAS_PROPERTY"):
                entry["value"] = row.get("value", "")
            filters.append(entry)
        body: dict[str, Any] = {}
        if filters:
            body["filterGroups"] = [{"filters": filters}]
        if text_param(ctx, "query", i):
            body["query"] = text_param(ctx, "query", i)
        if split_list(options.get("properties")):
            body["properties"] = split_list(options["properties"])
        if str(options.get("sortBy") or "").strip():
            body["sorts"] = [{"propertyName": str(options["sortBy"]).strip(), "direction": options.get("direction") or "DESCENDING"}]
        found: list[dict[str, Any]] = []
        pages = 0
        with ctx.span("hubspot.search", {"hubspot.object": "contacts", "landflow.return_all": limit is None}) as span:
            after = None
            while True:
                request = {**body, "limit": SEARCH_PAGE_SIZE if limit is None else min(SEARCH_PAGE_SIZE, limit - len(found))}
                if after:
                    request["after"] = after
                page = api.call("POST", f"{CONTACTS}/search", json=request) or {}
                pages += 1
                found.extend(page.get("results") or [])
                after = ((page.get("paging") or {}).get("next") or {}).get("after")
                if not after or (limit is not None and len(found) >= limit):
                    break
            span.set_attributes({"landflow.pages": pages, "landflow.items": len(found)})
        return found if limit is None else found[:limit]

    def _create_deal(self, ctx, api: Api, i: int) -> dict[str, Any]:
        fields = collection(ctx, "dealFields", i)
        properties: dict[str, Any] = {
            "dealname": text_param(ctx, "dealName", i, required=True, label="Deal Name"),
            "dealstage": text_param(ctx, "stage", i, required=True, label="Deal Stage"),
        }
        if text_param(ctx, "pipeline", i):
            properties["pipeline"] = text_param(ctx, "pipeline", i)
        for name, prop in (("amount", "amount"), ("closeDate", "closedate"), ("dealType", "dealtype"), ("description", "description")):
            if fields.get(name) not in (None, ""):
                properties[prop] = str(fields[name])
        properties.update(custom_properties(ctx, "customPropertiesUi", i))
        body: dict[str, Any] = {"properties": properties}
        contacts = split_list(fields.get("associatedContactIds"))
        if contacts:
            body["associations"] = [
                {"to": {"id": contact}, "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": DEAL_TO_CONTACT}]}
                for contact in contacts
            ]
        deal = api.call("POST", "/crm/v3/objects/deals", json=body)
        count_written(ctx, "hubspot", "create")
        return deal or {}
