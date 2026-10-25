#!/usr/bin/env python3
"""Smoke-test the plugin's gRPC binding: GetManifest, Execute (stats), LoadOptions, Health, NOT_FOUND.

    .venv/bin/python grpc_client.py [host:port]     # default 127.0.0.1:7202
"""

import json
import sys
from pathlib import Path

try:
    import landflow_sdk  # noqa: F401
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdks" / "python"))

import grpc

from landflow_sdk._pb import plugin_pb2 as pb
from landflow_sdk._pb import plugin_pb2_grpc as pb_grpc
from landflow_sdk.grpc_server import execute_request_to_proto, execute_response_from_proto, to_dynamic

target = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1:7202"
stub = pb_grpc.PluginServiceStub(grpc.insecure_channel(target))

manifest = stub.GetManifest(pb.GetManifestRequest(host_version="smoke"), timeout=5)
nodes = [json.loads(n.json) for n in manifest.nodes]
print(f"GetManifest: {manifest.protocol} {manifest.plugin.id} {manifest.plugin.version} "
      f"lang={manifest.plugin.language} sdk={manifest.plugin.sdk_name} nodes={[n['name'] for n in nodes]}")

request = {
    "protocol": "landflow.plugin/v1",
    "executionId": "ex_grpc",
    "workflowId": "wf_grpc",
    "mode": "manual",
    "node": {"id": "n1", "name": "Stats", "type": "py-insights.stats", "typeVersion": 1},
    "parameters": {"field": "price"},
    "itemParameters": [{"field": "price"}] * 3,
    "inputs": [[{"json": {"price": 10}}, {"json": {"price": 20}}, {"json": {"price": 45}}]],
}
response = execute_response_from_proto(stub.Execute(execute_request_to_proto(request), timeout=5))
print("Execute(stats):", json.dumps(response))

options = stub.LoadOptions(
    pb.LoadOptionsRequest(node_type="keywords", method="languages", parameters=to_dynamic({})), timeout=5
)
print("LoadOptions(languages):", [o["value"] for o in json.loads(options.options.json)])

health = stub.Health(pb.HealthRequest(), timeout=5)
print(f"Health: status={health.status} plugin={health.plugin_id} version={health.version} uptime_ms={health.uptime_ms}")

request["node"]["type"] = "py-insights.nope"
try:
    stub.Execute(execute_request_to_proto(request), timeout=5)
    print("unknown node: unexpectedly succeeded")
    sys.exit(1)
except grpc.RpcError as exc:
    print(f"Execute(unknown node): {exc.code().name} - {exc.details()}")
