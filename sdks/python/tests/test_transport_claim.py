"""The claim check in Python: the store setting and its safety, keys and the sweeper, and (with MinIO up) the S3 store:

    LANDFLOW_TEST_CLAIM_S3=http://127.0.0.1:59000 LANDFLOW_CLAIM_ACCESS_KEY_ID=landflow LANDFLOW_CLAIM_SECRET_ACCESS_KEY=landflow-dev-only \\
    plugins/py-insights/.venv/bin/python -m unittest discover -s sdks/python/tests -p test_transport_claim.py
"""

from __future__ import annotations

import os
import secrets
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk.transport.claim import MemoryClaimStore, S3ClaimStore, claim_key_for, claim_key_time, claim_store_from_env, parse_claim_store, sweep_claims  # noqa: E402
from landflow_sdk.transport.codec import Codec  # noqa: E402
from landflow_sdk.transport.envelope import EnvelopeError, host_source, request_type  # noqa: E402
from landflow_sdk.transport.memory import MEMORY_CAPABILITIES  # noqa: E402
from landflow_sdk.transport.security import Keyring, SecurityError  # noqa: E402
from landflow_sdk.transport.claim import ClaimError  # noqa: E402

try:
    import cryptography  # noqa: F401

    HAVE_CRYPTO = True
except ImportError:  # pragma: no cover
    HAVE_CRYPTO = False

ENV = {"LANDFLOW_CLAIM_ACCESS_KEY_ID": "k", "LANDFLOW_CLAIM_SECRET_ACCESS_KEY": "s"}


class ClaimSettingTest(unittest.TestCase):
    def test_unset_by_default_and_parses_memory_and_s3(self):
        self.assertIsNone(claim_store_from_env({}))
        self.assertEqual(parse_claim_store("memory://", ENV).store.kind, "memory")
        s3 = parse_claim_store("s3://landflow/claims-x?endpoint=http://127.0.0.1:59000&region=us-east-1&ttl=120", ENV)
        self.assertEqual((s3.store.kind, s3.ttl_ms, s3.describe), ("s3", 120_000, "s3://landflow/claims-x @ http://127.0.0.1:59000 (credentials: static keys)"))

    def test_refuses_the_default_aws_endpoint_unless_the_url_says_aws_true(self):
        with self.assertRaisesRegex(ValueError, "refusing to use the default"):
            parse_claim_store("s3://landflow/p", ENV)
        parse_claim_store("s3://landflow/p?aws=true", ENV)
        with self.assertRaisesRegex(ValueError, "not supported"):
            parse_claim_store("ftp://x", ENV)

    def test_sweeps_what_is_older_than_the_ttl(self):
        store = MemoryClaimStore()
        now = 1_800_000_000_000
        store.put(claim_key_for(now - 7_200_000, "old"), b"1")
        store.put(claim_key_for(now - 1_000, "fresh"), b"2")
        self.assertEqual(claim_key_time(claim_key_for(now, "abc")), now)
        self.assertEqual(sweep_claims(store, 3_600_000, now), 1)
        self.assertEqual(store.keys(), [claim_key_for(now - 1_000, "fresh")])


@unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
class SignedReferenceTest(unittest.TestCase):
    def setUp(self):
        self.store = MemoryClaimStore()
        self.codec = Codec(Keyring("claim-test"), MEMORY_CAPABILITIES.copy(max_message_bytes=4096), claims=self.store)

    def attrs(self):
        return self.codec.base(host_source("h1"), request_type("Execute"))

    def test_round_trip_and_tamper_checks(self):
        packed = self.codec.pack_claimed("p1", self.attrs(), {"blob": "x" * 10000}, True)
        self.assertTrue(packed.claim_key)
        self.assertEqual(len(packed.wire.body), 0)
        raw = self.codec.peek(packed.wire)
        resolved, key = self.codec.resolve_claim(raw, "p1")
        self.assertEqual(key, packed.claim_key)
        self.assertEqual(self.codec.unpack(resolved, "p1")[1], {"blob": "x" * 10000})
        swapped = type(raw)(raw.attributes.copy(lfclaim=claim_key_for(1, "other")), raw.body)
        with self.assertRaises(SecurityError):
            self.codec.resolve_claim(swapped, "p1")
        original = self.store.objects[packed.claim_key]
        for reason, body in (("size", original[:-1]), ("digest", bytes([original[0] ^ 1]) + original[1:]), ("missing", None)):
            if body is None:
                del self.store.objects[packed.claim_key]
            else:
                self.store.objects[packed.claim_key] = body
            with self.assertRaises(ClaimError) as caught:
                self.codec.resolve_claim(raw, "p1")
            self.assertEqual(caught.exception.reason, reason)

    def test_without_a_store_too_large_stays(self):
        plain = Codec(Keyring("claim-test"), MEMORY_CAPABILITIES.copy(max_message_bytes=4096))
        with self.assertRaises(EnvelopeError) as caught:
            plain.pack_claimed("p1", plain.base(host_source("h1"), request_type("Execute")), {"blob": "x" * 10000}, True)
        self.assertEqual(caught.exception.reason, "too_large")


@unittest.skipUnless(os.environ.get("LANDFLOW_TEST_CLAIM_S3"), "set LANDFLOW_TEST_CLAIM_S3=http://127.0.0.1:59000 (and LANDFLOW_CLAIM_ACCESS_KEY_ID / _SECRET_ACCESS_KEY) to test the S3 claim store")
class S3ClaimStoreTest(unittest.TestCase):
    def test_puts_gets_lists_sweeps_and_deletes(self):
        store = S3ClaimStore(
            os.environ.get("LANDFLOW_TEST_CLAIM_BUCKET", "landflow"), prefix=f"claims-test-py-{secrets.token_hex(3)}/", endpoint=os.environ["LANDFLOW_TEST_CLAIM_S3"],
            access_key_id=os.environ.get("LANDFLOW_CLAIM_ACCESS_KEY_ID"), secret_access_key=os.environ.get("LANDFLOW_CLAIM_SECRET_ACCESS_KEY"),
        )
        key, old = claim_key_for(int(time.time() * 1000), "abc123"), claim_key_for(int(time.time() * 1000) - 7_200_000, "old456")
        body = secrets.token_bytes(300_000)
        store.put(key, body)
        store.put(old, b"\x01\x02\x03")
        self.assertEqual(store.get(key), body)
        self.assertEqual(sorted(store.list("claims/")), sorted([key, old]))
        self.assertEqual(sweep_claims(store, 3_600_000, int(time.time() * 1000)), 1)
        self.assertIsNone(store.get(old))
        store.delete(key)
        store.delete(key)
        self.assertIsNone(store.get(key))


if __name__ == "__main__":
    unittest.main()
