"""Binary data (files on items, docs/protocol.md §11): the MIME helpers and the client behind the ``ctx`` helpers.

An item carries files under ``item["binary"]``, keyed by a property name (``"data"`` for a single file). Each file
is a ref dict -- ``{"id", "mimeType", "fileName", "fileExtension", "fileSize", "fileType"}`` -- whose bytes live in
the host's binary store. Node code uses the context helpers::

    raw = ctx.get_binary_bytes(i, "data")                       # bytes of input item i's file
    ref = ctx.prepare_binary_data(csv_bytes, "report.csv")      # store bytes, get a ref
    out.append({"json": {"rows": n}, "binary": {"data": ref}})

Reading a stored ref calls ``GET {binaryAccess.url}/{id}``; storing calls ``POST {binaryAccess.url}``, both with
the per-execution bearer token the host sends in ``ExecuteRequest.binaryAccess``. Files up to
``MAX_INLINE_BINARY_BYTES`` are returned inline (base64 ``data``) instead of uploaded; the host stores them.
"""

from __future__ import annotations

import base64
import io
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, BinaryIO, Mapping

from .errors import NodeOperationError
from .http_client import USER_AGENT, HttpClient, HttpError, HttpHeaders, HttpResponse, _failure_reason, _is_loopback, _safe_url
from .redact import redact_text

MAX_INLINE_BINARY_BYTES = 64 * 1024
"""Files up to this size are returned inline (``BinaryRef.data``) instead of uploaded."""

DEFAULT_MIME_TYPE = "application/octet-stream"
FILE_NAME_HEADER = "X-Landflow-File-Name"
_CHUNK = 64 * 1024
_STREAM_TIMEOUT_SECONDS = 120.0

# The same table as packages/protocol/src/binary.ts, so every SDK guesses alike.
MIME_BY_EXTENSION: dict[str, str] = {
    "txt": "text/plain", "text": "text/plain", "log": "text/plain", "md": "text/markdown", "csv": "text/csv",
    "tsv": "text/tab-separated-values", "html": "text/html", "htm": "text/html", "css": "text/css",
    "xml": "application/xml", "json": "application/json", "ndjson": "application/x-ndjson", "yaml": "application/yaml",
    "yml": "application/yaml", "js": "text/javascript", "pdf": "application/pdf", "zip": "application/zip",
    "gz": "application/gzip", "tar": "application/x-tar",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xls": "application/vnd.ms-excel",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "ods": "application/vnd.oasis.opendocument.spreadsheet", "rtf": "application/rtf",
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
    "svg": "image/svg+xml", "bmp": "image/bmp", "ico": "image/x-icon", "tif": "image/tiff", "tiff": "image/tiff",
    "avif": "image/avif", "heic": "image/heic", "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg",
    "m4a": "audio/mp4", "flac": "audio/flac", "mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
    "avi": "video/x-msvideo", "mkv": "video/x-matroska", "eml": "message/rfc822", "ics": "text/calendar",
}

_EXTENSION_BY_MIME: dict[str, str] = {}
for _extension, _mime in MIME_BY_EXTENSION.items():
    _EXTENSION_BY_MIME.setdefault(_mime, _extension)
_EXTENSION_BY_MIME.update({"text/plain": "txt", "image/jpeg": "jpg", "text/html": "html"})


def base_mime_type(mime_type: str | None) -> str:
    """``"text/csv; charset=utf-8"`` -> ``"text/csv"``."""
    return str(mime_type or "").split(";")[0].strip().lower()


def file_extension_of(file_name: str | None) -> str | None:
    """``"report.PDF"`` -> ``"pdf"``; no extension -> ``None``."""
    base = str(file_name or "").replace("\\", "/").rsplit("/", 1)[-1]
    dot = base.rfind(".")
    return base[dot + 1:].lower() if 0 < dot < len(base) - 1 else None


def mime_type_from_file_name(file_name: str | None) -> str:
    """The MIME type for a file name (the protocol's table, then ``mimetypes``), else ``application/octet-stream``."""
    extension = file_extension_of(file_name)
    if not extension:
        return DEFAULT_MIME_TYPE
    if extension in MIME_BY_EXTENSION:
        return MIME_BY_EXTENSION[extension]
    import mimetypes

    return mimetypes.types_map.get(f".{extension}") or DEFAULT_MIME_TYPE


def extension_from_mime_type(mime_type: str | None) -> str | None:
    """``"image/png"`` -> ``"png"`` (parameters are ignored)."""
    return _EXTENSION_BY_MIME.get(base_mime_type(mime_type))


