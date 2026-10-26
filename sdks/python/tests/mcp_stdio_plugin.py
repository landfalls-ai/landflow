#!/usr/bin/env python3
"""The conformance plugin as an MCP stdio server (``python mcp_stdio_plugin.py --mcp-stdio``), for test_mcp.py and live
checks with a desktop agent; without the flag it serves HTTP on ``--http`` (and ``/mcp``)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from conformance_plugin import build_plugin  # noqa: E402

from landflow_sdk import serve  # noqa: E402

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--http", type=int, default=0)
    parser.add_argument("--grpc", type=int, default=None)
    parser.add_argument("--mcp-stdio", action="store_true")
    args = parser.parse_args()
    serve(build_plugin(), http=args.http, grpc=args.grpc, announce=False)
