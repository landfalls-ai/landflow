#!/usr/bin/env bash
# Regenerate the gRPC stubs in landflow_sdk/_pb/ from the repo's plugin.proto.
#
#   pip install grpcio-tools          # or: pip install -e 'sdks/python[dev]'
#   sdks/python/scripts/gen_proto.sh
#
# PYTHON   interpreter that has grpcio-tools installed (default: python3)
# PROTO_ROOT  include root that contains landflow/plugin/v1/plugin.proto
#
# The stubs are committed. After regenerating, bump the grpcio / protobuf
# lower bounds in pyproject.toml to the versions printed below, because the
# generated code refuses to import on older runtimes.
set -euo pipefail

SDK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTO_ROOT="${PROTO_ROOT:-$SDK_DIR/../../packages/protocol/proto}"
PROTO_FILE="landflow/plugin/v1/plugin.proto"
OUT_DIR="$SDK_DIR/landflow_sdk/_pb"
PYTHON="${PYTHON:-python3}"

if [ ! -f "$PROTO_ROOT/$PROTO_FILE" ]; then
  echo "error: $PROTO_ROOT/$PROTO_FILE not found (set PROTO_ROOT)" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Keep the canonical include path so the descriptor is registered as
# "landflow/plugin/v1/plugin.proto" (matches the other SDKs / reflection).
"$PYTHON" -m grpc_tools.protoc \
  -I "$PROTO_ROOT" \
  --python_out="$TMP" \
  --pyi_out="$TMP" \
  --grpc_python_out="$TMP" \
  "$PROTO_ROOT/$PROTO_FILE"

mkdir -p "$OUT_DIR"
GEN="$TMP/landflow/plugin/v1"
cp "$GEN/plugin_pb2.py" "$GEN/plugin_pb2.pyi" "$OUT_DIR/"

# protoc emits an absolute import (`from landflow.plugin.v1 import plugin_pb2`)
# that only works with the proto root on sys.path; make it package-relative.
sed -e 's/^from landflow\.plugin\.v1 import plugin_pb2 as /from . import plugin_pb2 as /' \
  "$GEN/plugin_pb2_grpc.py" > "$OUT_DIR/plugin_pb2_grpc.py"

if grep -q '^from landflow\.' "$OUT_DIR/plugin_pb2_grpc.py"; then
  echo "error: failed to rewrite imports in plugin_pb2_grpc.py" >&2
  exit 1
fi

"$PYTHON" - <<'PY'
import grpc_tools, importlib.metadata as md
print("generated with grpcio-tools", md.version("grpcio-tools"), "/ protobuf", md.version("protobuf"))
PY
echo "wrote $OUT_DIR/{plugin_pb2.py,plugin_pb2.pyi,plugin_pb2_grpc.py}"
