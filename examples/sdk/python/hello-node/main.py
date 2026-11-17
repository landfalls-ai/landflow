#!/usr/bin/env python3
"""Serve the plugin and announce it to the Landflow host (LANDFLOW_REGISTRY_URL, default http://127.0.0.1:3000).

    ./setup.sh
    LANDFLOW_REGISTRY_URL=off .venv/bin/python main.py     # stand-alone, no host

HTTP on :7192, gRPC on :7292 (HTTP only when grpcio is not installed). LANDFLOW_HTTP_PORT and LANDFLOW_GRPC_PORT override the ports.
"""

import sys
from pathlib import Path

try:
    import landflow_sdk  # noqa: F401
except ImportError:  # not installed: use the SDK from this checkout
    sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "sdks" / "python"))

from landflow_sdk import serve

from hello_node import build_plugin

if __name__ == "__main__":
    serve(build_plugin(), http_port=7192, grpc_port=7292, max_concurrency=8)
