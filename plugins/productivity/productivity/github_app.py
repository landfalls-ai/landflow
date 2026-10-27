"""GitHub App authentication: the app's private key signs a short-lived JWT (``landflow_sdk.jwt``), the JWT is traded for an
installation token (``POST /app/installations/{id}/access_tokens``, valid one hour) and the token authenticates the nodes' calls.

The installation token is cached in this process until 60 seconds before its ``expires_at`` and minted again after a 401.
Without an Installation ID the installation is found from the repository a call is about (``GET /repos/{owner}/{repo}/installation``,
which takes the app JWT), or, for a call without a repository, from the app's only installation."""

from __future__ import annotations

import hashlib
import re
import threading
import time
from datetime import datetime
from typing import Any

from landflow_sdk import CredentialType, HttpResponse, NodeOperationError
from landflow_sdk.jwt import JwtError, github_app_jwt

from .common import Api, api_error, count_api_error, test_call

DEFAULT_BASE_URL = "https://api.github.com"
REFRESH_MARGIN_SECONDS = 60
_REPO_PATH = re.compile(r"^/repos/([^/]+)/([^/?#]+)")
_lock = threading.Lock()
_tokens: dict[tuple[str, ...], tuple[str, float]] = {}  # (base, app, installation, key digest) -> (token, expiry epoch)
_installations: dict[tuple[str, ...], str] = {}  # (base, app, key digest, "owner/repo" or "") -> installation id

PERMISSIONS_HINT = (
    "Install the app on the repositories the workflow uses. Permissions: Repository webhooks (read and write) for the webhook trigger, "
    "Contents, Issues and Pull requests (read, and write to change them) as the nodes need, and Metadata (read)."
)


def _now() -> float:  # a seam for tests
    return time.time()


def _expiry(text: Any) -> float:
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return _now() + 3000  # unknown: assume a bit under the usual hour


def is_app_credentials(creds: dict[str, Any]) -> bool:
    return bool(creds.get("privateKey")) and bool(creds.get("appId"))


def _digest(creds: dict[str, Any]) -> str:
    return hashlib.sha256(str(creds.get("privateKey") or "").encode()).hexdigest()[:16]


def _base(creds: dict[str, Any]) -> str:
    return (creds.get("baseUrl") or DEFAULT_BASE_URL).strip().rstrip("/")


