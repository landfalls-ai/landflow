"""Registry proofs (docs/protocol.md §13): plugins answer the host's GetManifest challenge over HTTP and gRPC."""

from __future__ import annotations

import os
import sys
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk.http_server import HttpPluginServer  # noqa: E402
from landflow_sdk.registry_proof import (  # noqa: E402
    MAX_REGISTRY_CHALLENGE_LENGTH,
    REGISTRY_CHALLENGE_HEADER,
    REGISTRY_PROOF_HEADER,
    answer_registry_challenge,
    registry_proof,
    verify_registry_proof,
)
from tests.test_core import PLUGIN  # noqa: E402

try:
    import grpc

    from landflow_sdk import grpc_server
    from landflow_sdk._pb import plugin_pb2 as pb
    from landflow_sdk._pb import plugin_pb2_grpc as pb_grpc
except Exception:  # noqa: BLE001 - grpc extra not installed
    grpc_server = None

# The same vector is checked by the TypeScript and Go SDKs and the host.
VECTOR = "d6d47aef6c9f0cdd2357464b9db5c8d2a049d3768756e10af5ec4e37ad47655e"


class RegistryProofTests(unittest.TestCase):
    def test_vector_and_verify(self):
        self.assertEqual(registry_proof("registry-s3cret", "test-plugin", "challenge-123"), VECTOR)
        self.assertTrue(verify_registry_proof("registry-s3cret", "test-plugin", "challenge-123", VECTOR))
        self.assertFalse(verify_registry_proof("other", "test-plugin", "challenge-123", VECTOR))
        self.assertFalse(verify_registry_proof("registry-s3cret", "test-plugin", "challenge-123", None))
        self.assertIsNone(answer_registry_challenge("test-plugin", "x" * (MAX_REGISTRY_CHALLENGE_LENGTH + 1), secret="s"))
        self.assertIsNone(answer_registry_challenge("test-plugin", "challenge-123", secret=""))

    def test_http_manifest_answers_challenges(self):
        server = HttpPluginServer(PLUGIN, "127.0.0.1", 0)
        server.start()
        try:

            def proof(challenge: str | None) -> str | None:
                headers = {REGISTRY_CHALLENGE_HEADER: challenge} if challenge else {}
                request = urllib.request.Request(f"http://127.0.0.1:{server.port}/landflow/v1/manifest", headers=headers)
                with urllib.request.urlopen(request, timeout=5) as response:
                    return response.headers.get(REGISTRY_PROOF_HEADER)

            with mock.patch.dict(os.environ, {"LANDFLOW_REGISTRY_SECRET": ""}):
                self.assertIsNone(proof("challenge-123"))
            with mock.patch.dict(os.environ, {"LANDFLOW_REGISTRY_SECRET": "registry-s3cret"}):
                self.assertEqual(proof("challenge-123"), VECTOR)
                self.assertIsNone(proof(None))
        finally:
            server.stop()

    @unittest.skipIf(grpc_server is None, "grpc extra not installed")
    def test_grpc_manifest_answers_challenges(self):
        server = grpc_server.GrpcPluginServer(PLUGIN, "127.0.0.1", 0)
        server.start()
        channel = grpc.insecure_channel(f"127.0.0.1:{server.port}")
        try:
            stub = pb_grpc.PluginServiceStub(channel)
            with mock.patch.dict(os.environ, {"LANDFLOW_REGISTRY_SECRET": "registry-s3cret"}):
                _, call = stub.GetManifest.with_call(pb.GetManifestRequest(), metadata=((REGISTRY_CHALLENGE_HEADER, "challenge-123"),), timeout=5)
                self.assertEqual(dict(call.initial_metadata()).get(REGISTRY_PROOF_HEADER), VECTOR)
                _, call = stub.GetManifest.with_call(pb.GetManifestRequest(), timeout=5)
                self.assertNotIn(REGISTRY_PROOF_HEADER, dict(call.initial_metadata()))
        finally:
            channel.close()
            server.stop()


if __name__ == "__main__":
    unittest.main()
