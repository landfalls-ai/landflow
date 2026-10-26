# syntax=docker/dockerfile:1
#
# landflow-bridge (services/landflow-bridge): the Go sidecar that serves any landflow.plugin/v1 plugin (HTTP or gRPC,
# any SDK or none) over every broker driver. Built as a static binary on Alpine. Build context: the repository root.
#
#   docker build -f deploy/docker/bridge.Dockerfile -t landflow/bridge:dev .
#
# Run it next to a plugin (same pod, same compose network) with the Go SDK's variable names:
#   LANDFLOW_BRIDGE_TARGET=grpc://py-insights:7202 LANDFLOW_TRANSPORTS=nats LANDFLOW_NATS_URL=nats://nats:4222
#   LANDFLOW_TRANSPORT_SECRET=… [LANDFLOW_REGISTRY_SECRET=…]
# GET /healthz on LANDFLOW_BRIDGE_HEALTH_PORT (8080 here) is the health check.

ARG GO_IMAGE=golang:1.27.0-alpine3.24
ARG RUNTIME_IMAGE=alpine:3.24.2

FROM ${GO_IMAGE} AS build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-trimpath
WORKDIR /src
# Module files first: the download layer survives source edits. The bridge replaces the SDK and driver modules with the tree.
COPY sdks/go/go.mod sdks/go/go.sum ./sdks/go/
COPY sdks/go/transport/kafka/go.mod sdks/go/transport/kafka/go.sum ./sdks/go/transport/kafka/
COPY sdks/go/transport/amqp/go.mod sdks/go/transport/amqp/go.sum ./sdks/go/transport/amqp/
COPY sdks/go/transport/nats/go.mod sdks/go/transport/nats/go.sum ./sdks/go/transport/nats/
COPY sdks/go/transport/valkey/go.mod sdks/go/transport/valkey/go.sum ./sdks/go/transport/valkey/
COPY services/landflow-bridge/go.mod services/landflow-bridge/go.sum ./services/landflow-bridge/
WORKDIR /src/services/landflow-bridge
RUN --mount=type=cache,id=landflow-gomod,target=/go/pkg/mod go mod download
COPY sdks/go /src/sdks/go
COPY services/landflow-bridge /src/services/landflow-bridge
ARG VERSION=dev
RUN --mount=type=cache,id=landflow-gomod,target=/go/pkg/mod \
    --mount=type=cache,id=landflow-gobuild,target=/root/.cache/go-build \
    go build -ldflags="-s -w -X main.version=${VERSION}" -o /out/landflow-bridge .

FROM ${RUNTIME_IMAGE} AS runtime
LABEL org.opencontainers.image.title="landflow-bridge" \
      org.opencontainers.image.description="Landflow transport bridge: serves any plugin over every broker"
# ca-certificates: TLS to brokers (amqps, tls://, rediss). tzdata: log timestamps.
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -H -u 10001 -s /sbin/nologin landflow
COPY --from=build /out/landflow-bridge /usr/local/bin/landflow-bridge
ENV LANDFLOW_BRIDGE_HEALTH_PORT=8080 \
    LANDFLOW_BRIDGE_HEALTH_HOST=0.0.0.0
USER landflow
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${LANDFLOW_BRIDGE_HEALTH_PORT}/healthz" || exit 1
ENTRYPOINT ["/usr/local/bin/landflow-bridge"]