class GitHubApi(Api):
    """The GitHub REST API (``Api``) with a personal/OAuth token, or as a GitHub App installation (``creds`` of ``githubAppApi``)."""

    def __init__(self, ctx: Any, creds: dict[str, Any]) -> None:
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        self.app = creds if is_app_credentials(creds) else None
        if self.app is None:
            headers["Authorization"] = f"Bearer {creds.get('accessToken', '')}"
        super().__init__(ctx, "github", _base(creds), headers)

    # -- app plumbing

    def _jwt_api(self) -> Api:
        assert self.app is not None
        try:
            token = github_app_jwt(self.app.get("appId"), str(self.app.get("privateKey") or ""), now=_now())
        except JwtError as exc:
            raise NodeOperationError(f"GitHub App: {exc}", description="Paste the app's private key (.pem) into the credential.",
                                     item_index=self.item_index) from None
        return Api(self.ctx, "github", self.base_url, {**self.headers, "Authorization": f"Bearer {token}"})

    def _installation_id(self, path: str) -> str:
        assert self.app is not None
        configured = str(self.app.get("installationId") or "").strip()
        if configured:
            return configured
        match = _REPO_PATH.match(path) if not path.startswith(("http://", "https://")) else None
        repo = f"{match.group(1)}/{match.group(2)}" if match else ""
        key = (self.base_url, str(self.app.get("appId")), _digest(self.app), repo)
        with _lock:
            if key in _installations:
                return _installations[key]
        jwt_api = self._jwt_api()
        if repo:
            resp = jwt_api.request("GET", f"/repos/{match.group(1)}/{match.group(2)}/installation", expect=(404,))  # type: ignore[union-attr]
            if resp.status == 404:
                raise NodeOperationError(f"The GitHub App is not installed on {repo}", description=PERMISSIONS_HINT, item_index=self.item_index)
            found = (resp.json or {}).get("id") if isinstance(resp.json, dict) else None
        else:
            installs = jwt_api.get("/app/installations", params={"per_page": 2})
            installs = installs if isinstance(installs, list) else []
            if len(installs) != 1:
                raise NodeOperationError("GitHub App: set the credential's Installation ID (this call is not about one repository, and the app has "
                                         f"{'no installation' if not installs else 'several installations'})", item_index=self.item_index)
            found = installs[0].get("id")
        if not found:
            raise NodeOperationError("GitHub App: no installation found", description=PERMISSIONS_HINT, item_index=self.item_index)
        with _lock:
            _installations[key] = str(found)
        return str(found)

    def installation_token(self, path: str = "", *, fresh: bool = False) -> str:
        """The cached installation token, or a newly minted one (also when ``fresh``)."""
        assert self.app is not None
        installation = self._installation_id(path)
        key = (self.base_url, str(self.app.get("appId")), installation, _digest(self.app))
        with _lock:
            cached = _tokens.get(key)
            if fresh:
                _tokens.pop(key, None)
            elif cached and cached[1] - REFRESH_MARGIN_SECONDS > _now():
                return cached[0]
        body = self._jwt_api().call("POST", f"/app/installations/{installation}/access_tokens")
        token = (body or {}).get("token") if isinstance(body, dict) else None
        if not token:
            raise NodeOperationError("GitHub App: GitHub returned no installation token", item_index=self.item_index)
        with _lock:
            _tokens[key] = (str(token), _expiry(body.get("expires_at")))
        self.ctx.logger.info("minted a GitHub App installation token", installation=installation)
        return str(token)

    # -- requests

    def request(self, method: str, path: str, *, expect: tuple[int, ...] = (), **kwargs: Any) -> HttpResponse:
        if self.app is None:
            return super().request(method, path, expect=expect, **kwargs)
        for attempt in (0, 1):
            self.headers["Authorization"] = f"Bearer {self.installation_token(path, fresh=attempt == 1)}"
            resp = super().request(method, path, expect=tuple({*expect, 401}), **kwargs)
            if resp.status != 401 or attempt == 1:
                break  # a revoked or expired token is minted again once
        if resp.status >= 400 and resp.status not in expect:
            count_api_error(self.ctx, self.service, resp.status)
            raise api_error(self.service, resp, self.item_index)
        return resp


def github_api(ctx: Any, creds: dict[str, Any]) -> GitHubApi:
    return GitHubApi(ctx, creds)


def test_github_app(data: dict[str, Any], ctx: Any) -> tuple[bool, str]:
    api = GitHubApi(ctx, data)
    if not is_app_credentials(data):
        return False, "App ID and Private Key are required"
    try:
        ok, reason, app = test_call(api._jwt_api(), "/app")
        if not ok:
            return False, reason or "GitHub rejected the app JWT"
        name = app.get("slug") or app.get("name") if isinstance(app, dict) else None
        if str(data.get("installationId") or "").strip():
            api.installation_token("", fresh=True)
        return True, f"authenticated as GitHub App {name}" if name else "authenticated as a GitHub App"
    except NodeOperationError as exc:
        return False, exc.message


GITHUB_APP_API = CredentialType(
    name="githubAppApi",
    display_name="GitHub App API",
    documentation_url="https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation",
    description="Act as a GitHub App installation instead of a person: create the app (Settings, Developer settings, GitHub Apps), generate a "
                "private key, install the app on the repositories. " + PERMISSIONS_HINT + " Landflow signs a JWT with the key and trades it for "
                "an installation token (renewed before it expires). Leave Installation ID empty to find it from each repository.",
    test=test_github_app,
    properties=[
        {"name": "appId", "displayName": "App ID", "type": "string", "required": True, "placeholder": "123456",
         "description": "The app's numeric App ID (or its Client ID) from the app's settings page"},
        {"name": "privateKey", "displayName": "Private Key", "type": "string", "required": True, "typeOptions": {"password": True},
         "placeholder": "-----BEGIN RSA PRIVATE KEY-----…",
         "description": "The .pem file GitHub generated (PKCS#1 or PKCS#8). A single line with the BEGIN/END markers works too."},
        {"name": "installationId", "displayName": "Installation ID", "type": "string", "default": "", "placeholder": "optional",
         "description": "From the installation's URL (…/settings/installations/<id>). Empty: found from the repository of each call."},
        {"name": "baseUrl", "displayName": "API Base URL", "type": "string", "default": DEFAULT_BASE_URL,
         "description": "GitHub Enterprise Server: https://<host>/api/v3"},
    ],
)
