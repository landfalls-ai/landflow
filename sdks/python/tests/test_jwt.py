"""RS256 / GitHub App JWTs in pure Python, checked against the openssl CLI (skipped when openssl is missing)."""

from __future__ import annotations

import base64
import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from _support import *  # noqa: F401,F403 - import path

from landflow_sdk import JwtError, github_app_jwt, rs256_sign
from landflow_sdk.jwt import _SHA256_PREFIX, _sequence, parse_rsa_private_key

OPENSSL = shutil.which("openssl")


def b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def openssl(*args: str, input: bytes | None = None) -> bytes:
    return subprocess.run([OPENSSL or "openssl", *args], input=input, check=True, capture_output=True).stdout


@unittest.skipIf(OPENSSL is None, "openssl is not installed")
class JwtTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.dir.cleanup)
        root = Path(cls.dir.name)
        pkcs8 = openssl("genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048").decode()
        (root / "k8.pem").write_text(pkcs8)
        pkcs1 = openssl("rsa", "-in", str(root / "k8.pem"), "-traditional").decode()
        (root / "k1.pem").write_text(pkcs1)
        (root / "pub.pem").write_bytes(openssl("rsa", "-in", str(root / "k8.pem"), "-pubout"))
        cls.pkcs8, cls.pkcs1 = pkcs8, pkcs1
        assert "BEGIN PRIVATE KEY" in pkcs8 and "BEGIN RSA PRIVATE KEY" in pkcs1

    def verify_with_openssl(self, token: str) -> bool:
        head, body, sig = token.split(".")
        root = Path(self.dir.name)
        (root / "sig.bin").write_bytes(b64d(sig))
        result = subprocess.run([OPENSSL, "dgst", "-sha256", "-verify", str(root / "pub.pem"), "-signature", str(root / "sig.bin")],
                                input=f"{head}.{body}".encode(), capture_output=True)
        return result.returncode == 0

    def test_both_key_formats_sign_the_same_and_openssl_verifies(self):
        payload = {"iss": "12345", "iat": 1, "exp": 2}
        a, b = rs256_sign(self.pkcs8, payload), rs256_sign(self.pkcs1, payload)
        self.assertEqual(a, b)  # PKCS#1 v1.5 is deterministic
        self.assertTrue(self.verify_with_openssl(a))
        header = json.loads(b64d(a.split(".")[0]))
        self.assertEqual(header, {"alg": "RS256", "typ": "JWT"})
        self.assertEqual(json.loads(b64d(a.split(".")[1])), payload)

    def test_pure_python_verification_and_tamper(self):
        token = rs256_sign(self.pkcs1, {"sub": "x"}, headers={"kid": "k1"})
        head, body, sig = token.split(".")
        self.assertEqual(json.loads(b64d(head))["kid"], "k1")
        n, _ = parse_rsa_private_key(self.pkcs1)
        e = int.from_bytes(_sequence(self.dir_der())[2][1], "big")
        recovered = pow(int.from_bytes(b64d(sig), "big"), e, n).to_bytes((n.bit_length() + 7) // 8, "big")
        self.assertTrue(recovered.endswith(_SHA256_PREFIX + hashlib.sha256(f"{head}.{body}".encode()).digest()))
        self.assertTrue(recovered.startswith(b"\x00\x01\xff"))
        self.assertFalse(self.verify_with_openssl(f"{head}.{body}x.{sig}"))

    def dir_der(self) -> bytes:
        from landflow_sdk.jwt import _pem_to_der

        return _pem_to_der(self.pkcs1)[1]

    def test_github_app_jwt_claims(self):
        token = github_app_jwt(98765, self.pkcs8, now=1_760_000_000)
        claims = json.loads(b64d(token.split(".")[1]))
        self.assertEqual(claims, {"iat": 1_760_000_000 - 60, "exp": 1_760_000_000 + 540, "iss": "98765"})
        self.assertTrue(self.verify_with_openssl(token))

    def test_single_line_key_with_escaped_newlines(self):
        escaped = self.pkcs1.strip().replace("\n", "\\n")
        self.assertEqual(rs256_sign(escaped, {"a": 1}), rs256_sign(self.pkcs1, {"a": 1}))

    def test_bad_keys(self):
        for bad, text in [("", "pem"), ("-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----", "encrypted"),
                          ("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----", "unsupported"),
                          ("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----", "private key")]:
            with self.assertRaises(JwtError, msg=bad) as ctx:
                rs256_sign(bad, {})
            self.assertIn(text.split()[0].lower(), str(ctx.exception).lower())


if __name__ == "__main__":
    unittest.main()
