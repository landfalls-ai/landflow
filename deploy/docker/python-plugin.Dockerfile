# syntax=docker/dockerfile:1
#
# A Python Landflow plugin (plugins/<PLUGIN>/main.py) with the Python SDK and its gRPC and
# OpenTelemetry extras, in a virtualenv. Build context: the repository root.
#
#   docker build -f deploy/docker/python-plugin.Dockerfile \
#     --build-arg PLUGIN=py-insights --build-arg HTTP_PORT=7102 --build-arg GRPC_PORT=7202 \
#     -t landflow/plugin-py-insights:dev .
#
# It serves HTTP and gRPC and announces itself to LANDFLOW_REGISTRY_URL with
# LANDFLOW_ADVERTISE_HOST in its endpoints (set both when you run it; see deploy/compose.yml).

ARG PYTHON_IMAGE=python:3.13-slim

FROM ${PYTHON_IMAGE} AS build
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1
RUN python -m venv /opt/venv
COPY sdks/python /src/sdks/python
RUN /opt/venv/bin/pip install "/src/sdks/python[grpc,otel]" \
 && /opt/venv/bin/python -c 'import landflow_sdk, landflow_sdk.grpc_server, grpc; print("landflow-sdk", landflow_sdk.__version__, "grpcio", grpc.__version__)'

FROM ${PYTHON_IMAGE} AS runtime
ARG PLUGIN
ARG HTTP_PORT
ARG GRPC_PORT
LABEL org.opencontainers.image.title="landflow-plugin-${PLUGIN}" \
      org.opencontainers.image.description="Landflow plugin ${PLUGIN} (Python SDK)"
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin landflow
COPY --from=build /opt/venv /opt/venv
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
