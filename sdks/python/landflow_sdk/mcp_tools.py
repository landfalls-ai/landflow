"""MCP tool mapping (docs/protocol.md §15.1): a plugin manifest in, MCP tool definitions out, and the way back from a
tool call's arguments to node parameters. Pure and dependency-free: the Python twin of
``packages/protocol/src/mcp-tools.ts`` (and ``sdks/go/mcpface``), checked against the shared fixtures in
``packages/protocol/conformance/fixtures/mcp-tools.json``.

One tool per operation: n8n-style nodes carry a ``resource`` dropdown and one or more ``operation`` dropdowns shown
per resource; each (resource, operation) pair becomes ``<resource>_<operation>``. A node without ``resource`` uses
its own name in that place (``postgres_select``), a node without ``operation`` is one tool named after the node
(``hash``), and the node segment is dropped when the node is named after its plugin (``message_send``). Through the
gateway every name is prefixed with the plugin (``gateway_tool_name``).
"""

from __future__ import annotations

import re
from typing import Any

MCP_TOOL_NAME_MAX_LENGTH = 64
MCP_TOOL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MCP_TOOL_META_KEY = "dev.landflow/node"
"""The ``_meta`` key under which a tool definition carries its node binding."""

_READ_ONLY = ("get", "getAll", "getMany", "list", "search", "read", "find", "fetch", "describe", "count", "exists", "check",
              "download", "select", "info", "keys", "llen", "lookup", "retrieve", "view", "show", "preview", "head")
_DESTRUCTIVE = ("delete", "remove", "destroy", "drop", "purge", "archive", "trash", "clear", "truncate", "revoke", "unpublish",
                "deleteTable", "deleteMessage")
_DISCRIMINATORS = ("resource", "operation")
_MISSING = object()


# --------------------------------------------------------------------------- names


def sanitize_tool_name(raw: str, max_length: int = MCP_TOOL_NAME_MAX_LENGTH) -> str:
    """Make any string a legal tool name: characters outside ``[A-Za-z0-9_-]`` become ``_``, runs collapse, leading and
    trailing ``_`` go, and the result is cut to ``max_length`` (``tool`` if nothing is left)."""
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", raw)
    cleaned = re.sub(r"_{2,}", "_", cleaned)
    cleaned = re.sub(r"^[_-]+|[_-]+$", "", cleaned)[:max_length]
    cleaned = re.sub(r"[_-]+$", "", cleaned)
    return cleaned or "tool"


def gateway_target_name(plugin_id: str) -> str:
    """The gateway target name of a plugin (the prefix of its tools on the shared endpoint): an id already in
    ``[a-z0-9.-]`` (at most 63 characters) as is; any other id lowercased, runs of other characters as ``-``, the stem
    cut to 40 characters plus ``-`` and 6 hex digits of FNV-1a 32 over the original id, so ids never collide."""
    cleaned = re.sub(r"^[.-]+|[.-]+$", "", re.sub(r"[^a-z0-9.-]+", "-", plugin_id.lower()))
    if cleaned == plugin_id and len(cleaned) <= 63:
        return cleaned
    stem = re.sub(r"[.-]+$", "", cleaned[:40]) or "plugin"
    return f"{stem}-{_fnv1a(plugin_id):08x}"[: len(stem) + 7]


def _fnv1a(text: str) -> int:
    value = 0x811C9DC5
    for byte in text.encode("utf-8"):
        value = ((value ^ byte) * 0x01000193) & 0xFFFFFFFF
    return value


def gateway_tool_name(plugin_id: str, tool_name: str) -> str:
    """The name a tool has on the gateway's shared endpoint: ``<gateway_target_name(plugin_id)>_<tool>``."""
    return sanitize_tool_name(f"{gateway_target_name(plugin_id)}_{tool_name}")


