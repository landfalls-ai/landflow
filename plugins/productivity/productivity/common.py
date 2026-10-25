"""Shared helpers: API calls with error mapping, Return All / Limit, JSON and key/value parameters, metrics."""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterable, Iterator

from landflow_sdk import HttpError, HttpResponse, NodeOperationError

SERVICES = {"notion": "Notion", "airtable": "Airtable", "github": "GitHub", "jira": "Jira", "hubspot": "HubSpot", "rss": "RSS"}
RECORDS_WRITTEN = "landflow.productivity.records_written"
POLL_NEW_ITEMS = "landflow.productivity.poll.new_items"
API_ERRORS = "landflow.productivity.api_errors"

_STATUS_HINTS = {
    400: "The service rejected the request; check the parameters.",
    401: "The token was rejected; check the credential.",
    403: "The token lacks permission for this resource.",
    404: "Not found; check the ids and names (and that the token can see them).",
    409: "Conflict with the current state of the resource.",
    422: "The service could not process the values sent.",
    429: "Rate limited by the service; retry later.",
}


# ------------------------------------------------------------------ metrics


def count_written(ctx: Any, service: str, operation: str, count: int = 1) -> None:
    """``landflow.productivity.records_written`` (service, operation)."""
    if count:
        ctx.metrics.counter(RECORDS_WRITTEN, description="Records created, updated or deleted in a productivity service").add(
            count, {"service": service, "operation": operation}
        )


def count_new_items(ctx: Any, trigger: str, count: int) -> None:
    """``landflow.productivity.poll.new_items`` (trigger)."""
    ctx.metrics.counter(POLL_NEW_ITEMS, description="New items found by a productivity polling trigger").add(count, {"trigger": trigger})


def count_api_error(ctx: Any, service: str, status: int | None) -> None:
    """``landflow.productivity.api_errors`` (service, status_class = 4xx / 5xx / network)."""
    status_class = "network" if status is None else f"{status // 100}xx"
    ctx.metrics.counter(API_ERRORS, description="Failed calls to a productivity service API").add(
        1, {"service": service, "status_class": status_class}
    )


# ------------------------------------------------------------------- errors


def error_text(resp: HttpResponse) -> str | None:
    """The service's own error message, whatever its shape (Notion, Airtable, GitHub, Jira, HubSpot)."""
    body = resp.json
    parts: list[str] = []
    if isinstance(body, dict):
        if isinstance(body.get("message"), str):  # Notion, GitHub, HubSpot
            parts.append(body["message"])
        error = body.get("error")
        if isinstance(error, dict):  # Airtable {"error": {"type", "message"}}
            parts.append(str(error.get("message") or error.get("type") or ""))
        elif isinstance(error, str):
            parts.append(error)
        if isinstance(body.get("errorMessages"), list):  # Jira
            parts.extend(str(m) for m in body["errorMessages"])
        errors = body.get("errors")
        if isinstance(errors, dict):  # Jira field errors
            parts.extend(f"{key}: {value}" for key, value in errors.items())
        elif isinstance(errors, list):  # GitHub validation errors, HubSpot
            for entry in errors:
                if isinstance(entry, dict):
                    detail = entry.get("message") or " ".join(str(entry[k]) for k in ("resource", "field", "code") if entry.get(k))
                    parts.append(str(detail))
                elif isinstance(entry, str):
                    parts.append(entry)
    elif resp.content.strip() and "html" not in resp.headers.get("Content-Type", ""):
        parts.append(resp.text.strip())
    seen: list[str] = []
    for part in parts:
        part = " ".join(part.split())
        if part and part not in seen:
            seen.append(part)
    text = "; ".join(seen)
    return text[:500] if text else None


def api_error(service: str, resp: HttpResponse, item_index: int | None = None) -> NodeOperationError:
    """``"<Service> API error (HTTP 404): <the service's message>"`` with a hint as the description."""
    name = SERVICES.get(service, service)
    text = error_text(resp) or resp.reason or "no details"
    return NodeOperationError(f"{name} API error (HTTP {resp.status}): {text}", description=_STATUS_HINTS.get(resp.status), item_index=item_index)


# ---------------------------------------------------------------------- API


