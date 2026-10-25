"""Self-announcement to the Landflow host registry (push discovery + heartbeat)."""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Protocol

from .protocol import (
    ANNOUNCE_PATH,
    DEFAULT_ANNOUNCE_TTL_SECONDS,
    DEFAULT_HEARTBEAT_SECONDS,
    PROTOCOL_VERSION,
    dumps,
)

log = logging.getLogger("landflow_sdk.announce")

DEFAULT_REGISTRY_URL = "http://127.0.0.1:3000"
REQUEST_TIMEOUT_SECONDS = 3.0
_DISABLED = {"off", "false", "0", "no", "none", "disabled"}

#: ``AnnounceRequest.instanceId``: random, picked once per process and sent with every announce. A restarted plugin
#: announces a new one, so the host pulls its manifest again even when the version is the same (new nodes or
#: parameters during development).
INSTANCE_ID = secrets.token_hex(16)


class RegistryUnreachable(Exception):
    """The host could not be contacted (connection refused, timeout, DNS...)."""


class RegistryRejected(Exception):
    """The host answered, but not with an accepted AnnounceResponse."""


class RegistryClient(Protocol):
    def announce(self, payload: dict[str, Any], timeout: float) -> dict[str, Any]: ...
    def withdraw(self, payload: dict[str, Any], timeout: float) -> None: ...
    def close(self) -> None: ...


def parse_registry_url(value: str | None) -> tuple[str, str] | None:
    """``LANDFLOW_REGISTRY_URL`` -> ``("http", "http://host:3000")`` | ``("grpc", "host:7070")`` | ``None`` (off)."""
    raw = (value or "").strip() or DEFAULT_REGISTRY_URL
    if raw.lower() in _DISABLED:
        return None
    if raw.startswith("grpc://"):
        target = raw[len("grpc://"):].rstrip("/")
        if not target:
            raise ValueError("LANDFLOW_REGISTRY_URL grpc:// needs host:port")
        return "grpc", target
    if raw.startswith(("http://", "https://")):
        return "http", raw.rstrip("/")
    raise ValueError(f"LANDFLOW_REGISTRY_URL must be http(s)://..., grpc://host:port or 'off', got {raw!r}")


def _is_loopback(host: str) -> bool:
    if host in ("localhost", ""):
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def registry_secret_headers() -> dict[str, str]:
    """``LANDFLOW_REGISTRY_SECRET`` (when the host requires one), sent with every announce and withdraw."""
    secret = os.environ.get("LANDFLOW_REGISTRY_SECRET")
    return {"X-Landflow-Registry-Secret": secret} if secret else {}


