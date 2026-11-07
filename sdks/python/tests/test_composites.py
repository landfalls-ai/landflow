"""Capabilities and composite types in the manifest (HTTP, gRPC) and their validation. Run:

    python3 -m unittest discover -s sdks/python/tests
"""

from __future__ import annotations

import copy
import json
import unittest
import urllib.request

from _support import grpc_server

from landflow_sdk import DescriptorError, Node, Plugin
from landflow_sdk.http_server import HttpPluginServer


class Enrich(Node):
    description = {
        "name": "enrich", "displayName": "Enrich", "kind": "action", "version": 1,
        "inputs": [{"type": "main"}], "outputs": [{"type": "main"}],
        "capabilities": ["ioc.enrich"],
    }

    def execute(self, ctx):
        return [ctx.input_data(0)]


def composite() -> dict:
    return {
        "name": "aiTriage", "displayName": "AI triage", "description": "Enrich, reason, decide", "version": 1,
        "inputs": [{"name": "in", "slot": "enrich"}],
        "outputs": [{"name": "decision", "slot": "decide", "index": 1}],
        "slots": [
            {"name": "enrich", "displayName": "Enrich", "accepts": {"capability": "ioc.enrich"}, "max": 1},
            {"name": "decide", "displayName": "Decide", "min": 0,
             "accepts": {"anyOf": [{"type": ["a.b", "a.c"]}, {"kind": "action"}]}},
        ],
        "rules": [{"rule": "feeds", "from": "enrich", "to": "decide"}, {"rule": "onError", "slots": ["enrich"], "value": "continue"}, {"rule": "sealed"}],
        "starter": {
            "nodes": [
                {"id": "a", "name": "A", "type": "x.y", "position": [0, 10], "slot": "enrich"},
                {"id": "b", "name": "B", "type": "x.z", "position": [200, 10]},
            ],
            "connections": [{"source": "a", "target": "b"}],
        },
    }


def make(*comps: dict) -> Plugin:
    return Plugin("test-plugin", "Test", "1.0.0", nodes=[Enrich()], composites=list(comps))


class CompositeManifestTests(unittest.TestCase):
    def test_manifest_has_capabilities_and_composites(self):
        manifest = make(composite()).manifest()
        self.assertEqual(manifest["nodes"][0]["capabilities"], ["ioc.enrich"])
        self.assertEqual(manifest["composites"], [composite()])

    def test_no_composites_key_when_none(self):
        self.assertNotIn("composites", make().manifest())

    def test_declared_dict_is_copied(self):
        source = composite()
        plugin = make(source)
        source["slots"].clear()
        self.assertEqual(len(plugin.manifest()["composites"][0]["slots"]), 2)

    def test_http(self):
        server = HttpPluginServer(make(composite()), "127.0.0.1", 0)
        server.start()
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{server.port}/landflow/v1/manifest", timeout=5) as response:
                body = json.loads(response.read())
        finally:
            server.stop()
        self.assertEqual(body["composites"][0]["slots"][0]["accepts"], {"capability": "ioc.enrich"})
        self.assertEqual(body["nodes"][0]["capabilities"], ["ioc.enrich"])

    @unittest.skipIf(grpc_server is None, "grpc extra not installed")
    def test_grpc(self):
        import grpc

        from landflow_sdk._pb import plugin_pb2 as pb
        from landflow_sdk._pb import plugin_pb2_grpc as pb_grpc

        server = grpc_server.GrpcPluginServer(make(composite()), "127.0.0.1", 0)
        server.start()
        channel = grpc.insecure_channel(f"127.0.0.1:{server.port}")
        try:
            manifest = pb_grpc.PluginServiceStub(channel).GetManifest(pb.GetManifestRequest(), timeout=5)
        finally:
            channel.close()
            server.stop()
        self.assertEqual([json.loads(c.json) for c in manifest.composites], [composite()])
        self.assertEqual(json.loads(manifest.nodes[0].json)["capabilities"], ["ioc.enrich"])


