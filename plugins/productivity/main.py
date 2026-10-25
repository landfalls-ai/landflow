#!/usr/bin/env python3
"""productivity: Notion, Airtable, GitHub, Jira, HubSpot and RSS nodes for Landflow (Python SDK).

    ./setup.sh && .venv/bin/python main.py   # HTTP :7105 + gRPC :7205
    python3 main.py                          # HTTP only when grpcio is not installed

Override with LANDFLOW_HTTP_PORT / LANDFLOW_GRPC_PORT; LANDFLOW_REGISTRY_URL=off disables announce.
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

if __name__ == "__main__":
    serve(build_plugin(), http_port=HTTP_PORT, grpc_port=GRPC_PORT)
