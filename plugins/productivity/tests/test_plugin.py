"""Manifest shape, parameter defaults, and an end-to-end call through the SDK's HTTP server with trace context."""

from __future__ import annotations

import base64
import json
import unittest
import urllib.request

from _support import PARENT_SPAN_ID, TOKEN, TRACE_ID, TRACEPARENT, FakeApi, LogCapture, make_plugin

from landflow_sdk.http_server import HttpPluginServer

ACTIONS = {"notion", "airtable", "github", "jira", "hubspot", "rssFeedRead"}
TRIGGERS = {"githubTrigger", "rssFeedReadTrigger"}
APP_WEBHOOKS = {"githubWebhookTrigger"}


def visible(prop: dict, params: dict) -> bool:
    show = (prop.get("displayOptions") or {}).get("show") or {}
    return all(params.get(k) in allowed for k, allowed in show.items())


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = make_plugin().manifest()
        self.nodes = {n["name"]: n for n in self.manifest["nodes"]}

    def test_plugin_info_and_nodes(self):
        info = self.manifest["plugin"]
        self.assertEqual((info["id"], info["name"], info["language"]), ("productivity", "Productivity", "python"))
        self.assertTrue(info["icon"].startswith("data:image/svg+xml;base64,"))
        self.assertEqual(set(self.nodes), ACTIONS | TRIGGERS | APP_WEBHOOKS)
        colors = {"notion": "#000000", "airtable": "#18BFFF", "github": "#24292F", "jira": "#0052CC", "hubspot": "#FF7A59", "rssFeedRead": "#F26522"}
        for name, node in self.nodes.items():
            self.assertTrue(node["icon"].startswith("data:image/svg+xml;base64,"), name)
            self.assertTrue(node["categories"] and node["documentationUrl"].startswith("https://"), name)
            if name in ACTIONS:
                self.assertTrue(node["usableAsTool"] and node["toolDescription"], name)
                self.assertEqual(node["color"], colors[name])
            elif name in APP_WEBHOOKS:
                self.assertEqual((node["kind"], node["triggerSource"]), ("trigger", "appWebhook"))
            else:
                self.assertEqual((node["kind"], node["triggerSource"], node["properties"][0]["name"]), ("trigger", "poll", "pollInterval"))
        self.assertEqual(self.nodes["githubTrigger"]["properties"][0]["default"], 60)
        self.assertEqual(self.nodes["rssFeedReadTrigger"]["properties"][0]["default"], 300)

    def test_icons_are_original_svg_paths(self):
        for node in self.nodes.values():
            svg = base64.b64decode(node["icon"].split(",", 1)[1]).decode()
            self.assertTrue(svg.startswith("<svg") and "<text" not in svg and "<script" not in svg and "href" not in svg)

    def test_credential_types(self):
        types = {c["name"]: c for c in self.manifest["credentialTypes"]}
        secret = {"notionApi": "apiKey", "airtableTokenApi": "accessToken", "githubApi": "accessToken",
                  "jiraSoftwareCloudApi": "apiToken", "jiraSoftwareServerPatApi": "personalAccessToken", "hubspotAppToken": "appToken"}
        base = {"notionApi": "baseUrl", "airtableTokenApi": "baseUrl", "githubApi": "baseUrl",
                "jiraSoftwareCloudApi": "domain", "jiraSoftwareServerPatApi": "domain", "hubspotAppToken": "baseUrl"}
        self.assertEqual(set(types), set(secret))
        for name, ctype in types.items():
            props = {p["name"]: p for p in ctype["properties"]}
            self.assertTrue(ctype["testable"], name)
            self.assertEqual(props[secret[name]]["typeOptions"], {"password": True}, name)
            self.assertIn(base[name], props, name)
            self.assertTrue(ctype["documentationUrl"].startswith("https://"), name)

    def test_fresh_node_defaults_are_consistent(self):
        """The host fills parameters from defaults (last one wins for repeated names): the default
        resource must get one of its own operations, and every visible options value must exist."""
        for name, node in self.nodes.items():
            params = {}
            for prop in node["properties"]:
                if prop["type"] != "notice" and "default" in prop:
                    params[prop["name"]] = prop["default"]
            for prop in node["properties"]:
                if prop["type"] == "options" and visible(prop, params) and not (prop.get("typeOptions") or {}).get("loadOptionsMethod"):
                    self.assertIn(params[prop["name"]], [o["value"] for o in prop["options"]], f"{name}.{prop['name']}")

    def test_list_operations_have_return_all_and_limit(self):
        for name in ("notion", "airtable", "github", "jira", "hubspot"):
            props = [p["name"] for p in self.nodes[name]["properties"]]
            self.assertIn("returnAll", props, name)
            limit = next(p for p in self.nodes[name]["properties"] if p["name"] == "limit")
            self.assertEqual(limit["displayOptions"]["show"]["returnAll"], [False])


class HttpEndToEndTests(unittest.TestCase):
    def test_execute_over_http_continues_the_trace(self):
        with FakeApi() as api:
            api.route("GET", "/repos/octo/demo/issues", lambda r: [{"id": 0, "number": 0}] if r["query"].get("page") == ["2"]
                      else (200, [{"id": 2, "number": 2}], {"Link": '<{base}/repos/octo/demo/issues?page=2>; rel="next"'}))
            plugin = make_plugin()
            server = HttpPluginServer(plugin, "127.0.0.1", 0)
            server.start()
            try:
                body = {
                    "protocol": "landflow.plugin/v1", "executionId": "ex_http", "workflowId": "wf_http", "mode": "manual",
                    "node": {"id": "n1", "name": "Issues", "type": "productivity.github", "typeVersion": 1},
                    "parameters": {"resource": "issue", "operation": "getAll", "owner": "octo", "repository": "demo", "returnAll": True},
                    "itemParameters": [], "inputs": [[{"json": {}}]],
                    "credentials": {"githubApi": {"accessToken": TOKEN, "baseUrl": api.url}},
                }
                request = urllib.request.Request(f"http://127.0.0.1:{server.port}/landflow/v1/execute", data=json.dumps(body).encode(),
                                                 headers={"Content-Type": "application/json", "traceparent": TRACEPARENT})
                with LogCapture() as logs:
                    with urllib.request.urlopen(request, timeout=10) as resp:
                        result = json.loads(resp.read())
            finally:
                server.stop()
        self.assertNotIn("error", result)
        self.assertEqual([i["json"]["number"] for i in result["outputs"][0]], [2, 0])
        execute_span = logs.spans("plugin.execute productivity.github")[0]
        self.assertEqual((execute_span["trace_id"], execute_span["parent_span_id"]), (TRACE_ID, PARENT_SPAN_ID))
        list_span = logs.spans("github.list")[0]
        self.assertEqual((list_span["parent_span_id"], list_span["attributes"]["landflow.pages"]), (execute_span["span_id"], 2))
        clients = logs.spans("HTTP GET")
        self.assertEqual(len(clients), 2)
        self.assertTrue(all(s["parent_span_id"] == list_span["span_id"] and s["trace_id"] == TRACE_ID for s in clients))
        self.assertTrue(all(r["headers"]["traceparent"].split("-")[1] == TRACE_ID for r in api.requests))
        self.assertNotIn(TOKEN, logs.text)


if __name__ == "__main__":
    unittest.main()
