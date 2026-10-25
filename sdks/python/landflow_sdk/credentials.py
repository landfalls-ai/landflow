"""Credential types: the kinds of secrets a plugin's nodes use (docs/protocol.md §7).

    def test_github(data, ctx):
        resp = ctx.http.get(f"{data['baseUrl']}/user", headers={"Authorization": f"Bearer {data['accessToken']}"})
        return resp.ok, None if resp.ok else f"GitHub said {resp.status}"

    github_api = CredentialType(
        name="githubApi", display_name="GitHub API", test=test_github,
        properties=[
            {"name": "accessToken", "displayName": "Access token", "type": "string", "required": True,
             "typeOptions": {"password": True}},
            {"name": "baseUrl", "displayName": "API base URL", "type": "string", "default": "https://api.github.com"},
        ],
    )
    Plugin("github", "GitHub", "0.1.0", nodes=[...], credential_types=[github_api])
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Mapping

from .redact import collect_strings, is_secret_key

TestFunction = Callable[..., Any]


@dataclass
class CredentialType:
    """One ``CredentialTypeDescriptor`` plus an optional ``test(data, ctx)`` for "Test connection".

    ``test`` returns ``(ok, message)``, ``{"ok": bool, "message": str}``, a bool,
    or ``None`` (= ok); an exception means ``ok: false`` with its message.
    ``data`` already has the properties' defaults filled in.
    """

    name: str
    display_name: str
    properties: list[dict[str, Any]] = field(default_factory=list)
    documentation_url: str | None = None
    description: str | None = None
    icon: str | None = None
    test: TestFunction | None = None
    #: Credential types this one builds on, e.g. ``["oAuth2Api"]``: the host merges their properties in and an
    #: OAuth2 type gets a Connect button and a fresh ``accessToken`` in its data (docs/protocol.md §7).
    extends: list[str] | None = None

    @property
    def testable(self) -> bool:
        return self.test is not None

    def descriptor(self) -> dict[str, Any]:
        """The ``CredentialTypeDescriptor`` JSON object."""
        out: dict[str, Any] = {"name": self.name, "displayName": self.display_name}
        if self.description:
            out["description"] = self.description
        if self.icon:
            out["icon"] = self.icon
        if self.documentation_url:
            out["documentationUrl"] = self.documentation_url
        out["properties"] = self.properties
        if self.testable:
            out["testable"] = True
        if self.extends:
            out["extends"] = list(self.extends)
        return out

    def with_defaults(self, data: Mapping[str, Any]) -> dict[str, Any]:
        """``data`` with each property's ``default`` filled in where the value is missing or ``None``."""
        out = {p["name"]: p["default"] for p in self.properties if "default" in p and p.get("type") != "notice"}
        out.update({k: v for k, v in data.items() if v is not None or k not in out})
        return out

    def secret_values(self, data: Mapping[str, Any]) -> Iterator[str]:
        """Strings to redact: password fields, secret-looking keys, and any field the type does not declare."""
        declared = {p["name"]: p for p in self.properties if isinstance(p, dict)}
        for key, value in data.items():
            prop = declared.get(key)
            password = bool(prop and (prop.get("typeOptions") or {}).get("password"))
            if prop is None or password or is_secret_key(key):
                yield from collect_strings(value)
            else:
                yield from _nested_secrets(value)


def _nested_secrets(value: Any) -> Iterator[str]:
    if isinstance(value, Mapping):
        for key, inner in value.items():
            if is_secret_key(str(key)):
                yield from collect_strings(inner)
            else:
                yield from _nested_secrets(inner)
    elif isinstance(value, (list, tuple)):
        for inner in value:
            yield from _nested_secrets(inner)


def secret_values(credentials: Mapping[str, Any] | None, types: Mapping[str, CredentialType]) -> list[str]:
    """Every secret string in an ``ExecuteRequest.credentials`` map (unknown types: all strings)."""
    out: list[str] = []
    for name, data in (credentials or {}).items():
        ctype = types.get(name)
        if ctype is not None and isinstance(data, Mapping):
            out.extend(ctype.secret_values(data))
        else:
            out.extend(collect_strings(data))
    return out


def normalize_test_result(result: Any) -> tuple[bool, str | None]:
    if result is None:
        return True, None
    if isinstance(result, bool):
        return result, None
    if isinstance(result, tuple) and 1 <= len(result) <= 2:
        message = result[1] if len(result) == 2 else None
        return bool(result[0]), None if message in (None, "") else str(message)
    if isinstance(result, Mapping) and "ok" in result:
        message = result.get("message")
        return bool(result["ok"]), None if message in (None, "") else str(message)
    raise TypeError(f"credential test must return (ok, message), {{'ok': bool, 'message': str}} or a bool, got {result!r}")
