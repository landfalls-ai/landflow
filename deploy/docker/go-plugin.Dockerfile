# syntax=docker/dockerfile:1
#
# A Go Landflow plugin (plugins/<PLUGIN>, which replaces the SDK module with ../../sdks/go),
# built as a static binary (CGO off: SQLite is modernc.org/sqlite, pure Go) on Alpine.
# Build context: the repository root.
#
#   docker build -f deploy/docker/go-plugin.Dockerfile \
#     --build-arg PLUGIN=go-crypto --build-arg HTTP_PORT=7103 --build-arg GRPC_PORT=7203 \
#     -t landflow/plugin-go-crypto:dev .
#
# It serves HTTP and gRPC and announces itself to LANDFLOW_REGISTRY_URL with
# LANDFLOW_ADVERTISE_HOST in its endpoints (set both when you run it; see deploy/compose.yml).

ARG GO_IMAGE=golang:1.27.0-alpine3.24
ARG RUNTIME_IMAGE=alpine:3.24.2

FROM ${GO_IMAGE} AS build
ARG PLUGIN
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-trimpath
WORKDIR /src
# Module files first: the download layer survives source edits.
COPY sdks/go/go.mod sdks/go/go.sum ./sdks/go/
COPY plugins/${PLUGIN}/go.mod plugins/${PLUGIN}/go.sum ./plugins/${PLUGIN}/
WORKDIR /src/plugins/${PLUGIN}
RUN --mount=type=cache,id=landflow-gomod,target=/go/pkg/mod go mod download
COPY sdks/go /src/sdks/go
COPY plugins/${PLUGIN} /src/plugins/${PLUGIN}
RUN --mount=type=cache,id=landflow-gomod,target=/go/pkg/mod \
    --mount=type=cache,id=landflow-gobuild,target=/root/.cache/go-build \
    go build -ldflags="-s -w" -o /out/plugin .

FROM ${RUNTIME_IMAGE} AS runtime
ARG PLUGIN
ARG HTTP_PORT
ARG GRPC_PORT
LABEL org.opencontainers.image.title="landflow-plugin-${PLUGIN}" \
      org.opencontainers.image.description="Landflow plugin ${PLUGIN} (Go SDK)"
# ca-certificates: integrations call HTTPS APIs (Google). tzdata: time zones in date handling.
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -H -u 10001 -s /sbin/nologin landflow
COPY --from=build /out/plugin /usr/local/bin/landflow-plugin
ENV LANDFLOW_HTTP_PORT=${HTTP_PORT} \
    LANDFLOW_GRPC_PORT=${GRPC_PORT} \
    LANDFLOW_LISTEN_HOST=0.0.0.0
USER landflow
EXPOSE ${HTTP_PORT} ${GRPC_PORT}
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${LANDFLOW_HTTP_PORT}/landflow/v1/health" || exit 1
ENTRYPOINT ["/usr/local/bin/landflow-plugin"]
