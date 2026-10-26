"""The claim check (docs/protocol.md §14.6 "Size"): an event whose headers and body do not fit the broker's limits goes by
reference. The sender writes the already-encrypted body to a shared object store (S3-compatible; MinIO in dev) under a
fresh key, publishes the event with an empty body plus ``lfclaim`` / ``lfclaimsize`` / ``lfclaimsha256`` (signed like every
other attribute), and the receiver fetches, checks size and digest, and carries on as usual. The store only ever sees
ciphertext. The counterpart of ``packages/transports/src/claim.ts`` and ``sdks/go/transport/claim.go``.

- ``ClaimStore`` is the small interface; ``MemoryClaimStore`` is for tests, ``S3ClaimStore`` (standard library only: AWS
  Signature V4 over ``urllib``) for S3-compatible buckets.
- ``claim_store_from_env()`` reads one setting, ``LANDFLOW_CLAIM_STORE=s3://<bucket>/<prefix>?endpoint=…&region=…&forcePathStyle=true``
  (or ``memory://``), with credentials in ``LANDFLOW_CLAIM_ACCESS_KEY_ID`` / ``LANDFLOW_CLAIM_SECRET_ACCESS_KEY`` (falling back to
  ``AWS_ACCESS_KEY_ID`` / ``AWS_SECRET_ACCESS_KEY`` / ``AWS_SESSION_TOKEN``). An S3 store refuses to start without an explicit
  endpoint unless the URL says ``aws=true``.
- Without static keys the in-cluster credential chain runs (see ``resolve_claim_credentials``): web identity (EKS IRSA), then
  container credentials (EKS Pod Identity, ECS). No ``~/.aws`` files and no EC2 IMDS, on purpose.
- Lifetime: the receiver deletes the object once it has acknowledged the event; a sender deletes the request object of a call
  that failed; the key is ``claims/<epoch ms, 13 digits>/<event id>``, so ``sweep_claims`` (run by the client and the server
  every 10 min) deletes whatever is older than the TTL (default 1 h) after a crash.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Protocol

CLAIM_KEY_PREFIX = "claims/"
DEFAULT_CLAIM_TTL_MS = 3_600_000
CLAIM_SWEEP_INTERVAL_MS = 600_000
CLAIM_KEY_RE = re.compile(r"^claims/\d{13}/[A-Za-z0-9._-]{1,128}$")
_ID_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")


class ClaimStore(Protocol):
    kind: str

    def put(self, key: str, body: bytes) -> None: ...

    def get(self, key: str) -> bytes | None:
        """``None`` when the object does not exist (expired or deleted)."""

    def delete(self, key: str) -> None:
        """Idempotent: deleting a missing object is not an error."""

    def list(self, prefix: str) -> list[str]:
        """Keys (relative to the store's prefix) starting with ``prefix``."""


class ClaimError(Exception):
    """The claim could not be written, fetched or verified. ``reason``: ``store``, ``missing``, ``size``, ``digest`` or ``invalid``."""

    def __init__(self, message: str, reason: str) -> None:
        super().__init__(message)
        self.reason = reason


def claim_key_for(now_ms: int, event_id: str) -> str:
    return f"{CLAIM_KEY_PREFIX}{now_ms:013d}/{_ID_UNSAFE.sub('_', event_id)[:128]}"


def claim_key_time(key: str) -> int | None:
    return int(key[len(CLAIM_KEY_PREFIX) : len(CLAIM_KEY_PREFIX) + 13]) if CLAIM_KEY_RE.match(key) else None


def sha256_hex(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


class MemoryClaimStore:
    """In-process store for tests. ``counters`` counts calls; ``keys()`` lists what is stored now."""

    kind = "memory"

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.counters = {"puts": 0, "gets": 0, "deletes": 0}
        #: ``"put"`` or ``"get"``: make the next such call fail, to exercise store outages.
        self.fail_next: str | None = None
        self._lock = threading.Lock()

    def put(self, key: str, body: bytes) -> None:
        with self._lock:
            if self.fail_next == "put":
                self.fail_next = None
                raise RuntimeError("memory claim store: put failed")
            self.counters["puts"] += 1
            self.objects[key] = bytes(body)

    def get(self, key: str) -> bytes | None:
        with self._lock:
            if self.fail_next == "get":
                self.fail_next = None
                raise RuntimeError("memory claim store: get failed")
            self.counters["gets"] += 1
            return self.objects.get(key)

    def delete(self, key: str) -> None:
        with self._lock:
            self.counters["deletes"] += 1
            self.objects.pop(key, None)

    def list(self, prefix: str) -> list[str]:
        with self._lock:
            return sorted(k for k in self.objects if k.startswith(prefix))

    def keys(self) -> list[str]:
        return self.list("")


def _escape_path(path: str) -> str:
    return urllib.parse.quote(path, safe="/-_.~")


def _escape_query(value: str) -> str:
    return urllib.parse.quote(value, safe="-_.~")


# --- credentials -------------------------------------------------------------------------------------------------------------
#
# The chain, in order:
#   1. static keys: LANDFLOW_CLAIM_ACCESS_KEY_ID / LANDFLOW_CLAIM_SECRET_ACCESS_KEY, then AWS_ACCESS_KEY_ID /
#      AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN;
#   2. web identity (EKS IRSA): AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN (+ AWS_ROLE_SESSION_NAME) exchanged at STS
#      AssumeRoleWithWebIdentity (an unsigned form POST). The token file is re-read on every refresh, it rotates. STS endpoint:
#      AWS_ENDPOINT_URL_STS, else AWS_ENDPOINT_URL, else the regional https://sts.<region>.amazonaws.com, and that last one only
#      when the store URL says aws=true (nothing talks to real AWS unless the operator says so);
#   3. container credentials (EKS Pod Identity, ECS): AWS_CONTAINER_CREDENTIALS_FULL_URI, or AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
#      against http://169.254.170.2, with the Authorization header from AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE (re-read each
#      time) or AWS_CONTAINER_AUTHORIZATION_TOKEN. A FULL_URI over plain http must name loopback, 169.254.170.2, 169.254.170.23 or
#      fd00:ec2::23 (as the AWS SDKs require); https is allowed for any host.
#
# Deliberately NOT supported: the shared credentials/config files (~/.aws) and EC2 IMDS. A developer laptop has real ~/.aws
# credentials that must never be picked up by a dev run; IMDS probes time out off EC2; an operator who needs either can export the
# keys. Temporary credentials are cached and refreshed 5 minutes before Expiration, under a lock. The transport runs on threads,
# not asyncio, so a blocking refresh under a ``threading.Lock`` is the right shape here.

CREDENTIAL_REFRESH_MARGIN_S = 300.0
#: Resolves ``AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`` (a module variable so tests can point it at a fake).
CONTAINER_RELATIVE_BASE = "http://169.254.170.2"
_CONTAINER_HOSTS = {ipaddress.ip_address(a) for a in ("169.254.170.2", "169.254.170.23", "fd00:ec2::23")}
CREDENTIAL_SOURCES = (
    "LANDFLOW_CLAIM_ACCESS_KEY_ID + LANDFLOW_CLAIM_SECRET_ACCESS_KEY, AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN), "
    "AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN (EKS IRSA), AWS_CONTAINER_CREDENTIALS_FULL_URI or AWS_CONTAINER_CREDENTIALS_RELATIVE_URI (EKS Pod Identity, ECS)"
)


@dataclass(frozen=True)
class ClaimCredentials:
    access_key_id: str
    secret_access_key: str
    session_token: str = ""
    #: Epoch seconds; ``None`` for static keys.
    expires: float | None = None


class CredentialProvider(Protocol):
    #: Where the credentials come from (``static keys``, ``web identity``, ``container credentials``); never a secret.
    source: str

    def retrieve(self) -> ClaimCredentials: ...


class StaticCredentials:
    source = "static keys"

    def __init__(self, access_key_id: str, secret_access_key: str, session_token: str = "") -> None:
        self._creds = ClaimCredentials(access_key_id, secret_access_key, session_token)

    def retrieve(self) -> ClaimCredentials:
        return self._creds


class CachedCredentials:
    """Caches a temporary-credential source and refreshes it 5 minutes before ``expires``. Thread safe: one refresh at a time,
    the other callers wait for it. A failed refresh keeps serving a set that has not truly expired yet."""

    def __init__(self, inner: CredentialProvider, clock: Callable[[], float] = time.time) -> None:
        self._inner, self._clock = inner, clock
        self.source = inner.source
        self._lock = threading.Lock()
        self._creds: ClaimCredentials | None = None

    def retrieve(self) -> ClaimCredentials:
        with self._lock:
            now, held = self._clock(), self._creds
            if held is not None and held.expires is not None and now + CREDENTIAL_REFRESH_MARGIN_S < held.expires:
                return held
            try:
                self._creds = self._inner.retrieve()
            except Exception:
                if held is not None and held.expires is not None and now < held.expires:
                    return held
                raise
            return self._creds


def _read_response(request: urllib.request.Request, what: str, timeout: float) -> bytes:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - the endpoint is operator configuration
            return response.read(1 << 20)
    except urllib.error.HTTPError as error:
        try:
            raise RuntimeError(f"{what}: HTTP {error.code}: {error.read(512).decode('utf-8', 'replace').strip()}") from None
        finally:
            error.close()
    except (urllib.error.URLError, OSError) as error:
        raise RuntimeError(f"{what}: {error}") from error


def _parse_expiration(source: str, value: str | None) -> float:
    try:
        return datetime.fromisoformat((value or "").strip().replace("Z", "+00:00")).timestamp()
    except ValueError:
        raise RuntimeError(f"{source}: the response has no valid Expiration ({value!r})") from None


class WebIdentityCredentials:
    """STS ``AssumeRoleWithWebIdentity`` with the token file's current contents."""

    source = "web identity"

    def __init__(self, token_file: str, role_arn: str, session_name: str, endpoint: str, timeout: float = 15.0) -> None:
        self.token_file, self.role_arn, self.session_name, self.endpoint, self.timeout = token_file, role_arn, session_name, endpoint, timeout

    def retrieve(self) -> ClaimCredentials:
        try:
            with open(self.token_file, encoding="utf-8") as handle:
                token = handle.read().strip()
        except OSError as error:
            raise RuntimeError(f"web identity: read AWS_WEB_IDENTITY_TOKEN_FILE: {error}") from error
        form = urllib.parse.urlencode(
            {"Action": "AssumeRoleWithWebIdentity", "Version": "2011-06-15", "RoleArn": self.role_arn, "RoleSessionName": self.session_name, "WebIdentityToken": token}
        )
        request = urllib.request.Request(self.endpoint, data=form.encode(), method="POST")
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
        request.add_header("Accept", "application/xml")
        body = _read_response(request, f"web identity: STS {self.endpoint}", self.timeout)
        try:
            root = ET.fromstring(body)
        except ET.ParseError as error:
            raise RuntimeError(f"web identity: STS answered something that is not XML: {error}") from error
        found = {}
        for element in root.iter():
            name = element.tag.rsplit("}", 1)[-1]
            if name in ("AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration") and name not in found:
                found[name] = (element.text or "").strip()
        if not found.get("AccessKeyId") or not found.get("SecretAccessKey"):
            raise RuntimeError("web identity: the response carries no access key")
        return ClaimCredentials(found["AccessKeyId"], found["SecretAccessKey"], found.get("SessionToken", ""), _parse_expiration("web identity", found.get("Expiration")))


class ContainerCredentials:
    """The ECS / EKS Pod Identity credentials endpoint."""

    source = "container credentials"

    def __init__(self, uri: str, token_file: str = "", token: str = "", timeout: float = 15.0) -> None:
        self.uri, self.token_file, self.token, self.timeout = uri, token_file, token, timeout

    def retrieve(self) -> ClaimCredentials:
        auth = self.token
        if self.token_file:
            try:
                with open(self.token_file, encoding="utf-8") as handle:
                    auth = handle.read().strip()
            except OSError as error:
                raise RuntimeError(f"container credentials: read AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: {error}") from error
        request = urllib.request.Request(self.uri, method="GET")
        request.add_header("Accept", "application/json")
        if auth:
            request.add_header("Authorization", auth)
        body = _read_response(request, f"container credentials: {self.uri}", self.timeout)
        try:
            doc = json.loads(body)
            key, secret = doc["AccessKeyId"], doc["SecretAccessKey"]
        except (ValueError, KeyError, TypeError) as error:
            raise RuntimeError("container credentials: the response is not the expected JSON (AccessKeyId, SecretAccessKey, Token, Expiration)") from error
        return ClaimCredentials(key, secret, doc.get("Token") or "", _parse_expiration("container credentials", doc.get("Expiration")))


def _container_host_allowed(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address in _CONTAINER_HOSTS


def resolve_claim_credentials(env: dict[str, str] | None = None, region: str = "us-east-1", allow_aws: bool = False, clock: Callable[[], float] = time.time) -> CredentialProvider:
    """Walk the chain described above. Does no network I/O: the temporary sources fetch on first use. Raises ``ValueError``."""
    env = os.environ if env is None else env

    def first(*names: str) -> str:
        return next((env[n] for n in names if env.get(n)), "")

    key, secret = first("LANDFLOW_CLAIM_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"), first("LANDFLOW_CLAIM_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY")
    if key and secret:
        return StaticCredentials(key, secret, env.get("AWS_SESSION_TOKEN", ""))
    token_file, role = env.get("AWS_WEB_IDENTITY_TOKEN_FILE", ""), env.get("AWS_ROLE_ARN", "")
    if token_file and role:
        endpoint = first("AWS_ENDPOINT_URL_STS", "AWS_ENDPOINT_URL")
        if not endpoint:
            if not allow_aws:
                raise ValueError(
                    "claim store: web identity credentials (AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN) need an STS endpoint: set AWS_ENDPOINT_URL_STS "
                    "(or AWS_ENDPOINT_URL), or add ?aws=true to LANDFLOW_CLAIM_STORE to use the real AWS STS"
                )
            endpoint = f"https://sts.{region}.amazonaws.com"
        return CachedCredentials(WebIdentityCredentials(token_file, role, env.get("AWS_ROLE_SESSION_NAME") or "landflow-claim", endpoint), clock)
    full, relative = env.get("AWS_CONTAINER_CREDENTIALS_FULL_URI", ""), env.get("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "")
    if full or relative:
        if not full and not relative.startswith("/"):
            raise ValueError("claim store: AWS_CONTAINER_CREDENTIALS_RELATIVE_URI must start with /")
        uri = full or CONTAINER_RELATIVE_BASE + relative
        parsed = urllib.parse.urlparse(uri)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("claim store: AWS_CONTAINER_CREDENTIALS_FULL_URI is not an http(s) URL")
        if parsed.scheme == "http" and full and not _container_host_allowed(parsed.hostname):
            raise ValueError(
                f"claim store: AWS_CONTAINER_CREDENTIALS_FULL_URI over plain http must name loopback, 169.254.170.2, 169.254.170.23 or fd00:ec2::23, not {parsed.hostname!r} (use https)"
            )
        return CachedCredentials(ContainerCredentials(uri, env.get("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", ""), env.get("AWS_CONTAINER_AUTHORIZATION_TOKEN", "")), clock)
    raise ValueError(
        "claim store: no credentials found; tried, in order: " + CREDENTIAL_SOURCES
        + ". The shared credentials/config files (~/.aws) and EC2 IMDS are deliberately not read; export the keys if you need them"
    )


class S3ClaimStore:
    """An S3-compatible claim store (MinIO, LocalStack, S3) over ``urllib`` with AWS Signature V4, so the SDK
    takes no AWS dependency. Path-style addressing by default (what MinIO needs). Credentials: static keys, or ``credentials`` (a
    ``CredentialProvider``), or the in-cluster chain of ``resolve_claim_credentials`` run over ``env`` (web identity, container
    credentials); never ``~/.aws`` files or EC2 IMDS."""

    kind = "s3"

    def __init__(
        self,
        bucket: str,
        *,
        prefix: str = "",
        endpoint: str | None = None,
        region: str = "us-east-1",
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
        session_token: str | None = None,
        credentials: CredentialProvider | None = None,
        env: dict[str, str] | None = None,
        force_path_style: bool = True,
        allow_aws: bool = False,
        timeout: float = 60.0,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if not bucket:
            raise ValueError("claim store: the bucket is empty")
        if not endpoint and not allow_aws:
            raise ValueError("claim store: refusing to use the default (AWS) endpoint; set ?endpoint=… (MinIO, LocalStack) or ?aws=true if you mean the real S3")
        self.region = region or "us-east-1"
        self._now = now or (lambda: datetime.now(timezone.utc))
        if access_key_id and secret_access_key:
            credentials = StaticCredentials(access_key_id, secret_access_key, session_token or "")
        elif credentials is None:
            credentials = resolve_claim_credentials(env, self.region, allow_aws, lambda: self._now().timestamp())
        self._credentials = credentials
        self.bucket = bucket
        self.prefix = prefix if not prefix or prefix.endswith("/") else prefix + "/"
        self.force_path_style = force_path_style
        self.timeout = timeout
        parsed = urllib.parse.urlparse(endpoint or f"https://s3.{self.region}.amazonaws.com")
        if not parsed.netloc:
            raise ValueError(f"claim store: endpoint {endpoint!r} is not a URL")
        self._scheme = parsed.scheme
        self._host = parsed.netloc
        self._base_path = parsed.path.rstrip("/")

    @property
    def credential_source(self) -> str:
        """Where the credentials come from (``static keys``, ``web identity``, ``container credentials``), no secrets."""
        return self._credentials.source

    def _request(self, method: str, key: str, query: dict[str, str] | None = None, body: bytes = b"") -> tuple[int, bytes]:
        creds = self._credentials.retrieve()
        segment = "/" + self.prefix + key if key else ""
        if self.force_path_style:
            host, path = self._host, f"{self._base_path}/{self.bucket}{segment}"
        else:
            host, path = f"{self.bucket}.{self._host}", f"{self._base_path}{segment}" or "/"
        canonical_uri = _escape_path(path or "/")
        canonical_query = "&".join(sorted(f"{_escape_query(k)}={_escape_query(v)}" for k, v in (query or {}).items()))
        now = self._now().astimezone(timezone.utc)
        amz_date, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
        payload_hash = sha256_hex(body)
        headers = {"host": host, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date}
        if creds.session_token:
            headers["x-amz-security-token"] = creds.session_token
        names = sorted(headers)
        signed_headers = ";".join(names)
        canonical = "\n".join([method, canonical_uri, canonical_query, "".join(f"{n}:{headers[n].strip()}\n" for n in names), signed_headers, payload_hash])
        scope = f"{day}/{self.region}/s3/aws4_request"
        to_sign = "AWS4-HMAC-SHA256\n" + amz_date + "\n" + scope + "\n" + sha256_hex(canonical.encode())

        def mac(key: bytes, data: str) -> bytes:
            return hmac.new(key, data.encode(), hashlib.sha256).digest()

        signing_key = mac(mac(mac(mac(("AWS4" + creds.secret_access_key).encode(), day), self.region), "s3"), "aws4_request")
        signature = hmac.new(signing_key, to_sign.encode(), hashlib.sha256).hexdigest()
        url = f"{self._scheme}://{host}{canonical_uri}" + (f"?{canonical_query}" if canonical_query else "")
        request = urllib.request.Request(url, data=body if method == "PUT" else None, method=method)
        for name, value in headers.items():
            if name != "host":
                request.add_header(name, value)
        request.add_header("Authorization", f"AWS4-HMAC-SHA256 Credential={creds.access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}")
        if method == "PUT":
            request.add_header("Content-Type", "application/octet-stream")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:  # noqa: S310 - the endpoint is operator configuration
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            try:
                return error.code, error.read()
            finally:
                error.close()

    def _check(self, op: str, status: int, data: bytes) -> None:
        if status // 100 != 2:
            raise RuntimeError(f"s3 {op}: HTTP {status}: {data[:512].decode('utf-8', 'replace').strip()}")

    def put(self, key: str, body: bytes) -> None:
        self._check("put", *self._request("PUT", key, body=body))

    def get(self, key: str) -> bytes | None:
        status, data = self._request("GET", key)
        if status == 404:
            return None
        self._check("get", status, data)
        return data

    def delete(self, key: str) -> None:
        status, data = self._request("DELETE", key)
        if status != 404:
            self._check("delete", status, data)

    def list(self, prefix: str) -> list[str]:
        keys: list[str] = []
        token: str | None = None
        while True:
            query = {"list-type": "2", "prefix": self.prefix + prefix}
            if token:
                query["continuation-token"] = token
            status, data = self._request("GET", "", query)
            self._check("list", status, data)
            root = ET.fromstring(data)
            ns = root.tag[: root.tag.index("}") + 1] if root.tag.startswith("{") else ""
            for contents in root.findall(f"{ns}Contents"):
                key = contents.findtext(f"{ns}Key") or ""
                keys.append(key[len(self.prefix) :] if key.startswith(self.prefix) else key)
            if (root.findtext(f"{ns}IsTruncated") or "") != "true":
                return keys
            token = root.findtext(f"{ns}NextContinuationToken")
            if not token:
                return keys


@dataclass
class ClaimSetting:
    store: ClaimStore
    ttl_ms: int
    #: The setting without credentials, for display.
    describe: str


def parse_claim_store(value: str, env: dict[str, str] | None = None) -> ClaimSetting:
    """Parse a ``LANDFLOW_CLAIM_STORE`` value. Raises ``ValueError`` on a malformed or unsafe one."""
    env = os.environ if env is None else env
    parsed = urllib.parse.urlparse(value)
    if not parsed.scheme:
        raise ValueError(f'LANDFLOW_CLAIM_STORE "{value}" is not a URL (expected s3://<bucket>/<prefix>?endpoint=…)')
    query = {k: v[-1] for k, v in urllib.parse.parse_qs(parsed.query).items()}
    ttl_ms = DEFAULT_CLAIM_TTL_MS
    if query.get("ttl"):
        try:
            ttl_ms = int(float(query["ttl"]) * 1000)
        except ValueError:
            ttl_ms = 0
        if ttl_ms <= 0:
            raise ValueError("LANDFLOW_CLAIM_STORE: ttl must be a positive number of seconds")
    if parsed.scheme == "memory":
        return ClaimSetting(MemoryClaimStore(), ttl_ms, "memory (in this process only)")
    if parsed.scheme != "s3":
        raise ValueError(f'LANDFLOW_CLAIM_STORE: scheme "{parsed.scheme}" is not supported (s3: or memory:)')
    prefix = urllib.parse.unquote(parsed.path.lstrip("/"))
    store = S3ClaimStore(
        urllib.parse.unquote(parsed.netloc),
        prefix=prefix,
        endpoint=query.get("endpoint") or None,
        region=query.get("region") or "us-east-1",
        force_path_style=query.get("forcePathStyle") != "false",
        allow_aws=query.get("aws") == "true",
        env=env,
    )
    endpoint = query.get("endpoint")
    return ClaimSetting(store, ttl_ms, f"s3://{parsed.netloc}/{prefix}" + (f" @ {endpoint}" if endpoint else "") + f" (credentials: {store.credential_source})")


def claim_store_from_env(env: dict[str, str] | None = None) -> ClaimSetting | None:
    """The store ``LANDFLOW_CLAIM_STORE`` configures, or ``None`` when it is unset."""
    value = (os.environ if env is None else env).get("LANDFLOW_CLAIM_STORE", "").strip()
    return parse_claim_store(value, env) if value else None


def sweep_claims(store: ClaimStore, ttl_ms: int, now_ms: int) -> int:
    """Delete the claims older than ``ttl_ms`` (the key carries the time). Returns how many it deleted."""
    deleted = 0
    for key in store.list(CLAIM_KEY_PREFIX):
        at = claim_key_time(key)
        if at is not None and at < now_ms - ttl_ms:
            store.delete(key)
            deleted += 1
    return deleted


def start_claim_sweeper(store: ClaimStore, ttl_ms: int, stop: threading.Event, on_error: Callable[[Exception], None], now: Callable[[], int], interval_ms: int = CLAIM_SWEEP_INTERVAL_MS) -> threading.Thread:
    """Sweep now and then until ``stop`` is set."""

    def loop() -> None:
        while not stop.wait(interval_ms / 1000):
            try:
                sweep_claims(store, ttl_ms, now())
            except Exception as exc:  # noqa: BLE001
                on_error(exc)

    thread = threading.Thread(target=loop, name="landflow-claim-sweeper", daemon=True)
    thread.start()
    return thread