def file_type_of(mime_type: str | None) -> str:
    """n8n's coarse file type the UI previews by: image, audio, video, pdf, html, json, text or other."""
    mime = base_mime_type(mime_type)
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("audio/"):
        return "audio"
    if mime.startswith("video/"):
        return "video"
    if mime == "application/pdf":
        return "pdf"
    if mime == "text/html":
        return "html"
    if mime in ("application/json", "application/x-ndjson") or mime.endswith("+json"):
        return "json"
    if mime.startswith("text/") or mime in ("application/xml", "application/yaml", "application/javascript") or mime.endswith("+xml"):
        return "text"
    return "other"


def complete_binary_ref(ref: Mapping[str, Any]) -> dict[str, Any]:
    """A copy of ``ref`` with what it can derive filled in: MIME type from the file name, extension, file type."""
    out = dict(ref)
    mime = out.get("mimeType")
    if not mime or mime == DEFAULT_MIME_TYPE:
        mime = mime_type_from_file_name(out.get("fileName")) if out.get("fileName") else (mime or DEFAULT_MIME_TYPE)
    out["mimeType"] = mime
    extension = out.get("fileExtension") or file_extension_of(out.get("fileName")) or extension_from_mime_type(mime)
    if extension:
        out["fileExtension"] = extension
    out.setdefault("fileType", file_type_of(mime))
    return out


def _is_readable(data: Any) -> bool:
    return hasattr(data, "read") and not isinstance(data, (bytes, bytearray, memoryview, str))


def _remaining_length(stream: Any) -> int | None:
    """Bytes left in a seekable file-like object, else ``None`` (then it is sent chunked)."""
    try:
        if not stream.seekable():
            return None
        position = stream.tell()
        end = stream.seek(0, os.SEEK_END)
        stream.seek(position)
        return max(0, end - position)
    except (AttributeError, OSError, ValueError):
        return None


