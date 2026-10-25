"""``ctx.http``: a stdlib (urllib) HTTP client with a client span and ``traceparent``.

    resp = ctx.http.request("GET", f"{base}/user", headers={"Authorization": f"Bearer {token}"})
    resp.raise_for_status()
    login = resp.json["login"]

Every call opens an ``HTTP {METHOD}`` client span (``http.request.method``,
``server.address``, ``server.port``, ``url.full`` without the query string,
``http.response.status_code``), injects W3C trace context into the request
headers and records ``http.client.request.duration``. 4xx/5xx responses are
returned, not raised (call ``raise_for_status()``); network failures raise
``HttpError``.
"""

from __future__ import annotations

import json as _json
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterator, Mapping, MutableMapping

from ._version import __version__
from .errors import NodeOperationError
from .redact import redact_text

DEFAULT_TIMEOUT_SECONDS = 30.0
USER_AGENT = f"landflow-sdk-python/{__version__}"
_DEFAULT_PORTS = {"http": 80, "https": 443}


class HttpHeaders(Mapping[str, str]):
    """Case-insensitive, read-only response headers (repeated headers joined with ``", "``)."""

    def __init__(self, pairs: Any = ()) -> None:
        self._items: dict[str, tuple[str, str]] = {}
        for key, value in pairs:
            lower = key.lower()
            if lower in self._items:
                value = f"{self._items[lower][1]}, {value}"
            self._items[lower] = (key, value)

    def __getitem__(self, key: str) -> str:
        return self._items[key.lower()][1]

    def __iter__(self) -> Iterator[str]:
        return (original for original, _ in self._items.values())

    def __len__(self) -> int:
        return len(self._items)

    def __contains__(self, key: object) -> bool:
        return isinstance(key, str) and key.lower() in self._items

    def __repr__(self) -> str:
        return f"HttpHeaders({dict(self.items())!r})"


class HttpResponse:
    """``status``, ``reason``, ``headers``, ``content`` (bytes), ``text``, ``json`` (parsed or ``None``), ``ok``, ``url``."""

    def __init__(self, method: str, url: str, status: int, reason: str, headers: HttpHeaders, content: bytes, elapsed_ms: float) -> None:
        self.method = method
        self.url = url
        self.status = status
        self.reason = reason
        self.headers = headers
        self.content = content
        self.elapsed_ms = elapsed_ms
        self._json: Any = _UNPARSED

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    @property
    def text(self) -> str:
        charset = "utf-8"
        for part in self.headers.get("Content-Type", "").split(";")[1:]:
            key, _, value = part.strip().partition("=")
            if key.lower() == "charset" and value:
                charset = value.strip('"')
        try:
            return self.content.decode(charset, errors="replace")
        except LookupError:
            return self.content.decode("utf-8", errors="replace")

    @property
    def json(self) -> Any:
        """The body parsed as JSON, or ``None`` when it is empty or not JSON."""
        if self._json is _UNPARSED:
            try:
                self._json = _json.loads(self.text) if self.content.strip() else None
            except ValueError:
                self._json = None
        return self._json

    def raise_for_status(self) -> "HttpResponse":
        """Raise ``HttpError`` (a ``NodeOperationError``) for a 4xx/5xx status."""
        if self.status >= 400:
            raise HttpError.from_response(self)
        return self

    def __repr__(self) -> str:
        return f"<HttpResponse {self.status} {self.method} {_safe_url(self.url)}>"


_UNPARSED = object()


class HttpError(NodeOperationError):
    """An HTTP call failed: a network error (``status is None``) or ``raise_for_status()`` on 4xx/5xx."""

    def __init__(self, message: str, description: str | None = None, status: int | None = None, response: HttpResponse | None = None):
        super().__init__(message, description=description)
        self.status = status
        self.response = response

    @classmethod
    def from_response(cls, response: HttpResponse) -> "HttpError":
        detail = None
        body = response.json
        if isinstance(body, dict):
            for key in ("message", "error_description", "error", "detail", "description"):
                if isinstance(body.get(key), str) and body[key]:
                    detail = body[key]
                    break
        if detail is None and response.content:
            detail = response.text.strip()[:300] or None
        host = urllib.parse.urlsplit(response.url).hostname or response.url
        message = f"HTTP {response.status}{' ' + response.reason if response.reason else ''} from {host}"
        return cls(message, description=redact_text(detail) if detail else None, status=response.status, response=response)


def _safe_url(url: str) -> str:
    """``url.full`` without userinfo, query string or fragment."""
    parts = urllib.parse.urlsplit(url)
    netloc = parts.hostname or ""
    if ":" in netloc:
        netloc = f"[{netloc}]"
    if parts.port:
        netloc += f":{parts.port}"
    return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, "", ""))


def _is_loopback(host: str) -> bool:
    return host in ("localhost", "127.0.0.1", "::1") or host.startswith("127.")


