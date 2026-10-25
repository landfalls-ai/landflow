# syntax=docker/dockerfile:1
#
# Landflow code runner (services/code-runner): runs Code node snippets, JavaScript on Node and Python on CPython
# with the standard library only, each in a fresh, locked-down child process. Build context: the repository root.
#
#   docker build -f deploy/docker/code-runner.Dockerfile -t landflow/code-runner:dev .
#
# Run it the way deploy/compose.yml does, because the container is the security boundary: only an internal network
# (no egress), read-only root filesystem with a noexec tmpfs /tmp, no capabilities, no-new-privileges, and pids,
# memory and CPU limits. Inside, each snippet also gets rlimits (CPU seconds, file size, address space for Python),
# a memory watch, Node's permission model (files, processes, network) or a Python audit hook, and a timeout.
#
# Node 26 is the runtime because its permission model can deny the network (--allow-net, Node 25+); the build
# stages use the same Node 22 image as the host and plugins, so their layers and pnpm store are shared.

ARG BUILD_IMAGE=node:22.23.2-alpine3.24
ARG NODE_IMAGE=node:26.12.1-alpine3.24

FROM ${BUILD_IMAGE} AS pnpm
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

# esbuild bundles src/ into dist/main.mjs and dist/forward.mjs: no TypeScript tooling at runtime.
FROM pnpm AS build
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,id=landflow-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@landflow/code-runner"
COPY services/code-runner ./services/code-runner
RUN pnpm --filter @landflow/code-runner build \
 && test -f services/code-runner/dist/main.mjs && test -f services/code-runner/dist/forward.mjs

# Production dependencies only: Luxon, which JavaScript snippets get as DateTime.
FROM pnpm AS deps
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,id=landflow-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --filter "@landflow/code-runner"

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="landflow-code-runner" \
      org.opencontainers.image.description="Landflow code runner: sandboxed JavaScript and Python for the Code node"
# CPython from Alpine (standard library; no pip), tzdata for zoneinfo. Package managers and their CLIs go: snippets
# can't start processes anyway, and the image needs nothing but node and python3.
RUN apk add --no-cache python3 tzdata \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && addgroup -S -g 10001 runner \
 && adduser -S -D -H -u 10001 -G runner -h /tmp -s /sbin/nologin runner \
 && python3 -I -S -c 'import sys; print("python", sys.version.split()[0])' && node --version
ENV NODE_ENV=production \
    CODE_RUNNER_HOST=0.0.0.0 \
    CODE_RUNNER_PORT=7300 \
    CODE_RUNNER_TMPDIR=/tmp \
    CODE_RUNNER_PYTHON=/usr/bin/python3 \
    CODE_RUNNER_IN_CONTAINER=1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/code-runner/node_modules ./services/code-runner/node_modules
COPY --from=build /app/services/code-runner/dist ./services/code-runner/dist
COPY services/code-runner/package.json ./services/code-runner/package.json
COPY services/code-runner/child ./services/code-runner/child
USER runner
WORKDIR /app/services/code-runner
EXPOSE 7300
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${CODE_RUNNER_PORT}/health" || exit 1
CMD ["node", "dist/main.mjs"]