class Api:
    """``ctx.http`` bound to one service: base URL, auth headers, error mapping and the api_errors metric.

    Works with every SDK context (execute, load options, credential test): each call is an
    ``HTTP {METHOD}`` client span carrying the trace context.
    """

    def __init__(self, ctx: Any, service: str, base_url: str, headers: dict[str, str]) -> None:
        self.ctx = ctx
        self.service = service
        self.base_url = (base_url or "").strip().rstrip("/")
        self.headers = headers
        self.item_index: int | None = None  # set by the node while it processes an item

    def url(self, path: str) -> str:
        return path if path.startswith(("http://", "https://")) else f"{self.base_url}{path}"

    def request(
        self,
        method: str,
        path: str,
        *,
        params: Any = None,
        json: Any = None,
        headers: dict[str, str] | None = None,
        timeout: float = 30,
    ) -> HttpResponse:
        if not self.base_url and not path.startswith(("http://", "https://")):
            raise NodeOperationError(f"{SERVICES[self.service]}: the credential has no base URL / domain", item_index=self.item_index)
        try:
            resp = self.ctx.http.request(
                method, self.url(path), params=params, json=json, headers={**self.headers, **(headers or {})}, timeout=timeout
            )
        except HttpError as exc:  # network failure: no response
            count_api_error(self.ctx, self.service, None)
            raise NodeOperationError(
                f"{SERVICES[self.service]} API unreachable: {exc.message}", description="Check the base URL / domain of the credential.",
                item_index=self.item_index,
            ) from None
        except ValueError as exc:  # not an absolute http(s) URL
            raise NodeOperationError(f"{SERVICES[self.service]}: {exc}", item_index=self.item_index) from None
        if resp.status >= 400:
            count_api_error(self.ctx, self.service, resp.status)
            raise api_error(self.service, resp, self.item_index)
        return resp

    def call(self, method: str, path: str, **kwargs: Any) -> Any:
        """``request(...)`` and return the parsed JSON body (``None`` for an empty body)."""
        return self.request(method, path, **kwargs).json

    def get(self, path: str, **kwargs: Any) -> Any:
        return self.call("GET", path, **kwargs)


def test_call(api: Api, path: str) -> tuple[bool, str | None, Any]:
    """Credential test helper: ``(ok, failure reason, body)``; never raises for HTTP failures."""
    try:
        return True, None, api.get(path)
    except NodeOperationError as exc:
        return False, exc.message, None


# --------------------------------------------------------------- parameters


def items_of(ctx: Any) -> list[dict[str, Any]]:
    """Input items, or one empty item so an action still runs once without input."""
    return ctx.get_input_data() or [{"json": {}}]


def param(ctx: Any, name: str, i: int, default: Any = None) -> Any:
    value = ctx.get_node_parameter(name, i, default)
    return default if value is None else value


def text_param(ctx: Any, name: str, i: int, *, required: bool = False, label: str | None = None) -> str:
    value = ctx.get_node_parameter(name, i)
    text = "" if value is None else str(value).strip()
    if required and not text:
        raise NodeOperationError(f"'{label or name}' is required", item_index=i)
    return text


def bool_param(ctx: Any, name: str, i: int, default: bool = False) -> bool:
    value = ctx.get_node_parameter(name, i, default)
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on")
    return bool(value)


def collection(ctx: Any, name: str, i: int) -> dict[str, Any]:
    value = ctx.get_node_parameter(name, i) or {}
    return dict(value) if isinstance(value, dict) else {}


def json_param(ctx: Any, name: str, i: int, *, expect: type | tuple[type, ...] = dict, label: str | None = None) -> Any:
    """A ``json`` parameter: a JSON string (or an already parsed value); empty -> ``None``."""
    return parse_json(ctx.get_node_parameter(name, i), label or name, i, expect=expect)


def parse_json(value: Any, label: str, i: int, *, expect: type | tuple[type, ...] = dict) -> Any:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as exc:
            raise NodeOperationError(f"'{label}' is not valid JSON: {exc}", item_index=i) from None
    if not isinstance(value, expect):
        kinds = expect if isinstance(expect, tuple) else (expect,)
        wanted = " or ".join("an object" if k is dict else "an array" if k is list else k.__name__ for k in kinds)
        raise NodeOperationError(f"'{label}' must be {wanted}", item_index=i)
    return value


