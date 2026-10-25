#!/usr/bin/env bash
# Regenerates landflowpb/*.pb.go from the repo's canonical proto.
# Requires protoc, protoc-gen-go and protoc-gen-go-grpc on PATH:
#   go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
#   go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
set -euo pipefail

cd "$(dirname "$0")"
export PATH="$PATH:$(go env GOPATH)/bin"

PROTO_ROOT=../../packages/protocol/proto
MODULE=github.com/landflow/landflow/sdks/go

protoc \
  -I "$PROTO_ROOT" \
  --go_out=. --go_opt=module="$MODULE" \
  --go-grpc_out=. --go-grpc_opt=module="$MODULE" \
  landflow/plugin/v1/plugin.proto

echo "generated: $(cd landflowpb && ls *.pb.go | tr '\n' ' ')"
