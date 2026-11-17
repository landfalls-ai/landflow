#!/usr/bin/env bash
# Create .venv/ here and install the Landflow Python SDK from this checkout (editable), with the gRPC and MCP extras.
# A venv is required on Homebrew Python (PEP 668 "externally managed").
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PYTHON="${PYTHON:-python3}"
if ! "$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 11))'; then
  echo "error: Python >= 3.11 required ($("$PYTHON" --version 2>&1))" >&2
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "creating .venv with $("$PYTHON" --version)"
  "$PYTHON" -m venv .venv
fi

# Four levels up from here is the repository root.
.venv/bin/python -m pip install --quiet --disable-pip-version-check -e "../../../../sdks/python[grpc,mcp]"
.venv/bin/python -c 'import landflow_sdk, grpc, mcp; print(f"landflow-sdk {landflow_sdk.__version__} installed (grpcio {grpc.__version__}, mcp)")'
echo "test: .venv/bin/python -m unittest discover -s tests"
echo "run:  LANDFLOW_REGISTRY_URL=off .venv/bin/python main.py"
