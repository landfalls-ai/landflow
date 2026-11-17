"""Tests call the plugin with the request the host would send. No server, no network."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
try:
    import landflow_sdk  # noqa: F401
except ImportError:  # not installed: use the SDK from this checkout
    sys.path.insert(0, str(HERE.parents[3] / "sdks" / "python"))

import hello_node  # noqa: E402
from hello_node import build_plugin  # noqa: E402

CREDENTIALS = {"helloApi": {"apiKey": "hello-123", "salutation": "Hello"}}


def request(node: str, parameters: dict[str, Any], items: list[dict[str, Any]], **more: Any) -> dict[str, Any]:
    return {
        "protocol": "landflow.plugin/v1", "executionId": "ex_test", "mode": "manual",
        "node": {"id": "n1", "name": node, "type": f"hello-node.{node}", "typeVersion": 1},
        "parameters": parameters, "itemParameters": [parameters for _ in items],
        "inputs": [[{"json": item} for item in items]],
        "credentials": CREDENTIALS, **more,
    }


class GreetTest(unittest.TestCase):
    def test_greetings_go_to_output_0_and_empty_names_to_output_1(self):
        response = build_plugin().execute(request("greet", {"name": "Ada", "shout": False}, [{"id": 1}]))
        self.assertNotIn("error", response)
        self.assertEqual([i["json"] for i in response["outputs"][0]], [{"id": 1, "greeting": "Hello, Ada!"}])
        self.assertEqual(response["outputs"][1], [])

        empty = build_plugin().execute(request("greet", {"name": "  "}, [{"id": 2}]))
        self.assertEqual(empty["outputs"][0], [])
        self.assertEqual([i["json"] for i in empty["outputs"][1]], [{"id": 2, "reason": "empty name"}])

    def test_shouts_and_uses_the_credential_salutation(self):
        response = build_plugin().execute(request(
            "greet", {"name": "Ada", "shout": True}, [{}], credentials={"helloApi": {"apiKey": "hello-1", "salutation": "Hi"}}))
        self.assertEqual(response["outputs"][0][0]["json"]["greeting"], "HI, ADA!")

    def test_a_long_name_fails_the_step_with_the_item_index(self):
        response = build_plugin().execute(request("greet", {"name": "x" * 51}, [{}]))
        self.assertIn("longer than 50", response["error"]["message"])
        self.assertEqual(response["error"]["itemIndex"], 0)

    def test_a_node_set_to_continue_on_fail_sends_the_item_to_skipped(self):
        response = build_plugin().execute(request("greet", {"name": "x" * 51}, [{}], continueOnFail=True))
        self.assertNotIn("error", response)
        self.assertIn("longer than 50", response["outputs"][1][0]["json"]["error"])

    def test_refuses_to_run_without_the_credential(self):
        response = build_plugin().execute(request("greet", {"name": "Ada"}, [{}], credentials={}))
        self.assertIn("helloApi", response["error"]["message"])


class CredentialTest(unittest.TestCase):
    def test_accepts_a_key_of_the_right_shape_and_says_why_it_refuses_another(self):
        plugin = build_plugin()
        self.assertEqual(plugin.test_credentials("helloApi", {"apiKey": "hello-1"}), {"ok": True, "message": "Key accepted"})
        self.assertFalse(plugin.test_credentials("helloApi", {"apiKey": "nope"})["ok"])


class NewRequestTest(unittest.TestCase):
    def setUp(self):
        hello_node.REQUESTS.clear()

    def test_records_a_baseline_first_then_returns_only_what_is_new(self):
        plugin = build_plugin()
        hello_node.REQUESTS.append({"id": 1, "name": "old"})
        first = plugin.execute(request("newRequest", {}, [], mode="poll", inputs=[]))
        self.assertEqual(first["outputs"][0] if first["outputs"] else [], [])
        self.assertEqual(first["pollState"], {"lastId": 1})

        hello_node.REQUESTS.append({"id": 2, "name": "new"})
        second = plugin.execute(request("newRequest", {}, [], mode="poll", inputs=[], pollState=first["pollState"]))
        self.assertEqual([i["json"] for i in second["outputs"][0]], [{"id": 2, "name": "new"}])
        self.assertEqual(second["pollState"], {"lastId": 2})

    def test_shows_recent_items_in_manual_mode_without_state(self):
        hello_node.REQUESTS.append({"id": 1, "name": "a"})
        response = build_plugin().execute(request("newRequest", {}, [], mode="manual", inputs=[]))
        self.assertEqual(len(response["outputs"][0]), 1)
        self.assertNotIn("pollState", response)


class ManifestTest(unittest.TestCase):
    def test_describes_two_outputs_a_testable_credential_and_the_poll_interval(self):
        manifest = build_plugin().manifest()
        nodes = {n["name"]: n for n in manifest["nodes"]}
        self.assertEqual(list(nodes), ["greet", "newRequest"])
        self.assertEqual(len(nodes["greet"]["outputs"]), 2)
        self.assertIn("pollInterval", [p["name"] for p in nodes["newRequest"]["properties"]])
        self.assertTrue(manifest["credentialTypes"][0]["testable"])


if __name__ == "__main__":
    unittest.main()
