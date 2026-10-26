#!/usr/bin/env bash
# Create .venv/ here and install the Landflow Python SDK (editable) with the gRPC, MCP and broker extras.
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

.venv/bin/python -m pip install --quiet --disable-pip-version-check -e "../../sdks/python[grpc,mcp,brokers]"
.venv/bin/python -c 'import landflow_sdk, landflow_sdk.grpc_server, grpc, mcp, nats, valkey, pika, confluent_kafka; print(f"landflow-sdk {landflow_sdk.__version__} installed (grpcio {grpc.__version__}, mcp, broker drivers)")'
echo "run: .venv/bin/python main.py"
