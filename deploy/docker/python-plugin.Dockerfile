# syntax=docker/dockerfile:1
#
# A Python Landflow plugin (plugins/<PLUGIN>/main.py) with the Python SDK and its extras (gRPC, OpenTelemetry, the MCP face, the native
# tier 1 broker drivers: Kafka, RabbitMQ, NATS/JetStream, Valkey), in a virtualenv, plus the landflow-bridge binary for the tier 2 kinds
# (MQTT, AMQP 1.0, SQS, Pub/Sub, Pulsar, Service Bus; serve() starts it when LANDFLOW_TRANSPORTS names one). Build context: the repository root.
#
#   docker build -f deploy/docker/python-plugin.Dockerfile \
#     --build-arg PLUGIN=py-insights --build-arg HTTP_PORT=7102 --build-arg GRPC_PORT=7202 \
#     -t landflow/plugin-py-insights:dev .
#
# It serves HTTP and gRPC (brokers only when LANDFLOW_TRANSPORTS names them; the plugin's own MCP face is for LANDFLOW_MCP=on with a
# LANDFLOW_MCP_TOKEN, off in compose and Kubernetes) and announces itself to LANDFLOW_REGISTRY_URL with
# LANDFLOW_ADVERTISE_HOST in its endpoints (set both when you run it; see deploy/compose.yml).

ARG PYTHON_IMAGE=python:3.13-slim
ARG GO_IMAGE=golang:1.27.0-alpine3.24

# landflow-bridge, as in deploy/docker/bridge.Dockerfile (static, CGO off): about 50 MB of a ~410 MB image, so every Python plugin image can serve
# every broker kind. The Python SDK finds it on PATH.
FROM ${GO_IMAGE} AS bridge
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-trimpath
WORKDIR /src
# The whole Go tree (every nested driver module the bridge replaces), not just the module files: the list of driver modules grows with the kinds.
COPY sdks/go /src/sdks/go
COPY services/landflow-bridge /src/services/landflow-bridge
WORKDIR /src/services/landflow-bridge
RUN --mount=type=cache,id=landflow-gomod,target=/go/pkg/mod \
    --mount=type=cache,id=landflow-gobuild,target=/root/.cache/go-build \
    go build -ldflags="-s -w" -o /out/landflow-bridge .

FROM ${PYTHON_IMAGE} AS build
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1
RUN python -m venv /opt/venv
COPY sdks/python /src/sdks/python
RUN /opt/venv/bin/pip install "/src/sdks/python[grpc,otel,mcp,brokers]" \
 && /opt/venv/bin/python -c 'import landflow_sdk, landflow_sdk.grpc_server, grpc, mcp, confluent_kafka, pika, nats, valkey, cryptography; print("landflow-sdk", landflow_sdk.__version__, "grpcio", grpc.__version__)'

FROM ${PYTHON_IMAGE} AS runtime
ARG PLUGIN
ARG HTTP_PORT
ARG GRPC_PORT
LABEL org.opencontainers.image.title="landflow-plugin-${PLUGIN}" \
      org.opencontainers.image.description="Landflow plugin ${PLUGIN} (Python SDK)"
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin landflow
COPY --from=build /opt/venv /opt/venv
COPY --from=bridge /out/landflow-bridge /usr/local/bin/landflow-bridge
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LANDFLOW_HTTP_PORT=${HTTP_PORT} \
    LANDFLOW_GRPC_PORT=${GRPC_PORT} \
    LANDFLOW_BIND_HOST=0.0.0.0
WORKDIR /app
COPY plugins/${PLUGIN}/ ./
USER landflow
EXPOSE ${HTTP_PORT} ${GRPC_PORT}
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"LANDFLOW_HTTP_PORT\"]}/landflow/v1/health', timeout=3)" || exit 1
CMD ["python", "main.py"]
