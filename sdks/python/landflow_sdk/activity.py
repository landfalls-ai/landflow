"""Activity items: one change in an outside tool (a message, an edited document, a moved ticket, a held meeting).

The same shape whatever the tool, so one flow can take items from any integration trigger or List Changed Since
operation. The schema is ``packages/protocol/activity-items/activity-item.schema.json``; the TypeScript
(``activityItem``) and Go (``landflow.ActivityItem``) SDKs build the same output, checked against the shared cases in
``packages/protocol/activity-items/cases.json``::

    from landflow_sdk.activity import ACTIVITY_ITEM_SCHEMA, activity_item

    item = activity_item(source="notion", source_id=f"notion:page:{page['id']}", occurred_at=page["last_edited_time"],
                         kind="work.doc_edited", title=title, summary=text, raw=page)
"""

from __future__ import annotations

import json
import math
import re
from datetime import date, datetime, timezone
from typing import Any

ACTIVITY_TITLE_MAX = 200
ACTIVITY_SUMMARY_MAX = 600
ACTIVITY_HINT_MAX = 200
#: Strings inside ``raw`` keep this many characters.
ACTIVITY_RAW_STRING_MAX = 1000
#: Lists inside ``raw`` keep this many entries.
ACTIVITY_RAW_LIST_MAX = 25
#: Objects and lists this deep inside ``raw`` become "…".
ACTIVITY_RAW_DEPTH_MAX = 5

_KIND = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$")
_ELLIPSIS = "…"
_UNSET: Any = object()


def _opt(description: str) -> dict[str, Any]:
    return {"type": ["string", "null"], "description": description}


#: The JSON Schema of one activity item: a node's (or operation's) ``outputSchema``.
ACTIVITY_ITEM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "source": {"type": "string", "description": "The tool, lowercase: slack, google-drive, google-calendar, notion, …"},
        "sourceId": {"type": "string", "description": "Stable id of the change, '<source>:<tool ids>': the same change always has the same id, so a replay is recognised"},
        "url": _opt("Where a person opens it"),
        "actorEmail": _opt("Email of the person who made the change, lowercase; null when the tool doesn't say"),
        "occurredAt": {"type": "string", "format": "date-time", "description": "When it happened, ISO 8601 in UTC with milliseconds"},
        "kind": {"type": "string", "pattern": r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$", "description": "Suggested event kind, such as work.discussion or work.doc_edited; a flow may change it"},
        "title": {"type": "string", "maxLength": 200, "description": "One line: the document, ticket or meeting title, or the channel and first words"},
        "summary": {"type": "string", "maxLength": 600, "description": "The text, whitespace collapsed, at most 600 characters"},
        "teamHint": _opt("The team it seems to belong to, from the tool's own grouping, when there is one"),
        "initiativeHint": _opt("The project or initiative it seems to belong to, when there is one"),
        "customerHint": _opt("The customer it is about, when there is one (a #customer-<name> channel, a CRM company…)"),
        "raw": {"type": "object", "description": "The tool's own object, trimmed: long strings clipped, long lists cut, deep nesting dropped"},
        "cursor": _opt("Pass it back as Since to continue after this item (List Changed Since operations)"),
    },
    "required": ["source", "sourceId", "url", "actorEmail", "occurredAt", "kind", "title", "summary", "teamHint", "initiativeHint", "customerHint", "raw"],
    "additionalProperties": False,
}


def clip_text(text: str, limit: int) -> str:
    """At most ``limit`` characters; a longer text ends in "…" within the limit."""
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + _ELLIPSIS


def collapse_whitespace(text: str) -> str:
    """Runs of whitespace (newlines included) become one space; ends trimmed."""
    return " ".join(text.split())


def _line(value: Any, limit: int) -> str:
    return clip_text(collapse_whitespace("" if value is None else str(value)), limit)


def _optional(value: Any, limit: int) -> str | None:
    return _line(value, limit) or None


def to_iso_time(value: Any) -> str:
    """ISO 8601 in UTC with milliseconds, from an ISO string (a date alone, or a time without an offset, is UTC), epoch
    milliseconds or a datetime/date. Raises ValueError on anything else."""
    if isinstance(value, bool):
        raise ValueError(f"occurredAt is not a time: {value!r}")
    if isinstance(value, datetime):
        moment = value
    elif isinstance(value, date):
        moment = datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    elif isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"occurredAt is not a time: {value!r}")
        moment = datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc)
    elif isinstance(value, str):
        text = value.strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}", text):
            raise ValueError(f"occurredAt is not a time: {value!r}")
        try:
            moment = datetime.fromisoformat(text)
        except ValueError as error:
            raise ValueError(f"occurredAt is not a time: {value!r}") from error
    else:
        raise ValueError(f"occurredAt is not a time: {value!r}")
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def _normalize(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int, float, dict, list)):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return str(value)


def trim_raw(value: Any, depth: int = 0) -> Any:
    """A vendor object made small: strings clipped, lists cut, deep nesting replaced by "…"."""
    value = _normalize(value)
    if isinstance(value, str):
        return clip_text(value, ACTIVITY_RAW_STRING_MAX)
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, list):
        if depth >= ACTIVITY_RAW_DEPTH_MAX:
            return _ELLIPSIS
        return [trim_raw(entry, depth + 1) for entry in value[:ACTIVITY_RAW_LIST_MAX]]
    if isinstance(value, dict):
        if depth >= ACTIVITY_RAW_DEPTH_MAX:
            return _ELLIPSIS
        return {str(key): trim_raw(entry, depth + 1) for key, entry in value.items()}
    return value


def activity_item(*, source: str, source_id: str, occurred_at: Any, kind: str, url: str | None = None,
                  actor_email: str | None = None, title: str | None = None, summary: str | None = None,
                  team_hint: str | None = None, initiative_hint: str | None = None, customer_hint: str | None = None,
                  raw: Any = None, cursor: Any = _UNSET) -> dict[str, Any]:
    """One activity item, normalised: the same output as the TypeScript and Go SDKs for the same input. Raises
    ValueError on a missing source or source id, a bad kind or time. Leave ``cursor`` out for an item without one."""
    src = str(source or "").strip().lower()
    if not src:
        raise ValueError("source is required")
    sid = str(source_id or "").strip()
    if not sid:
        raise ValueError("sourceId is required")
    knd = str(kind or "").strip().lower()
    if not _KIND.match(knd):
        raise ValueError(f"kind must be <namespace>.<name> in lowercase letters, digits and underscores (got {kind!r})")
    occurred = to_iso_time(occurred_at)
    body = _normalize(raw)
    if body is None:
        body = {}
    elif not isinstance(body, dict):
        body = {"value": body}
    email = str(actor_email or "").strip().lower()
    item: dict[str, Any] = {
        "source": src,
        "sourceId": sid,
        "url": str(url or "").strip() or None,
        "actorEmail": email if "@" in email else None,
        "occurredAt": occurred,
        "kind": knd,
        "title": _line(title, ACTIVITY_TITLE_MAX) or clip_text(sid, ACTIVITY_TITLE_MAX),
        "summary": _line(summary, ACTIVITY_SUMMARY_MAX),
        "teamHint": _optional(team_hint, ACTIVITY_HINT_MAX),
        "initiativeHint": _optional(initiative_hint, ACTIVITY_HINT_MAX),
        "customerHint": _optional(customer_hint, ACTIVITY_HINT_MAX),
        "raw": trim_raw(body),
    }
    if cursor is not _UNSET:
        item["cursor"] = (str(cursor).strip() or None) if cursor is not None else None
    return item