class CompositeValidationTests(unittest.TestCase):
    def check(self, edit, expected: str):
        c = composite()
        edit(c)
        with self.assertRaises(DescriptorError) as caught:
            make(c)
        self.assertIn(expected, str(caught.exception))

    def test_valid(self):
        make(composite())

    def test_duplicate_slot(self):
        self.check(lambda c: c["slots"][1].update(name="enrich"), 'duplicate slot "enrich"')

    def test_max_below_min(self):
        self.check(lambda c: c["slots"][0].update(min=2, max=1), "max is below min")

    def test_unknown_slots(self):
        self.check(lambda c: c["outputs"][0].update(slot="nope"), 'port "decision" names unknown slot "nope"')
        self.check(lambda c: c["rules"][0].update(to="nope"), 'a feeds rule names unknown slot "nope"')
        self.check(lambda c: c["rules"][1].update(slots=["nope"]), 'an onError rule names unknown slot "nope"')
        self.check(lambda c: c["rules"].append({"rule": "reaches", "to": "nope"}), 'a reaches rule names unknown slot "nope"')
        self.check(lambda c: c["starter"]["nodes"][0].update(slot="nope"), 'starter node "a" names unknown slot "nope"')

    def test_starter_retry_fields_pass_through_and_are_checked(self):
        retry = {"onError": "continue", "retryOnFail": True, "maxTries": 3, "waitBetweenTriesMs": 1500, "retryBackoff": "exponential"}
        c = composite()
        c["starter"]["nodes"][0].update(retry)
        # The wire form is kept exactly: the manifest carries the fields the host's schema accepts.
        self.assertEqual(make(c).manifest()["composites"][0]["starter"]["nodes"][0], c["starter"]["nodes"][0])
        node = lambda c: c["starter"]["nodes"][0]
        self.check(lambda c: node(c).update(waitBetweenTriesMs=60_001), "waitBetweenTriesMs must be an integer from 0 to 60000")
        self.check(lambda c: node(c).update(waitBetweenTriesMs=-1), "waitBetweenTriesMs")
        self.check(lambda c: node(c).update(retryBackoff="linear"), "retryBackoff 'linear' must be 'fixed' or 'exponential'")
        self.check(lambda c: node(c).update(maxTries=0), "maxTries must be a positive integer")
        self.check(lambda c: node(c).update(onError="fallback"), "onError 'fallback' must be 'stop' or 'continue'")
        self.check(lambda c: node(c).update(retryOnFail="yes"), "retryOnFail must be true or false")

    def test_starter_connection_unknown_node(self):
        self.check(lambda c: c["starter"]["connections"][0].update(target="zzz"), "names an unknown node")

    def test_identifiers(self):
        self.check(lambda c: c.update(name="1bad"), "must be an identifier")
        self.check(lambda c: c["slots"][0].update(name="has space"), "slot name")
        self.check(lambda c: c["inputs"][0].update(name="bad name"), "port name")

    def test_matcher_and_rules(self):
        self.check(lambda c: c["slots"][0].update(accepts={}), "needs at least one field")
        self.check(lambda c: c["slots"][0].update(accepts={"capability": "Bad Tag"}), "capability")
        self.check(lambda c: c["rules"][2].update(rule="mystery"), "must be one of feeds")
        self.check(lambda c: c.update(slots=[]), "at least one slot")

    def test_duplicate_composite(self):
        with self.assertRaises(DescriptorError):
            make(composite(), copy.deepcopy(composite()))
        make(composite(), {**composite(), "version": 2})

    def test_bad_node_capability(self):
        class Bad(Enrich):
            description = {**Enrich.description, "capabilities": ["IOC Enrich"]}

        with self.assertRaises(DescriptorError) as caught:
            Plugin("test-plugin", "Test", "1.0.0", nodes=[Bad()])
        self.assertIn("capability", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
