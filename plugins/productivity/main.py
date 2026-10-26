#!/usr/bin/env python3
"""productivity: Notion, Airtable, GitHub, Jira, HubSpot and RSS nodes for Landflow (Python SDK).

    ./setup.sh && .venv/bin/python main.py   # HTTP :7105 + gRPC :7205
    python3 main.py                          # HTTP only when grpcio is not installed

Override with LANDFLOW_HTTP_PORT / LANDFLOW_GRPC_PORT; LANDFLOW_REGISTRY_URL=off disables announce;
LANDFLOW_MAX_CONCURRENCY, LANDFLOW_TRANSPORTS (+ LANDFLOW_<KIND>_URL) and LANDFLOW_MCP=off|on are read too (README: Transports).
"""

import sys
from pathlib import Path

try:
    import landflow_sdk  # noqa: F401
except ImportError:  # not installed: use the SDK from this checkout
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdks" / "python"))

from landflow_sdk import serve

from productivity import build_plugin

HTTP_PORT = 7105
GRPC_PORT = 7205

# Every node calls a third-party API with a per-token budget (Notion ~3 requests/s, Airtable 5/s per base, HubSpot ~100 per 10 s,
# GitHub's secondary limit, Jira's per-tenant throttle), so one instance runs 8 calls at once; more replicas add capacity.
# LANDFLOW_MAX_CONCURRENCY overrides it.
# Brokers: LANDFLOW_TRANSPORTS=http,grpc,nats + LANDFLOW_NATS_URL (native tier 1 drivers; the rest through landflow-bridge).
# MCP: /mcp on the HTTP port, loopback without a token (LANDFLOW_ADVERTISE_HOST/LANDFLOW_BIND_HOST move the bind address; then LANDFLOW_MCP_TOKEN).
DEFAULT_MAX_CONCURRENCY = 8

if __name__ == "__main__":
    serve(build_plugin(), http_port=HTTP_PORT, grpc_port=GRPC_PORT, max_concurrency=DEFAULT_MAX_CONCURRENCY)