def _unique_names(names: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    taken = set(names)
    out: list[str] = []
    for name in names:
        count = seen.get(name, 0) + 1
        seen[name] = count
        if count == 1:
            out.append(name)
            continue
        n = count
        while True:
            suffix = f"_{n}"
            n += 1
            candidate = name[: MCP_TOOL_NAME_MAX_LENGTH - len(suffix)] + suffix
            if candidate not in taken:
                break
        taken.add(candidate)
        out.append(candidate)
    return out


# --------------------------------------------------------------------------- JS-like helpers


def _js_string(value: Any) -> str:
    """JavaScript's ``String()`` for a JSON primitive."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    return str(value)


def _js_type(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "object"


def _includes(values: list[Any], value: Any) -> bool:
    """``Array.prototype.includes`` for JSON primitives (a bool never equals a number)."""
    return any(_js_type(v) == _js_type(value) and v == value for v in values)


def _join_text(*parts: str | None) -> str | None:
    kept = []
    for part in parts:
        if not part or not part.strip():
            continue
        part = part.strip()
        kept.append(part if part.endswith(".") else part + ".")
    return " ".join(kept) if kept else None


# --------------------------------------------------------------------------- operations


def _is_options_property(prop: dict[str, Any], name: str) -> bool:
    return (
        prop.get("name") == name
        and prop.get("type") == "options"
        and not (prop.get("typeOptions") or {}).get("loadOptionsMethod")
        and bool(prop.get("options"))
    )


def _applies_to_resource(prop: dict[str, Any], resource: Any) -> bool:
    display = prop.get("displayOptions") or {}
    show = (display.get("show") or {}).get("resource")
    if show is not None and not _includes(show, resource):
        return False
    hide = (display.get("hide") or {}).get("resource")
    return not (hide is not None and _includes(hide, resource))


def _unique_options(options: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out = []
    for option in options:
        key = _js_string(option.get("value"))
        if key in seen:
            continue
        seen.add(key)
        out.append(option)
    return out


def operation_slots(node: dict[str, Any]) -> list[dict[str, Any]]:
    """The (resource, operation) pairs of a node in manifest order, as ``{resource?, operation?, fixed}``. Operations
    split over several ``operation`` properties (one per authentication method) are merged per resource."""
    properties = node.get("properties") or []
    resource_property = next((p for p in properties if _is_options_property(p, "resource")), None)
    operation_properties = [p for p in properties if _is_options_property(p, "operation")]
    if resource_property is None:
        if not operation_properties:
            return [{"fixed": {}}]
        all_options = [o for p in operation_properties for o in p["options"]]
        return [{"operation": o, "fixed": {"operation": o.get("value")}} for o in _unique_options(all_options)]
    slots = []
    for resource in resource_property["options"]:
        candidates = [o for p in operation_properties if _applies_to_resource(p, resource.get("value")) for o in p["options"]]
        operations = _unique_options(candidates)
        if not operations:
            slots.append({"resource": resource, "fixed": {"resource": resource.get("value")}})
        for operation in operations:
            slots.append({"resource": resource, "operation": operation, "fixed": {"resource": resource.get("value"), "operation": operation.get("value")}})
    return slots


def _shown_for_slot(display: dict[str, Any] | None, fixed: dict[str, Any]) -> bool:
    display = display or {}
    for key, allowed in (display.get("show") or {}).items():
        if key in fixed and not _includes(allowed, fixed[key]):
            return False
    for key, blocked in (display.get("hide") or {}).items():
        if key in fixed and _includes(blocked, fixed[key]):
            return False
    return True


def _condition_note(display: dict[str, Any] | None, fixed: dict[str, Any], selectors: set[str]) -> str | None:
    display = display or {}
    parts = []

    def skip(key: str) -> bool:
        return key in fixed or key.startswith("/") or key in selectors

    for key, allowed in (display.get("show") or {}).items():
        if not skip(key):
            parts.append(f"`{key}` is " + " or ".join(f"`{_js_string(v)}`" for v in allowed))
    for key, blocked in (display.get("hide") or {}).items():
        if not skip(key):
            parts.append(f"`{key}` is not " + " or ".join(f"`{_js_string(v)}`" for v in blocked))
    return f"Only used when {' and '.join(parts)}." if parts else None


# --------------------------------------------------------------------------- property -> JSON Schema


def credential_selectors_of(node: dict[str, Any]) -> list[dict[str, Any]]:
    """The parameters a node's ``credentials[].displayOptions`` switch on (``authentication``), with the value each
    credential type needs, in order of first appearance."""
    by_parameter: dict[str, dict[str, Any]] = {}
    for credential in node.get("credentials") or []:
        for parameter, values in ((credential.get("displayOptions") or {}).get("show") or {}).items():
            if not values:
                continue
            by_parameter.setdefault(parameter, {})[credential["name"]] = values[0]
    return [{"parameter": parameter, "byCredential": by_credential} for parameter, by_credential in by_parameter.items()]


def _enum_of(options: list[dict[str, Any]], several: bool) -> tuple[list[Any], str | None, str]:
    values = [o.get("value") for o in options]
    kinds = {_js_type(v) for v in values}
    typ = None
    if len(kinds) == 1:
        kind = next(iter(kinds))
        typ = kind if kind in ("number", "boolean") else "string"
    labels = []
    for o in options:
        label = f"`{_js_string(o.get('value'))}` ({o.get('name')}"
        if o.get("description"):
            label += f": {o['description']}"
        labels.append(label + ")")
    return values, typ, ("Any of" if several else "One of") + ": " + ", ".join(labels)


def _object_schema(fields: list[dict[str, Any]], ctx: dict[str, Any]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for field in fields:
        if field["name"] in properties:
            continue
        schema = property_to_json_schema(field, ctx)
        if schema is None:
            continue
        properties[field["name"]] = schema
        if field.get("required"):
            required.append(field["name"])
    out: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        out["required"] = required
    return out


def property_to_json_schema(prop: dict[str, Any], ctx: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """The JSON Schema (2020-12) of one node property as a tool argument, or ``None`` for properties that are not
    arguments (``notice``, ``hidden``, the discriminators, credential selectors, properties the fixed parameters hide).
    ``ctx`` is ``{fixed, dynamic, path, selectors}``; dynamic options are appended to ``ctx["dynamic"]``."""
    ctx = ctx if ctx is not None else {"fixed": {}, "dynamic": [], "path": [], "selectors": set()}
    fixed, path, selectors = ctx["fixed"], ctx["path"], ctx.get("selectors") or set()
    ptype, name = prop.get("type"), prop["name"]
    if ptype in ("notice", "hidden"):
        return None
    if not path and name in _DISCRIMINATORS and name in fixed:
        return None
    if not path and name in selectors:
        return None
    if not _shown_for_slot(prop.get("displayOptions"), fixed):
        return None
    full_path = [*path, name]
    base: dict[str, Any] = {"title": prop.get("displayName")}
    note: str | None = None
    type_options = prop.get("typeOptions") or {}
    if ptype in ("string", "color"):
        base["type"] = "string"
    elif ptype == "code":
        base["type"] = "string"
        note = f"{type_options['language']} code." if type_options.get("language") else "Code."
    elif ptype == "dateTime":
        base["type"] = "string"
        base["format"] = "date-time"
    elif ptype == "number":
        base["type"] = "integer" if type_options.get("numberPrecision") == 0 else "number"
        if "minValue" in type_options:
            base["minimum"] = type_options["minValue"]
        if "maxValue" in type_options:
            base["maximum"] = type_options["maxValue"]
    elif ptype == "boolean":
        base["type"] = "boolean"
    elif ptype == "json":
        base["type"] = ["object", "array", "string"]
        note = "A JSON value (an object or array, or JSON text)."
    elif ptype in ("options", "multiOptions"):
        if type_options.get("loadOptionsMethod"):
            item: dict[str, Any] = {"type": "string"}
            note = "Values come from the connected account (a dynamic list); pass the id or value, not the label."
            dynamic = {"parameter": "/".join(full_path), "method": type_options["loadOptionsMethod"]}
            if type_options.get("loadOptionsDependsOn"):
                dynamic["dependsOn"] = type_options["loadOptionsDependsOn"]
            ctx["dynamic"].append(dynamic)
        elif prop.get("options"):
            values, typ, enum_note = _enum_of(prop["options"], ptype == "multiOptions")
            item = {"enum": values}
            if typ:
                item["type"] = typ
            note = enum_note
        else:
            item = {"type": "string"}
        if ptype == "options":
            base.update(item)
        else:
            base["type"] = "array"
            base["items"] = item
    elif ptype == "collection":
        base.update(_object_schema(prop.get("values") or [], {**ctx, "path": full_path}))
    elif ptype == "fixedCollection":
        groups: dict[str, Any] = {}
        for group in prop.get("groups") or []:
            schema = {"title": group.get("displayName"), **_object_schema(group.get("values") or [], {**ctx, "path": [*full_path, group["name"]]})}
            groups[group["name"]] = {"type": "array", "items": schema} if type_options.get("multipleValues") else schema
        base["type"] = "object"
        base["properties"] = groups
    text = prop["description"] if prop.get("description") is not None else prop.get("hint")
    description = _join_text(text, note, _condition_note(prop.get("displayOptions"), fixed, selectors))
    if description:
        base["description"] = description
    if prop.get("default") is not None and ptype not in ("collection", "fixedCollection"):
        base["default"] = prop["default"]
    return base


# --------------------------------------------------------------------------- annotations, titles, descriptions


def _verb_matches(verb: str, prefixes: tuple[str, ...]) -> bool:
    for prefix in prefixes:
        if verb.startswith(prefix):
            rest = verb[len(prefix):]
            if not rest or not ("a" <= rest[0] <= "z"):
                return True
    return False


def derive_tool_annotations(node: dict[str, Any], slot: dict[str, Any], title: str) -> dict[str, Any]:
    """The hints derived from the operation name and ``idempotent``, then the node's and the operation's overrides."""
    operation = slot.get("operation")
    verb = _js_string(operation.get("value")) if operation else node["name"]
    read_only = _verb_matches(verb, _READ_ONLY)
    destructive = not read_only and _verb_matches(verb, _DESTRUCTIVE)
    idempotent = operation.get("idempotent") if operation and operation.get("idempotent") is not None else node.get("idempotent")
    out = {"title": title, "readOnlyHint": read_only, "destructiveHint": destructive, "idempotentHint": read_only or bool(idempotent), "openWorldHint": True}
    out.update(node.get("toolAnnotations") or {})
    if operation:
        out.update(operation.get("toolAnnotations") or {})
    return out


def raw_tool_name(plugin_id: str, node: dict[str, Any], slot: dict[str, Any]) -> str:
    segments = []
    resource, operation = slot.get("resource"), slot.get("operation")
    if resource is None or node["name"] != plugin_id:
        segments.append(node["name"])
    if resource is not None:
        segments.append(_js_string(resource.get("value")))
    if operation is not None:
        segments.append(_js_string(operation.get("value")))
    return "_".join(segments)


def _tool_title(node: dict[str, Any], slot: dict[str, Any]) -> str:
    parts = [node.get("displayName"), (slot.get("resource") or {}).get("name"), (slot.get("operation") or {}).get("name")]
    return " · ".join(p for p in parts if p)


def _tool_description(node: dict[str, Any], slot: dict[str, Any]) -> str:
    resource, operation = slot.get("resource"), slot.get("operation")
    what = None
    if operation is not None:
        if operation.get("action") is not None:
            what = operation["action"]
        elif operation.get("description") is not None:
            what = operation["description"]
        elif resource is not None:
            what = f"{operation.get('name')} ({str(resource.get('name', '')).lower()})"
        else:
            what = operation.get("name")
    elif resource is not None:
        what = resource.get("name", "")
        if resource.get("description"):
            what += f": {resource['description']}"
    about = node["toolDescription"] if node.get("toolDescription") is not None else node.get("description")
    return _join_text(what, about) or node.get("displayName") or ""


# --------------------------------------------------------------------------- mapping


def is_mcp_tool_node(node: dict[str, Any], *, include_all_actions: bool = False) -> bool:
    """An action node, ``usableAsTool`` (unless ``include_all_actions``), not opted out with ``mcp: false``."""
    if node.get("kind") != "action" or node.get("mcp") is False:
        return False
    return True if include_all_actions else node.get("usableAsTool") is True


def _default_version_of(node: dict[str, Any]) -> int:
    if node.get("defaultVersion") is not None:
        return int(node["defaultVersion"])
    version = node.get("version")
    return max(version) if isinstance(version, list) else int(version)


def mcp_tools_for_node(plugin_id: str, node: dict[str, Any], *, include_all_actions: bool = False, type_version: int | None = None) -> list[dict[str, Any]]:
    """The tools of one node, before names are made unique across the plugin."""
    if not is_mcp_tool_node(node, include_all_actions=include_all_actions):
        return []
    version = type_version if type_version is not None else _default_version_of(node)
    selectors = credential_selectors_of(node)
    selector_names = {s["parameter"] for s in selectors}
    tools = []
    for slot in operation_slots(node):
        resource, operation = slot.get("resource"), slot.get("operation")
        if (resource or {}).get("mcp") is False or (operation or {}).get("mcp") is False:
            continue
        ctx: dict[str, Any] = {"fixed": slot["fixed"], "dynamic": [], "path": [], "selectors": selector_names}
        input_schema = _object_schema(node.get("properties") or [], ctx)
        title = _tool_title(node, slot)
        output_schema = (operation or {}).get("outputSchema") if (operation or {}).get("outputSchema") is not None else node.get("outputSchema")
        binding: dict[str, Any] = {
            "pluginId": plugin_id,
            "nodeType": f"{plugin_id}.{node['name']}",
            "nodeName": node["name"],
            "typeVersion": version,
        }
        if resource is not None:
            binding["resource"] = _js_string(resource.get("value"))
        if operation is not None:
            binding["operation"] = _js_string(operation.get("value"))
        binding.update({
            "fixedParameters": slot["fixed"],
            "arguments": list(input_schema["properties"].keys()),
            "credentials": [c["name"] for c in node.get("credentials") or []],
            "credentialSelectors": selectors,
            "dynamicOptions": ctx["dynamic"],
        })
        tool: dict[str, Any] = {
            "name": sanitize_tool_name(raw_tool_name(plugin_id, node, slot)),
            "title": title,
            "description": _tool_description(node, slot),
            "inputSchema": input_schema,
        }
        if output_schema is not None:
            tool["outputSchema"] = {"type": "object", "properties": {"items": {"type": "array", "items": output_schema}}, "required": ["items"]}
        tool["annotations"] = derive_tool_annotations(node, slot, title)
        tool["_meta"] = {MCP_TOOL_META_KEY: binding}
        tools.append(tool)
    return tools


def mcp_tools_from_descriptors(plugin_id: str, nodes: list[dict[str, Any]], **options: Any) -> list[dict[str, Any]]:
    """The tools of a set of node descriptors, with names unique per plugin."""
    tools = [t for node in nodes for t in mcp_tools_for_node(plugin_id, node, **options)]
    for tool, name in zip(tools, _unique_names([t["name"] for t in tools])):
        tool["name"] = name
    return tools


def mcp_tools_from_manifest(manifest: dict[str, Any], **options: Any) -> list[dict[str, Any]]:
    """The MCP tools of a plugin, from its manifest (``include_all_actions=``, ``type_version=``)."""
    return mcp_tools_from_descriptors(manifest["plugin"]["id"], manifest.get("nodes") or [], **options)


def without_binding(tool: dict[str, Any]) -> dict[str, Any]:
    """A tool as the MCP client sees it: the same without ``_meta``."""
    return {k: v for k, v in tool.items() if k != "_meta"}


def find_mcp_tool(tools: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    return next((t for t in tools if t["name"] == name), None)


def tool_call_to_parameters(tool: dict[str, Any], args: dict[str, Any] | None) -> dict[str, Any]:
    """The reverse mapping: ``{nodeType, typeVersion, parameters, ignored}``. Only arguments the tool declares become
    parameters (merged over the fixed ``resource``/``operation``); the rest is reported in ``ignored``."""
    binding = tool["_meta"][MCP_TOOL_META_KEY]
    known = set(binding["arguments"])
    parameters = dict(binding["fixedParameters"])
    ignored = []
    for key, value in (args or {}).items():
        if key in known:
            parameters[key] = value
        else:
            ignored.append(key)
    return {"nodeType": binding["nodeType"], "typeVersion": binding["typeVersion"], "parameters": parameters, "ignored": ignored}
