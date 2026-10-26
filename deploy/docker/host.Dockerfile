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
# executions and the credentials vault under /data (LANDFLOW_DATA_DIR). Queue mode: the
# same image runs a worker with `node worker.mjs` (health and metrics on :5690).

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
# pulsar-client's package.json has a node-pre-gyp "binary" block without `napi_versions`, which Turbopack's externals tracing
# rejects ("missing field `napi_versions`": the production build panics). The prebuilt binary is already installed; the field
# only has to exist for the trace to read the block.
RUN for f in /app/node_modules/.pnpm/pulsar-client@*/node_modules/pulsar-client/package.json; do \
      node -e "const fs=require('fs');const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,'utf8'));if(p.binary&&!p.binary.napi_versions){p.binary.napi_versions=[6];fs.writeFileSync(f,JSON.stringify(p,null,2))}" "$f"; \
    done
RUN pnpm --filter @landflow/web build \
 && test -f apps/web/.next/standalone/apps/web/server.js
# Put package.json back as published (with the field, node-pre-gyp wants a different module_path at run time), in the store
# and in the standalone copy.
RUN for f in /app/node_modules/.pnpm/pulsar-client@*/node_modules/pulsar-client/package.json /app/apps/web/.next/standalone/node_modules/.pnpm/pulsar-client@*/node_modules/pulsar-client/package.json; do \
      [ -f "$f" ] && node -e "const fs=require('fs');const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,'utf8'));if(p.binary)delete p.binary.napi_versions;fs.writeFileSync(f,JSON.stringify(p,null,2))" "$f"; \
    done; true
# Queue mode: the worker (`pnpm worker`, apps/web/src/lib/server/cluster/worker-main.ts) bundled into one file, so
# the same image runs mains (`node server.js`) and workers (`node worker.mjs`). The broker clients with native addons or
# file-based protos stay external (next.config.ts serverExternalPackages): the standalone output ships them, and the
# worker resolves them from apps/web/node_modules like the mains do.
RUN ESBUILD="$(ls -d /app/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | sort -V | tail -1)" \
 && cd apps/web && "$ESBUILD" src/lib/server/cluster/worker-main.ts --bundle --platform=node --format=esm --target=node22 \
    --tsconfig=tsconfig.json --outfile=dist/worker.mjs --log-level=warning \
    --external:@confluentinc/kafka-javascript --external:pulsar-client --external:@aws-sdk/client-sqs --external:@google-cloud/pubsub \
    --banner:js="import { createRequire as __lfCreateRequire } from 'node:module'; const require = __lfCreateRequire(import.meta.url);"

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
COPY --from=build --chown=node:node /app/apps/web/dist/worker.mjs ./apps/web/worker.mjs
# The worker bundle keeps the broker clients external (above). Next's standalone output ships them inside the pnpm store
# and reaches them through its own hashed aliases, which only the mains use: link them where /app/apps/web/worker.mjs finds
# them. The tracer also skips the native addons (kafka-javascript's build/, pulsar-client's lib/binding/), so they are
# copied whole from the build stage: the mains need them to open a Kafka or Pulsar connection as well.
RUN --mount=type=bind,from=build,source=/app/node_modules/.pnpm,target=/store \
    for m in @confluentinc/kafka-javascript pulsar-client @aws-sdk/client-sqs @google-cloud/pubsub; do \
      rel="$(cd /store && ls -d "$(echo "$m" | sed 's#/#+#')"@*/node_modules/"$m" | head -1)" \
      && dir="/app/node_modules/.pnpm/$rel" && mkdir -p "$dir" \
      && for native in build lib/binding; do \
           if [ -d "/store/$rel/$native" ]; then mkdir -p "$dir/$(dirname "$native")" && cp -a "/store/$rel/$native" "$dir/$native"; fi; \
         done \
      && mkdir -p "/app/node_modules/$(dirname "$m")" && ln -sfn "$dir" "/app/node_modules/$m" || exit 1; \
    done
USER node
VOLUME ["/data"]
# 5690: a worker's /healthz and /metrics (`node worker.mjs`, queue mode).
EXPOSE 3000 7070 5690
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1
WORKDIR /app/apps/web
CMD ["node", "server.js"]