class HttpRegistryClient:
    """POST / DELETE ``{base}/api/plugins/announce`` with stdlib urllib."""

    def __init__(self, base_url: str) -> None:
        self.url = base_url.rstrip("/")
        if not self.url.endswith(ANNOUNCE_PATH):
            self.url += ANNOUNCE_PATH
        host = urllib.parse.urlsplit(self.url).hostname or ""
        # Never route a loopback registry through HTTP(S)_PROXY.
        handlers = [urllib.request.ProxyHandler({})] if _is_loopback(host) else []
        self._opener = urllib.request.build_opener(*handlers)

    def _call(self, method: str, payload: dict[str, Any], timeout: float) -> Any:
        request = urllib.request.Request(
            self.url,
            data=dumps(payload),
            method=method,
            headers={"Content-Type": "application/json; charset=utf-8", "Accept": "application/json", **registry_secret_headers()},
        )
        try:
            with self._opener.open(request, timeout=timeout) as response:
                body = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:300].decode("utf-8", "replace").strip()
            raise RegistryRejected(f"HTTP {exc.code}{': ' + detail if detail else ''}") from None
        except urllib.error.URLError as exc:
            raise RegistryUnreachable(str(exc.reason)) from None
        except (OSError, TimeoutError) as exc:
            raise RegistryUnreachable(str(exc) or type(exc).__name__) from None
        if not body:
            return {}
        try:
            return json.loads(body)
        except ValueError:
            raise RegistryRejected("response is not JSON") from None

    def announce(self, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        data = self._call("POST", payload, timeout)
        if not isinstance(data, dict):
            raise RegistryRejected("response is not an AnnounceResponse object")
        return data

    def withdraw(self, payload: dict[str, Any], timeout: float) -> None:
        self._call("DELETE", payload, timeout)

    def close(self) -> None:
        pass


class Announcer:
    """Announces every endpoint, then re-announces every ``heartbeatIntervalSeconds``.

    Runs on a daemon thread. When the host is unreachable it logs once and
    keeps retrying quietly (1s, 2s, 4s ... up to the heartbeat interval).
    """

    def __init__(
        self,
        client: RegistryClient,
        registry_label: str,
        plugin_id: str,
        version: str,
        endpoints: list[str],
        ttl_seconds: int = DEFAULT_ANNOUNCE_TTL_SECONDS,
    ) -> None:
        self.client = client
        self.registry_label = registry_label
        self.plugin_id = plugin_id
        self.version = version
        self.endpoints = list(endpoints)
        self.ttl_seconds = ttl_seconds
        self.interval: float = DEFAULT_HEARTBEAT_SECONDS
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._state: str | None = None  # None (not tried) | "ok" | "rejected" | "unreachable"
        self._announced_once = False
        self._warned: set[str] = set()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="landflow-announce", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            state = self.announce_once()
            if state == "unreachable":
                delay = min(backoff, self.interval)
                backoff = min(backoff * 2, self.interval)
            else:
                delay, backoff = self.interval, 1.0
            self._stop.wait(delay)

    def announce_once(self) -> str:
        intervals: list[float] = []
        rejected = False
        for endpoint in self.endpoints:
            if self._stop.is_set():
                break
            payload = {
                "protocol": PROTOCOL_VERSION,
                "endpoint": endpoint,
                "pluginId": self.plugin_id,
                "version": self.version,
                "ttlSeconds": self.ttl_seconds,
                "instanceId": INSTANCE_ID,
            }
            try:
                response = self.client.announce(payload, REQUEST_TIMEOUT_SECONDS)
            except RegistryUnreachable as exc:
                if self._state != "unreachable":
                    log.warning(
                        "Landflow host not reachable at %s (%s); plugin keeps serving, retrying announce quietly",
                        self.registry_label,
                        exc,
                    )
                self._state = "unreachable"
                return self._state
            except RegistryRejected as exc:
                self._warn_once(f"registry at {self.registry_label} did not accept {endpoint}: {exc}")
                rejected = True
                continue
            if response.get("accepted", True) is False:
                reason = response.get("message") or "no reason given"
                self._warn_once(f"registry at {self.registry_label} rejected {endpoint}: {reason}")
                rejected = True
                continue
            heartbeat = response.get("heartbeatIntervalSeconds")
            ok_number = isinstance(heartbeat, (int, float)) and not isinstance(heartbeat, bool) and heartbeat > 0
            intervals.append(float(heartbeat) if ok_number else DEFAULT_HEARTBEAT_SECONDS)

        if intervals:
            self.interval = max(1.0, min(intervals))
            accepted = ", ".join(self.endpoints) if not rejected else f"{len(intervals)}/{len(self.endpoints)} endpoints"
            if self._state in (None, "unreachable", "rejected") or not self._announced_once:
                log.info("announced %s to %s (heartbeat %gs)", accepted, self.registry_label, self.interval)
            else:
                log.debug("heartbeat ok (%s)", accepted)
            self._announced_once = True
        self._state = "rejected" if rejected else "ok"
        return self._state

    def _warn_once(self, message: str) -> None:
        if message not in self._warned:
            self._warned.add(message)
            log.warning("%s", message)

    def stop(self, withdraw: bool = True) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=REQUEST_TIMEOUT_SECONDS + 1)
            self._thread = None
        if withdraw and self._announced_once:
            withdrawn = 0
            for endpoint in self.endpoints:
                try:
                    self.client.withdraw({"endpoint": endpoint, "pluginId": self.plugin_id}, 2.0)
                    withdrawn += 1
                except (RegistryUnreachable, RegistryRejected) as exc:
                    log.debug("withdraw %s failed: %s", endpoint, exc)
            if withdrawn:
                log.info("withdrew %d endpoint(s) from %s", withdrawn, self.registry_label)
        try:
            self.client.close()
        except Exception:  # noqa: BLE001
            pass
