# syntax=docker/dockerfile:1
#
# Landflow host: apps/web (Next.js 16) plus the workspace packages it bundles
# (@landflow/protocol, sdk, engine), built as Next's standalone output and run as
# a non-root user. Build context: the repository root.
#
#   docker build -f deploy/docker/host.Dockerfile -t landflow/host:dev .
#   docker run -p 53000:3000 -v landflow-data:/data -e LANDFLOW_ENCRYPTION_KEY=... landflow/host:dev
#
# Runtime: HTTP on :3000 (UI + API), the gRPC RegistryService on :7070, workflows,
# executions and the credentials vault under /data (LANDFLOW_DATA_DIR).

ARG NODE_IMAGE=node:22.23.2-alpine3.24

FROM ${NODE_IMAGE} AS pnpm
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
# The version from package.json's "packageManager".
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app

# Only the workspace manifests and the lockfile: the install layer below is reused
# until one of them changes, not on every source edit.
FROM pnpm AS manifests
COPY . /src
RUN cd /src && mkdir /manifests \
 && find . -name package.json -not -path '*/node_modules/*' \
    | tar -cf - -T - pnpm-lock.yaml pnpm-workspace.yaml | tar -xf - -C /manifests

FROM pnpm AS deps
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,id=landflow-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@landflow/web..."

FROM deps AS build
COPY . .
# Turns on `output: 'standalone'` in apps/web/next.config.ts.
ENV LANDFLOW_NEXT_OUTPUT=standalone
RUN pnpm --filter @landflow/web build \
 && test -f apps/web/.next/standalone/apps/web/server.js

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="landflow-host" \
      org.opencontainers.image.description="Landflow host: UI, API, engine and plugin registry (Next.js standalone)"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    LANDFLOW_DATA_DIR=/data
WORKDIR /app
# /data is created here so a fresh named volume inherits the node user's ownership.
RUN mkdir -p /data && chown node:node /data
# Standalone output mirrors the monorepo (tracing root = repo root): server at apps/web/server.js.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
VOLUME ["/data"]
EXPOSE 3000 7070
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1
WORKDIR /app/apps/web
CMD ["node", "server.js"]
