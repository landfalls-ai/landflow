"""Composite types: canvas frames with a contract of slots, ports and rules (docs/composites.md).

A plugin declares them as descriptor dicts in ``Plugin(composites=[...])``; the keys are exactly the wire form
(``CompositeTypeDescriptor`` in packages/protocol/src/types.ts). ``validate_composite`` mirrors the protocol's
``compositeTypeSchema`` and reports every problem at once.

    {
        "name": "aiTriage", "displayName": "AI triage", "description": "Enrich, reason, decide", "version": 1,
        "slots": [
            {"name": "enrich", "displayName": "Enrich", "accepts": {"capability": "ioc.enrich"}, "max": 1},
            {"name": "decide", "displayName": "Decide", "accepts": {"type": "triage.triageDecision"}},
        ],
        "rules": [{"rule": "feeds", "from": "enrich", "to": "decide"}],
        "outputs": [{"name": "decision", "slot": "decide"}],
    }
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any

from .errors import DescriptorError
from .protocol import CONNECTION_TYPES

CAPABILITY_RE = re.compile(r"^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$")
_IDENTIFIER_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]*$")
_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_CONNECTION_TYPES = CONNECTION_TYPES
_SUB_NODE_TYPES = tuple(t for t in CONNECTION_TYPES if t != "main")
_MATCHER_KEYS = ("type", "kind", "supplies", "category", "capability", "input", "composite", "anyOf")


def validate_capabilities(capabilities: Any, where: str) -> None:
    """Raise ``DescriptorError`` unless ``capabilities`` is a list of lowercase dotted tags like ``ioc.enrich``."""
    if not isinstance(capabilities, list):
        raise DescriptorError(f"{where}: capabilities must be a list of tags like 'ioc.enrich'")
    for tag in capabilities:
        if not isinstance(tag, str) or not CAPABILITY_RE.match(tag):
            raise DescriptorError(f"{where}: capability {tag!r} must be a lowercase dotted tag like 'ioc.enrich'")


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _values(value: Any) -> list[Any]:
    return list(value) if isinstance(value, list) else [value]


def _matcher_problems(path: str, matcher: Any) -> list[str]:
    if not isinstance(matcher, dict):
        return [f"{path}: a matcher must be an object"]
    problems: list[str] = []
    unknown = [key for key in matcher if key not in _MATCHER_KEYS]
    if unknown:
        problems.append(f"{path}: unknown matcher field(s) {unknown}")
    if not any(key in matcher for key in _MATCHER_KEYS):
        problems.append(f"{path}: a matcher needs at least one field")
    for key in ("type", "category", "composite"):
        if key in matcher and (matcher[key] == [] or not all(isinstance(v, str) and v for v in _values(matcher[key]))):
            problems.append(f"{path}: {key} must be a non-empty string or list of them")
    for key, allowed in (("kind", ("trigger", "action", "subnode")), ("supplies", _SUB_NODE_TYPES)):
        if key in matcher and (matcher[key] == [] or not all(v in allowed for v in _values(matcher[key]))):
            problems.append(f"{path}: {key} must be one or more of {allowed}")
    if "capability" in matcher:
        tags = _values(matcher["capability"])
        if not tags or not all(isinstance(t, str) and CAPABILITY_RE.match(t) for t in tags):
            problems.append(f"{path}: capability must be lowercase dotted tags like 'ioc.enrich'")
    if "input" in matcher and matcher["input"] not in _CONNECTION_TYPES:
        problems.append(f"{path}: input {matcher['input']!r} is not a connection type")
    if "anyOf" in matcher:
        if not isinstance(matcher["anyOf"], list) or not matcher["anyOf"]:
            problems.append(f"{path}: anyOf must be a non-empty list of matchers")
        else:
            for i, sub in enumerate(matcher["anyOf"]):
                problems.extend(_matcher_problems(f"{path}.anyOf[{i}]", sub))
    return problems


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def composite_problems(composite: Any) -> list[str]:
    """Every way ``composite`` breaks the contract (an empty list when it is valid)."""
    if not isinstance(composite, dict):
        return [f"a composite must be a descriptor dict, got {composite!r}"]
    problems: list[str] = []
    add = problems.append
    name = composite.get("name")
    if not isinstance(name, str) or not _IDENTIFIER_RE.match(name):
        add(f"composite name {name!r} must be an identifier (letters, digits, _ and -)")
    if not isinstance(composite.get("displayName"), str) or not composite["displayName"]:
        add("displayName is required")
    if not isinstance(composite.get("description"), str):
        add("description is required (a string)")
    if not _is_int(composite.get("version")) or composite["version"] < 1:
        add(f"version {composite.get('version')!r} must be a positive integer")
    if composite.get("color") is not None and not (isinstance(composite["color"], str) and _HEX_COLOR_RE.match(composite["color"])):
        add(f"color {composite.get('color')!r} must be a hex colour like '#2563eb'")
    if composite.get("onError") not in (None, "stop", "fallback"):
        add(f"onError {composite.get('onError')!r} must be 'stop' or 'fallback'")
    timeout = composite.get("timeoutSeconds")
    if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0):
        add("timeoutSeconds must be a positive number")

    slots = composite.get("slots")
    slot_names: set[str] = set()
    if not isinstance(slots, list) or not slots:
        add("a composite needs at least one slot")
        slots = []
    for i, slot in enumerate(slots):
        at = f"slots[{i}]"
        if not isinstance(slot, dict):
            add(f"{at} must be an object")
            continue
        slot_name = slot.get("name")
        if not isinstance(slot_name, str) or not _IDENTIFIER_RE.match(slot_name):
            add(f"{at}: slot name {slot_name!r} must be an identifier (letters, digits, _ and -)")
        elif slot_name in slot_names:
            add(f'duplicate slot "{slot_name}"')
        if isinstance(slot_name, str):
            slot_names.add(slot_name)
        if not isinstance(slot.get("displayName"), str) or not slot["displayName"]:
            add(f"{at}: displayName is required")
        problems.extend(_matcher_problems(f"{at}.accepts", slot.get("accepts")))
        low, high = slot.get("min"), slot.get("max")
        if low is not None and (not _is_int(low) or low < 0):
            add(f'slot "{slot_name}": min must be an integer >= 0')
        if high is not None:
            if not _is_int(high) or high < 1:
                add(f'slot "{slot_name}": max must be a positive integer')
            elif high < (low if _is_int(low) else 1):
                add(f'slot "{slot_name}": max is below min')

    def known(slot: Any, where: str) -> None:
        if slot is not None and slot not in slot_names:
            add(f'{where} names unknown slot "{slot}"')

    for key in ("inputs", "outputs"):
        for port in composite.get(key) or []:
            if not isinstance(port, dict):
                add(f"{key} entries must be objects")
                continue
            if not isinstance(port.get("name"), str) or not _IDENTIFIER_RE.match(port["name"]):
                add(f"port name {port.get('name')!r} must be an identifier (letters, digits, _ and -)")
            if port.get("index") is not None and (not _is_int(port["index"]) or port["index"] < 0):
                add(f"port \"{port.get('name')}\": index must be an integer >= 0")
            known(port.get("slot"), f"port \"{port.get('name')}\"")

    for i, rule in enumerate(composite.get("rules") or []):
        at = f"rules[{i}]"
        kind = rule.get("rule") if isinstance(rule, dict) else None
        if kind == "feeds":
            for key in ("from", "to"):
                if not isinstance(rule.get(key), str) or not rule[key]:
                    add(f"{at}: a feeds rule needs {key}")
            known(rule.get("from"), "a feeds rule")
            known(rule.get("to"), "a feeds rule")
            if rule.get("via") is not None and rule["via"] not in _CONNECTION_TYPES:
                add(f"{at}: via {rule['via']!r} is not a connection type")
        elif kind == "onError":
            rule_slots = rule.get("slots")
            if not isinstance(rule_slots, list) or not rule_slots:
                add(f"{at}: an onError rule needs a non-empty slots list")
                rule_slots = []
            if rule.get("value") not in ("stop", "continue"):
                add(f"{at}: value must be 'stop' or 'continue'")
            for slot in rule_slots:
                known(slot, "an onError rule")
        elif kind == "reaches":
            if not isinstance(rule.get("to"), str) or not rule["to"]:
                add(f"{at}: a reaches rule needs to")
            known(rule.get("to"), "a reaches rule")
        elif kind != "sealed":
            add(f"{at}: rule {kind!r} must be one of feeds, onError, reaches, sealed")

    starter = composite.get("starter")
    if starter is not None:
        if not isinstance(starter, dict) or not isinstance(starter.get("nodes"), list) or not isinstance(starter.get("connections"), list):
            add("starter needs nodes and connections lists")
        else:
            ids = set()
            for node in starter["nodes"]:
                if not isinstance(node, dict) or not all(isinstance(node.get(k), str) and node[k] for k in ("id", "name", "type")):
                    add(f"starter node {node!r} needs id, name and type")
                    continue
                position = node.get("position")
                if not (isinstance(position, (list, tuple)) and len(position) == 2 and all(isinstance(p, (int, float)) for p in position)):
                    add(f"starter node \"{node['id']}\": position must be [x, y]")
                ids.add(node["id"])
                known(node.get("slot"), f"starter node \"{node['id']}\"")
                at_node = f"starter node \"{node['id']}\""
                if node.get("onError") not in (None, "stop", "continue"):
                    add(f"{at_node}: onError {node.get('onError')!r} must be 'stop' or 'continue'")
                if "retryOnFail" in node and not isinstance(node["retryOnFail"], bool):
                    add(f"{at_node}: retryOnFail must be true or false")
                tries = node.get("maxTries")
                if tries is not None and not (_is_int(tries) and tries > 0):
                    add(f"{at_node}: maxTries must be a positive integer")
                wait = node.get("waitBetweenTriesMs")
                if wait is not None and not (_is_int(wait) and 0 <= wait <= 60_000):
                    add(f"{at_node}: waitBetweenTriesMs must be an integer from 0 to 60000")
                if node.get("retryBackoff") not in (None, "fixed", "exponential"):
                    add(f"{at_node}: retryBackoff {node.get('retryBackoff')!r} must be 'fixed' or 'exponential'")
            for conn in starter["connections"]:
                if not isinstance(conn, dict) or conn.get("source") not in ids or conn.get("target") not in ids:
                    source = conn.get("source") if isinstance(conn, dict) else conn
                    target = conn.get("target") if isinstance(conn, dict) else conn
                    add(f"starter connection {source} → {target} names an unknown node")
    return problems


def validate_composite(entry: Any) -> dict[str, Any]:
    """Validate one composite descriptor and return a deep copy of it, ready for the manifest."""
    problems = composite_problems(entry)
    if problems:
        label = entry.get("name") if isinstance(entry, dict) and isinstance(entry.get("name"), str) else "?"
        raise DescriptorError(f"composite {label!r}: " + "; ".join(problems))
    descriptor = copy.deepcopy(entry)
    try:
        json.dumps(descriptor, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise DescriptorError(f"composite {descriptor['name']!r}: descriptor is not JSON-serializable ({exc})") from None
    return descriptor