class HttpClient:
    """``request(method, url, headers=, json=, data=, params=, timeout=, verify=)`` plus ``get/post/put/patch/delete/head``."""

    def __init__(self, telemetry: Any, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        self._telemetry = telemetry
        self.timeout = timeout
        self._direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self._proxied = urllib.request.build_opener()
        self._unverified: tuple[urllib.request.OpenerDirector, urllib.request.OpenerDirector] | None = None

    def _openers(self, verify: bool) -> tuple[urllib.request.OpenerDirector, urllib.request.OpenerDirector]:
        """(direct, proxied) openers; ``verify=False`` skips TLS certificate checks (n8n's "Ignore SSL Issues")."""
        if verify:
            return self._direct, self._proxied
        if self._unverified is None:
            insecure = ssl.create_default_context()
            insecure.check_hostname = False
            insecure.verify_mode = ssl.CERT_NONE
            https = urllib.request.HTTPSHandler(context=insecure)
            self._unverified = (
                urllib.request.build_opener(urllib.request.ProxyHandler({}), https),
                urllib.request.build_opener(https),
            )
        return self._unverified

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        json: Any = None,
        data: Any = None,
        params: Mapping[str, Any] | list[tuple[str, Any]] | None = None,
        timeout: float | None = None,
        verify: bool = True,
    ) -> HttpResponse:
        """Send a request; ``json=`` sends a JSON body, ``data=`` bytes/str, a binary file object or a dict (form-encoded),
        ``params=`` is appended to the query string. ``verify=False`` accepts any TLS certificate."""
        method = method.upper()
        if params:
            query = urllib.parse.urlencode(params, doseq=True)
            url += ("&" if urllib.parse.urlsplit(url).query else "?") + query
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in _DEFAULT_PORTS or not parts.hostname:
            raise ValueError(f"ctx.http needs an absolute http(s) URL, got {_safe_url(url)!r}")
        out_headers: MutableMapping[str, str] = {"User-Agent": USER_AGENT, "Accept": "application/json, text/plain, */*"}
        for key, value in (headers or {}).items():
            for existing in [k for k in out_headers if k.lower() == key.lower()]:
                del out_headers[existing]
            out_headers[key] = str(value)
        lower = {k.lower() for k in out_headers}
        body: Any = None
        if json is not None:
            body = _json.dumps(json, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if "content-type" not in lower:
                out_headers["Content-Type"] = "application/json; charset=utf-8"
        elif data is not None:
            if isinstance(data, (bytes, bytearray)):
                body = bytes(data)
            elif hasattr(data, "read"):  # a binary file object: streamed (chunked unless Content-Length is set)
                body = data
            elif isinstance(data, str):
                body = data.encode("utf-8")
            else:
                body = urllib.parse.urlencode(data, doseq=True).encode("utf-8")
                if "content-type" not in lower:
                    out_headers["Content-Type"] = "application/x-www-form-urlencoded"

        port = parts.port or _DEFAULT_PORTS[parts.scheme]
        attributes = {
            "http.request.method": method,
            "server.address": parts.hostname,
            "server.port": port,
            "url.full": _safe_url(url),
        }
        metric_attributes: dict[str, Any] = {"http.request.method": method, "server.address": parts.hostname, "server.port": port}
        telemetry = self._telemetry
        span = telemetry.start_span(f"HTTP {method}", kind="client", attributes=attributes)
        span.inject(out_headers)
        request = urllib.request.Request(url, data=body, headers=dict(out_headers), method=method)
        direct, proxied = self._openers(verify)
        opener = direct if _is_loopback(parts.hostname) else proxied
        started = time.perf_counter()
        try:
            with telemetry.use_span(span):
                try:
                    with opener.open(request, timeout=timeout if timeout is not None else self.timeout) as raw:
                        status, reason, final_url = raw.status, raw.reason or "", raw.geturl()
                        header_pairs, content = raw.headers.items(), raw.read()
                except urllib.error.HTTPError as exc:  # 4xx / 5xx: a response, not an exception
                    with exc:  # the error is also the open response: close it after reading
                        status, reason, final_url = exc.code, exc.reason or "", exc.geturl() or url
                        header_pairs, content = (exc.headers.items() if exc.headers else []), exc.read()
        except Exception as exc:  # noqa: BLE001 - network failure: record, then raise HttpError
            elapsed = time.perf_counter() - started
            reason_text = _failure_reason(exc)
            span.set_attribute("error.type", type(getattr(exc, "reason", exc)).__name__)
            span.record_exception(exc)
            span.set_status("error", reason_text)
            span.end()
            metric_attributes["error.type"] = type(getattr(exc, "reason", exc)).__name__
            telemetry.http_client_duration.record(elapsed, metric_attributes)
            raise HttpError(redact_text(f"{method} {_safe_url(url)} failed: {reason_text}")) from None
        elapsed = time.perf_counter() - started
        span.set_attribute("http.response.status_code", status)
        metric_attributes["http.response.status_code"] = status
        if status >= 400:
            span.set_attribute("error.type", str(status))
            span.set_status("error", f"HTTP {status}")
            metric_attributes["error.type"] = str(status)
        span.end()
        telemetry.http_client_duration.record(elapsed, metric_attributes)
        return HttpResponse(method, final_url, status, reason, HttpHeaders(header_pairs), content, elapsed * 1000)

    def get(self, url: str, **kwargs: Any) -> HttpResponse:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> HttpResponse:
        return self.request("POST", url, **kwargs)

    def put(self, url: str, **kwargs: Any) -> HttpResponse:
        return self.request("PUT", url, **kwargs)

    def patch(self, url: str, **kwargs: Any) -> HttpResponse:
        return self.request("PATCH", url, **kwargs)

    def delete(self, url: str, **kwargs: Any) -> HttpResponse:
        return self.request("DELETE", url, **kwargs)

    def head(self, url: str, **kwargs: Any) -> HttpResponse:
        return self.request("HEAD", url, **kwargs)


def _failure_reason(exc: BaseException) -> str:
    reason = getattr(exc, "reason", None)
    if isinstance(exc, (socket.timeout, TimeoutError)) or isinstance(reason, (socket.timeout, TimeoutError)):
        return "timed out"
    if reason is not None:
        return str(reason)
    return str(exc) or type(exc).__name__