class BinaryClient:
    """Reads and stores file bytes for one Execute call (``ctx.read_binary``, ``ctx.prepare_binary_data``, ...).

    ``access`` is the request's ``binaryAccess`` (``{"url", "token"}``) or ``None`` (an older host: only inline
    files then). ``http`` is the traced client used for the calls.
    """

    def __init__(self, access: Mapping[str, Any] | None, http: HttpClient) -> None:
        url = access.get("url") if isinstance(access, Mapping) else None
        self.url: str | None = str(url).rstrip("/") if url else None
        self.token: str = str(access.get("token") or "") if isinstance(access, Mapping) else ""
        self._http = http

    def _headers(self, extra: Mapping[str, str] | None = None) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self.token}"}
        headers.update(extra or {})
        return headers

    def _require_access(self, what: str) -> str:
        if not self.url:
            raise NodeOperationError(
                f"Cannot {what}: the host sent no binaryAccess",
                description="This host has no binary store (or is older than binary data support). Only inline files up to "
                f"{MAX_INLINE_BINARY_BYTES // 1024} KiB work here.",
            )
        return self.url

    @staticmethod
    def _check(response: HttpResponse, what: str) -> HttpResponse:
        if response.status >= 400:
            failure = HttpError.from_response(response)
            raise HttpError(f"Could not {what}: {failure.message}", description=failure.description, status=response.status, response=response)
        return response

    # ---------------------------------------------------------------- reading

    def read(self, ref: Mapping[str, Any]) -> bytes:
        """The bytes of a ref: inline ``data`` is decoded, a stored ``id`` is fetched from the host."""
        inline = ref.get("data")
        if isinstance(inline, str) and not ref.get("id"):
            return _decode(inline)
        file_id = _ref_id(ref)
        url = f"{self._require_access(f'read binary file {file_id}')}/{urllib.parse.quote(file_id, safe='')}"
        response = self._http.get(url, headers=self._headers({"Accept": "*/*"}), timeout=_STREAM_TIMEOUT_SECONDS)
        return self._check(response, f"read binary file {file_id}").content

    def open(self, ref: Mapping[str, Any]) -> BinaryIO:
        """A file-like object over the bytes of a ref (call ``.close()``, or use it in ``with``)."""
        inline = ref.get("data")
        if isinstance(inline, str) and not ref.get("id"):
            return io.BytesIO(_decode(inline))
        file_id = _ref_id(ref)
        url = f"{self._require_access(f'read binary file {file_id}')}/{urllib.parse.quote(file_id, safe='')}"
        return self._open_stream(url, file_id)

    def _open_stream(self, url: str, file_id: str) -> BinaryIO:
        """GET without reading the body: a client span for the request, the open response returned to the caller."""
        telemetry = self._http._telemetry
        parts = urllib.parse.urlsplit(url)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        span = telemetry.start_span(
            "HTTP GET", kind="client",
            attributes={"http.request.method": "GET", "server.address": parts.hostname, "server.port": port, "url.full": _safe_url(url)},
        )
        headers = self._headers({"Accept": "*/*", "User-Agent": USER_AGENT})
        span.inject(headers)
        direct, proxied = self._http._openers(True)
        opener = direct if _is_loopback(parts.hostname or "") else proxied
        metric = {"http.request.method": "GET", "server.address": parts.hostname, "server.port": port}
        started = time.perf_counter()
        try:
            with telemetry.use_span(span):
                raw = opener.open(urllib.request.Request(url, headers=headers, method="GET"), timeout=_STREAM_TIMEOUT_SECONDS)
        except urllib.error.HTTPError as exc:
            with exc:
                response = HttpResponse("GET", url, exc.code, exc.reason or "", HttpHeaders(exc.headers.items() if exc.headers else []), exc.read(), 0)
            span.set_attribute("http.response.status_code", exc.code)
            span.set_status("error", f"HTTP {exc.code}")
            span.end()
            telemetry.http_client_duration.record(time.perf_counter() - started, {**metric, "http.response.status_code": exc.code, "error.type": str(exc.code)})
            self._check(response, f"read binary file {file_id}")
            raise  # unreachable: _check raises for every 4xx/5xx
        except Exception as exc:  # noqa: BLE001 - network failure
            reason = _failure_reason(exc)
            span.record_exception(exc)
            span.set_status("error", reason)
            span.end()
            telemetry.http_client_duration.record(time.perf_counter() - started, {**metric, "error.type": type(exc).__name__})
            raise HttpError(redact_text(f"Could not read binary file {file_id}: GET {_safe_url(url)} failed: {reason}")) from None
        span.set_attribute("http.response.status_code", raw.status)
        span.end()
        telemetry.http_client_duration.record(time.perf_counter() - started, {**metric, "http.response.status_code": raw.status})
        return raw

    # ---------------------------------------------------------------- storing

    def prepare(self, data: Any, file_name: str | None = None, mime_type: str | None = None) -> dict[str, Any]:
        """Store ``data`` (bytes, str as UTF-8, or a binary file-like object) and return its ref.

        Up to ``MAX_INLINE_BINARY_BYTES`` the ref carries the bytes inline (no request); bigger files and
        file-like objects (when the host sent ``binaryAccess``) are uploaded with ``POST {url}``.
        """
        mime = mime_type or (mime_type_from_file_name(file_name) if file_name else DEFAULT_MIME_TYPE)
        if _is_readable(data):
            if self.url:
                return self._upload(data, file_name, mime, _remaining_length(data))
            head = data.read(MAX_INLINE_BINARY_BYTES + 1)
            if not isinstance(head, (bytes, bytearray)):
                raise TypeError("prepare_binary_data() needs a binary file object (opened with 'rb')")
            data = bytes(head)
            if len(data) > MAX_INLINE_BINARY_BYTES:
                self._require_access(f"store {file_name or 'a file'} (over {MAX_INLINE_BINARY_BYTES // 1024} KiB)")
        elif isinstance(data, str):
            data = data.encode("utf-8")
        elif isinstance(data, (bytearray, memoryview)):
            data = bytes(data)
        elif not isinstance(data, bytes):
            raise TypeError(f"prepare_binary_data() takes bytes, str or a binary file object, not {type(data).__name__}")
        if len(data) <= MAX_INLINE_BINARY_BYTES:
            ref: dict[str, Any] = {"mimeType": mime, "fileSize": len(data), "data": base64.b64encode(data).decode("ascii")}
            if file_name:
                ref["fileName"] = file_name
            return complete_binary_ref(ref)
        self._require_access(f"store {file_name or 'a file'} ({len(data)} bytes)")
        return self._upload(data, file_name, mime, len(data))

    def _upload(self, body: Any, file_name: str | None, mime: str, length: int | None) -> dict[str, Any]:
        url = self._require_access(f"store {file_name or 'a file'}")
        headers = {"Content-Type": mime, "Accept": "application/json"}
        if file_name:
            headers[FILE_NAME_HEADER] = urllib.parse.quote(file_name, safe="")
        if length is not None:
            headers["Content-Length"] = str(length)
        response = self._http.post(url, headers=self._headers(headers), data=body, timeout=_STREAM_TIMEOUT_SECONDS)
        self._check(response, f"store {file_name or 'a file'}")
        ref = response.json
        if not isinstance(ref, dict) or not ref.get("id"):
            raise NodeOperationError(f"Could not store {file_name or 'a file'}: the host answered without a binary ref")
        return ref


def _decode(data: str) -> bytes:
    try:
        return base64.b64decode(data, validate=False)
    except ValueError as exc:
        raise NodeOperationError(f"Inline binary data is not valid base64 ({exc})") from None


def _ref_id(ref: Mapping[str, Any]) -> str:
    file_id = ref.get("id")
    if not isinstance(file_id, str) or not file_id:
        raise NodeOperationError("This binary ref has neither an id nor inline data")
    return file_id
