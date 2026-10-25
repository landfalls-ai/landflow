# syntax=docker/dockerfile:1
#
# A TypeScript Landflow plugin (plugins/<PLUGIN>, package @landflow/plugin-<PLUGIN>) with the
# workspace SDK, run from source with tsx exactly as `pnpm plugin:*` does. Build context: the
# repository root.
#
#   docker build -f deploy/docker/node-plugin.Dockerfile \
#     --build-arg PLUGIN=text-toolkit --build-arg HTTP_PORT=7101 --build-arg GRPC_PORT=7201 \
#     -t landflow/plugin-text-toolkit:dev .
#
# It serves HTTP and gRPC and announces itself to LANDFLOW_REGISTRY_URL with
# LANDFLOW_ADVERTISE_HOST in its endpoints (set both when you run it; see deploy/compose.yml).

ARG NODE_IMAGE=node:22.23.2-alpine3.24

FROM ${NODE_IMAGE} AS pnpm
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app

FROM pnpm AS manifests
COPY . /src
RUN cd /src && mkdir /manifests \
 && find . -name package.json -not -path '*/node_modules/*' \
    | tar -cf - -T - pnpm-lock.yaml pnpm-workspace.yaml | tar -xf - -C /manifests

# Production dependencies of the plugin and its workspace packages (sdk, protocol).
FROM pnpm AS deps
ARG PLUGIN
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,id=landflow-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --filter "@landflow/plugin-${PLUGIN}..."

FROM ${NODE_IMAGE} AS runtime
ARG PLUGIN
ARG HTTP_PORT
ARG GRPC_PORT
# tsx is a dev dependency of the plugins; the runtime gets the lockfile's version globally.
ARG TSX_VERSION=4.23.15
LABEL org.opencontainers.image.title="landflow-plugin-${PLUGIN}" \
      org.opencontainers.image.description="Landflow plugin ${PLUGIN} (TypeScript SDK)"
RUN npm install -g --no-audit --no-fund "tsx@${TSX_VERSION}" && npm cache clean --force
ENV NODE_ENV=production \
    LANDFLOW_HTTP_PORT=${HTTP_PORT} \
    LANDFLOW_GRPC_PORT=${GRPC_PORT}
WORKDIR /app
COPY --from=deps /app ./
COPY packages/protocol ./packages/protocol
COPY packages/sdk ./packages/sdk
COPY plugins/${PLUGIN} ./plugins/${PLUGIN}
USER node
WORKDIR /app/plugins/${PLUGIN}
EXPOSE ${HTTP_PORT} ${GRPC_PORT}
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${LANDFLOW_HTTP_PORT}/landflow/v1/health" || exit 1
CMD ["tsx", "src/main.ts"]