def fixed_entries(value: Any, group: str) -> list[dict[str, Any]]:
    """Rows of a repeatable fixedCollection: ``{group: [{...}, ...]}`` (a bare list is accepted too)."""
    if isinstance(value, dict):
        value = value.get(group)
    if isinstance(value, dict):
        value = [value]
    return [row for row in value or [] if isinstance(row, dict)]


def split_list(value: Any) -> list[str]:
    """``"a, b"`` or ``["a", "b"]`` -> ``["a", "b"]`` (empty entries dropped)."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [str(v).strip() for v in value if str(v).strip()]
    return [part.strip() for part in str(value).split(",") if part.strip()]


def limit_of(ctx: Any, i: int) -> int | None:
    """``None`` when Return All is on, else the Limit (at least 1)."""
    if bool_param(ctx, "returnAll", i):
        return None
    try:
        return max(1, int(float(ctx.get_node_parameter("limit", i, 50))))
    except (TypeError, ValueError):
        raise NodeOperationError("'Limit' must be a number", item_index=i) from None


def return_all_properties(show: dict[str, list[Any]], default_limit: int = 50, max_limit: int | None = None) -> list[dict[str, Any]]:
    """Return All (boolean) + Limit (number, shown when Return All is off) for the given ``displayOptions.show``."""
    limit_options: dict[str, Any] = {"minValue": 1}
    if max_limit:
        limit_options["maxValue"] = max_limit
    return [
        {
            "name": "returnAll",
            "displayName": "Return All",
            "type": "boolean",
            "default": False,
            "description": "Whether to return all results or only up to a given limit",
            "displayOptions": {"show": show},
        },
        {
            "name": "limit",
            "displayName": "Limit",
            "type": "number",
            "default": default_limit,
            "typeOptions": limit_options,
            "description": "Max number of results to return",
            "displayOptions": {"show": {**show, "returnAll": [False]}},
        },
    ]


def simplify_property(show: dict[str, list[Any]], description: str = "Whether to return a simplified version of the response instead of the raw data") -> dict[str, Any]:
    return {"name": "simplify", "displayName": "Simplify", "type": "boolean", "default": True, "description": description, "displayOptions": {"show": show}}


def resource_property(options: list[tuple[str, str]], default: str) -> dict[str, Any]:
    return {
        "name": "resource",
        "displayName": "Resource",
        "type": "options",
        "noDataExpression": True,
        "default": default,
        "options": [{"name": name, "value": value} for name, value in options],
    }


def operation_property(resource: str, options: list[tuple[str, str, str]], default: str) -> dict[str, Any]:
    """``operation`` for one resource: ``(display name, value, action)`` triples."""
    return {
        "name": "operation",
        "displayName": "Operation",
        "type": "options",
        "noDataExpression": True,
        "default": default,
        "displayOptions": {"show": {"resource": [resource]}},
        "options": [{"name": name, "value": value, "action": action} for name, value, action in options],
    }


def chunks(values: list[Any], size: int) -> Iterator[list[Any]]:
    for start in range(0, len(values), size):
        yield values[start:start + size]


@contextmanager
def item_errors(ctx: Any, results: list[dict[str, Any]], i: int) -> Iterator[None]:
    """Wraps one item's work. When the node continues on fail, an error becomes the output item
    ``{"error": message}`` for item ``i`` and the loop goes on; otherwise it propagates."""
    try:
        yield
    except Exception as exc:  # noqa: BLE001 - n8n's continueOnFail catches every error
        if not ctx.continue_on_fail():
            raise
        error: dict[str, Any] = {"error": getattr(exc, "message", None) or str(exc)}
        if getattr(exc, "description", None):
            error["description"] = exc.description
        results.append(out(error, i))


def out(json_value: Any, i: int) -> dict[str, Any]:
    """An output item paired with input item ``i``."""
    return {"json": json_value if isinstance(json_value, dict) else {"value": json_value}, "pairedItem": {"item": i}}


def outs(values: Iterable[Any], i: int) -> list[dict[str, Any]]:
    return [out(v, i) for v in values]
