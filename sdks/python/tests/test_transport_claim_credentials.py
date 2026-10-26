"""The S3 claim store's credential chain against fakes on 127.0.0.1 (ports 7520-7539): a fake STS and a fake container credentials
endpoint. Nothing here reaches a real AWS endpoint.

    plugins/py-insights/.venv/bin/python -m unittest sdks/python/tests/test_transport_claim_credentials.py
"""

from __future__ import annotations

import os
import secrets
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk.transport import claim  # noqa: E402
from landflow_sdk.transport.claim import parse_claim_store, resolve_claim_credentials  # noqa: E402


class Clock:
    def __init__(self) -> None:
        self.t = 1_800_000_000.0
        self.lock = threading.Lock()

    def __call__(self) -> float:
        with self.lock:
            return self.t

    def add(self, seconds: float) -> None:
        with self.lock:
            self.t += seconds


def iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Fake:
    """A tiny HTTP server on a port in 7520-7539. ``handler(method, path, headers, body) -> (status, body)``."""

    def __init__(self, handler) -> None:
        self.calls: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length).decode() if length else ""
                record = {"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body}
                with outer.lock:
                    outer.calls.append(record)
                status, payload = handler(record, len(outer.calls))
                data = payload.encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_DELETE = _serve

            def log_message(self, *args) -> None:  # noqa: D401
                pass

        self.lock = threading.Lock()
        for port in range(7520, 7540):
            try:
                self.server = HTTPServer(("127.0.0.1", port), Handler)
                break
            except OSError:
                continue
        else:
            raise RuntimeError("no free port in 7520-7539")
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def token_file(content: str) -> str:
    handle = tempfile.NamedTemporaryFile("w", delete=False, suffix=".token")
    handle.write(content)
    handle.close()
    return handle.name


class WebIdentityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()

        def sts(record, n):
            return 200, (
                '<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials>'
                f"<AccessKeyId>ASIAWEB{n}</AccessKeyId><SecretAccessKey>websecret{n}</SecretAccessKey><SessionToken>webtoken{n}</SessionToken>"
                f"<Expiration>{iso(self.clock() + 3600)}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>"
            )

        self.sts = Fake(sts)
        self.addCleanup(self.sts.close)

    def env(self, **extra):
        return {"AWS_WEB_IDENTITY_TOKEN_FILE": self.tokens, "AWS_ROLE_ARN": "arn:aws:iam::1:role/r", "AWS_ROLE_SESSION_NAME": "sess", "AWS_ENDPOINT_URL_STS": self.sts.url, **extra}

    def test_refreshes_before_expiry_and_rereads_the_token_file(self):
        self.tokens = token_file("jwt-one\n")
        provider = resolve_claim_credentials(self.env(), clock=self.clock)
        self.assertEqual(provider.source, "web identity")
        self.assertEqual(len(self.sts.calls), 0, "lazy")
        first = provider.retrieve()
        self.assertEqual((first.access_key_id, first.session_token, first.expires), ("ASIAWEB1", "webtoken1", self.clock() + 3600))
        call = self.sts.calls[0]
        self.assertEqual((call["method"], "Authorization" in call["headers"]), ("POST", False))
        form = dict(p.split("=", 1) for p in call["body"].split("&"))
        self.assertEqual((form["Action"], form["Version"], form["RoleSessionName"], form["WebIdentityToken"]), ("AssumeRoleWithWebIdentity", "2011-06-15", "sess", "jwt-one"))
        self.assertEqual(form["RoleArn"], "arn%3Aaws%3Aiam%3A%3A1%3Arole%2Fr")
        self.clock.add(54 * 60)  # 6 minutes left: cached
        self.assertEqual(provider.retrieve().access_key_id, "ASIAWEB1")
        self.assertEqual(len(self.sts.calls), 1)
        Path(self.tokens).write_text("jwt-two")
        self.clock.add(90)  # 4.5 minutes left: inside the margin
        self.assertEqual(provider.retrieve().access_key_id, "ASIAWEB2")
        self.assertIn("WebIdentityToken=jwt-two", self.sts.calls[1]["body"])

    def test_a_failed_refresh_keeps_a_set_that_has_not_expired(self):
        self.tokens = token_file("jwt")
        provider = resolve_claim_credentials(self.env(), clock=self.clock)
        provider.retrieve()
        self.sts.close()
        self.clock.add(58 * 60)
        self.assertEqual(provider.retrieve().access_key_id, "ASIAWEB1")
        self.clock.add(3 * 60)
        with self.assertRaisesRegex(RuntimeError, "web identity"):
            provider.retrieve()

    def test_sts_error_is_reported(self):
        sts = Fake(lambda record, n: (403, "<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>"))
        self.addCleanup(sts.close)
        self.tokens = token_file("jwt")
        provider = resolve_claim_credentials(self.env(AWS_ENDPOINT_URL_STS=sts.url), clock=self.clock)
        with self.assertRaisesRegex(RuntimeError, "HTTP 403.*AccessDenied"):
            provider.retrieve()

    def test_regional_aws_endpoint_only_with_aws_true(self):
        base = {"AWS_WEB_IDENTITY_TOKEN_FILE": "/nonexistent", "AWS_ROLE_ARN": "arn"}
        with self.assertRaises(ValueError) as caught:
            resolve_claim_credentials(base, "eu-west-1", False)
        self.assertIn("AWS_ENDPOINT_URL_STS", str(caught.exception))
        self.assertIn("aws=true", str(caught.exception))
        self.assertEqual(resolve_claim_credentials(base, "eu-west-1", True)._inner.endpoint, "https://sts.eu-west-1.amazonaws.com")
        self.assertEqual(resolve_claim_credentials({**base, "AWS_ENDPOINT_URL": "http://127.0.0.1:1"}, "eu-west-1", True)._inner.endpoint, "http://127.0.0.1:1")
        self.assertEqual(resolve_claim_credentials({**base, "AWS_ENDPOINT_URL": "http://127.0.0.1:1", "AWS_ENDPOINT_URL_STS": "http://127.0.0.1:2"}, "eu-west-1", True)._inner.endpoint, "http://127.0.0.1:2")

    def test_the_store_signs_with_the_session_token_names_the_source_and_shares_one_refresh(self):
        self.tokens = token_file("jwt")
        s3 = Fake(lambda record, n: (200, ""))
        self.addCleanup(s3.close)
        setting = parse_claim_store(f"s3://bkt/pfx?endpoint={s3.url}", self.env())
        self.assertTrue(setting.describe.endswith("(credentials: web identity)"), setting.describe)
        self.assertNotIn("websecret", setting.describe)
        threads = [threading.Thread(target=setting.store.put, args=("claims/x", b"body")) for _ in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(self.sts.calls), 1)
        self.assertEqual(len(s3.calls), 20)
        for call in s3.calls:
            headers = {k.lower(): v for k, v in call["headers"].items()}
            self.assertEqual(headers["x-amz-security-token"], "webtoken1")
            self.assertIn("Credential=ASIAWEB1/", headers["authorization"])
            self.assertIn("x-amz-security-token", headers["authorization"])


class ContainerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.fake = Fake(
            lambda record, n: (
                200,
                f'{{"AccessKeyId":"ASIACTR{n}","SecretAccessKey":"s{n}","Token":"t{n}","Expiration":"{iso(self.clock() + 600)}"}}',
            )
        )
        self.addCleanup(self.fake.close)

    def test_full_uri_token_file_reread_and_refresh(self):
        tokens = token_file("tok-1\n")
        provider = resolve_claim_credentials(
            {"AWS_CONTAINER_CREDENTIALS_FULL_URI": self.fake.url + "/creds", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE": tokens, "AWS_CONTAINER_AUTHORIZATION_TOKEN": "ignored"}, clock=self.clock
        )
        self.assertEqual(provider.source, "container credentials")
        creds = provider.retrieve()
        self.assertEqual((creds.access_key_id, creds.session_token), ("ASIACTR1", "t1"))
        self.assertEqual((self.fake.calls[0]["path"], self.fake.calls[0]["headers"]["Authorization"]), ("/creds", "tok-1"))
        provider.retrieve()
        self.assertEqual(len(self.fake.calls), 1)
        Path(tokens).write_text("tok-2")
        self.clock.add(6 * 60)
        self.assertEqual(provider.retrieve().access_key_id, "ASIACTR2")
        self.assertEqual(self.fake.calls[1]["headers"]["Authorization"], "tok-2")

    def test_relative_uri_and_env_token(self):
        original = claim.CONTAINER_RELATIVE_BASE
        claim.CONTAINER_RELATIVE_BASE = self.fake.url
        self.addCleanup(setattr, claim, "CONTAINER_RELATIVE_BASE", original)
        provider = resolve_claim_credentials({"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "/v2/credentials/abc", "AWS_CONTAINER_AUTHORIZATION_TOKEN": "env-tok"}, clock=self.clock)
        provider.retrieve()
        self.assertEqual((self.fake.calls[0]["path"], self.fake.calls[0]["headers"]["Authorization"]), ("/v2/credentials/abc", "env-tok"))
        with self.assertRaises(ValueError):
            resolve_claim_credentials({"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "v2/x"})

    def test_full_uri_host_rule(self):
        cases = {
            "http://127.0.0.1:7520/c": True, "http://localhost/c": True, "http://[::1]:80/c": True, "http://169.254.170.2/c": True, "http://169.254.170.23/c": True,
            "http://[fd00:ec2::23]/c": True, "http://10.0.0.5/c": False, "http://169.254.169.254/c": False, "http://creds.example.com/c": False,
            "https://creds.example.com/c": True, "https://10.0.0.5/c": True, "http://127.0.0.1.evil.example.com/c": False, "ftp://127.0.0.1/c": False,
        }
        for uri, ok in cases.items():
            with self.subTest(uri=uri):
                if ok:
                    resolve_claim_credentials({"AWS_CONTAINER_CREDENTIALS_FULL_URI": uri})
                else:
                    with self.assertRaises(ValueError):
                        resolve_claim_credentials({"AWS_CONTAINER_CREDENTIALS_FULL_URI": uri})


class ChainTest(unittest.TestCase):
    def test_priority_order(self):
        every = {"AWS_WEB_IDENTITY_TOKEN_FILE": "/x", "AWS_ROLE_ARN": "arn", "AWS_ENDPOINT_URL_STS": "http://127.0.0.1:1", "AWS_CONTAINER_CREDENTIALS_FULL_URI": "http://127.0.0.1:2/c"}
        self.assertEqual(resolve_claim_credentials(every).source, "web identity")
        aws = {**every, "AWS_ACCESS_KEY_ID": "a", "AWS_SECRET_ACCESS_KEY": "b"}
        self.assertEqual(resolve_claim_credentials(aws).source, "static keys")
        landflow = resolve_claim_credentials({"LANDFLOW_CLAIM_ACCESS_KEY_ID": "L", "LANDFLOW_CLAIM_SECRET_ACCESS_KEY": "S", "AWS_ACCESS_KEY_ID": "a", "AWS_SECRET_ACCESS_KEY": "b", "AWS_SESSION_TOKEN": "t"}).retrieve()
        self.assertEqual((landflow.access_key_id, landflow.session_token), ("L", "t"))
        half = {"AWS_ACCESS_KEY_ID": "a", "AWS_CONTAINER_CREDENTIALS_FULL_URI": "http://127.0.0.1:2/c"}
        self.assertEqual(resolve_claim_credentials(half).source, "container credentials")

    def test_nothing_found_lists_every_source(self):
        with self.assertRaises(ValueError) as caught:
            resolve_claim_credentials({})
        message = str(caught.exception)
        for name in (
            "LANDFLOW_CLAIM_ACCESS_KEY_ID", "LANDFLOW_CLAIM_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
            "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "~/.aws", "IMDS",
        ):
            self.assertIn(name, message)
        with self.assertRaisesRegex(ValueError, "AWS_WEB_IDENTITY_TOKEN_FILE"):
            parse_claim_store("s3://b/p?endpoint=http://127.0.0.1:1", {})

    def test_concurrent_refresh_makes_one_call_per_expiry(self):
        clock = Clock()
        calls = []

        class Source:
            source = "container credentials"

            def retrieve(self):
                calls.append(1)
                return claim.ClaimCredentials("k", "s", "t", clock() + 360)

        cached = claim.CachedCredentials(Source(), clock)
        for round_ in range(4):
            if round_:
                clock.add(60)
            threads = [threading.Thread(target=cached.retrieve) for _ in range(20)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(len(calls), 4)


@unittest.skipUnless(
    os.environ.get("LANDFLOW_TEST_CLAIM_LOCALSTACK") and os.environ.get("LANDFLOW_TEST_CLAIM_LOCALSTACK_BUCKET"),
    "set LANDFLOW_TEST_CLAIM_LOCALSTACK=http://127.0.0.1:54566 and LANDFLOW_TEST_CLAIM_LOCALSTACK_BUCKET=<existing bucket> to run against LocalStack",
)
class LocalStackTest(unittest.TestCase):
    """Live: LocalStack answers STS AssumeRoleWithWebIdentity and S3. Dummy keys only; the bucket must exist."""

    def test_web_identity_put_get_delete(self):
        endpoint, bucket = os.environ["LANDFLOW_TEST_CLAIM_LOCALSTACK"], os.environ["LANDFLOW_TEST_CLAIM_LOCALSTACK_BUCKET"]
        env = {"AWS_WEB_IDENTITY_TOKEN_FILE": token_file("localstack-jwt"), "AWS_ROLE_ARN": "arn:aws:iam::000000000000:role/tmp-t6h", "AWS_ENDPOINT_URL_STS": endpoint}
        setting = parse_claim_store(f"s3://{bucket}/claims-test-py-{secrets.token_hex(3)}?endpoint={endpoint}", env)
        self.assertIn("credentials: web identity", setting.describe)
        key = claim.claim_key_for(int(time.time() * 1000), "live" + secrets.token_hex(3))
        setting.store.put(key, b"sealed body")
        self.assertEqual(setting.store.get(key), b"sealed body")
        setting.store.delete(key)
        self.assertIsNone(setting.store.get(key))


if __name__ == "__main__":
    unittest.main()
