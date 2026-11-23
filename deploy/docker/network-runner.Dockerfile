# syntax=docker/dockerfile:1
#
# Landflow network runner (services/network-runner, docs/network-runners.md): serves the HTTP Request node's calls from
# inside a private network. It dials out to the host over HTTPS and listens on nothing: publish no port. Build context:
# the repository root. Build it locally; it is never pushed.
#
#   COMPOSE_BAKE=false docker --context orbstack buildx build --builder orbstack --load \
#     -f deploy/docker/network-runner.Dockerfile -t landflow-network-runner .
#
# Configured by environment variables only: LANDFLOW_URL (the host; https, or http for localhost and
# host.docker.internal), LANDFLOW_RUNNER_TOKEN (Settings → Networks → Register runner), LANDFLOW_RUNNER_ALLOW (the hosts,
# addresses and CIDR ranges it may reach; empty refuses everything), LANDFLOW_RUNNER_NAME, LANDFLOW_RUNNER_CONCURRENCY.

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
    | tar -cf - -T - pnpm-lock.yaml pnpm-workspace.yaml patches | tar -xf - -C /manifests

# esbuild bundles src/ into dist/main.mjs: the runner has no runtime dependency, so the image holds that one file.
FROM pnpm AS build
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,id=landflow-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@landflow/network-runner"
COPY services/network-runner ./services/network-runner
RUN pnpm --filter @landflow/network-runner build && test -f services/network-runner/dist/main.mjs

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="landflow-network-runner" \
      org.opencontainers.image.description="Landflow network runner: the HTTP Request node, run inside a private network"
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && addgroup -S -g 10001 runner && adduser -S -D -H -u 10001 -G runner -s /sbin/nologin runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/services/network-runner/dist/main.mjs ./main.mjs
USER runner
CMD ["node", "main.mjs"]
