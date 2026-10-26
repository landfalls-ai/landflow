#!/usr/bin/env python3
"""py-insights: an example Landflow plugin built with the Python SDK.

    ./setup.sh && .venv/bin/python main.py   # HTTP :7102 + gRPC :7202
    python3 main.py                          # HTTP only when grpcio is not installed

Override with LANDFLOW_HTTP_PORT / LANDFLOW_GRPC_PORT; LANDFLOW_REGISTRY_URL=off disables announce;
LANDFLOW_MAX_CONCURRENCY, LANDFLOW_TRANSPORTS (+ LANDFLOW_<KIND>_URL) and LANDFLOW_MCP=off|on are read too (README: Transports).
"""

import os
import sys
from pathlib import Path

try:
    import landflow_sdk  # noqa: F401
except ImportError:  # not installed: use the SDK from this checkout
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdks" / "python"))

from landflow_sdk import serve

from insights import build_plugin

HTTP_PORT = 7102
GRPC_PORT = 7202

# The analytics are pure Python, so one call keeps a core busy: about one call per core (LANDFLOW_MAX_CONCURRENCY overrides).
# Brokers: LANDFLOW_TRANSPORTS=http,grpc,nats + LANDFLOW_NATS_URL (native tier 1 drivers; the rest through landflow-bridge).
# MCP: /mcp on the HTTP port, loopback without a token (LANDFLOW_ADVERTISE_HOST/LANDFLOW_BIND_HOST move the bind address; then LANDFLOW_MCP_TOKEN).
DEFAULT_MAX_CONCURRENCY = os.cpu_count() or 4

if __name__ == "__main__":
    serve(build_plugin(), http_port=HTTP_PORT, grpc_port=GRPC_PORT, max_concurrency=DEFAULT_MAX_CONCURRENCY)
