# syntax=docker/dockerfile:1
#
# The Desktop plugin (plugins/desktop, package @landflow/plugin-desktop) with the Docker CLI. It starts the disposable
# desktops (services/desktop-sandbox, image landflow/desktop-sandbox:dev) on the Docker engine whose socket is mounted
# into it, so it is only for the local compose stack: see deploy/compose.yml (profile `desktop`) and docs/deployment.md
# "Desktop". Build context: the repository root.
#
#   docker build -f plugins/desktop/Dockerfile --build-arg HTTP_PORT=7117 --build-arg GRPC_PORT=7217 \
#     -t landflow/plugin-desktop:dev .
ARG NODE_IMAGE=node:22.23.2-bookworm-slim
ARG DOCKER_CLI_IMAGE=docker:27-cli

FROM ${DOCKER_CLI_IMAGE} AS dockercli

FROM ${NODE_IMAGE} AS pnpm
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app

FROM pnpm AS manifests
COPY . /src
RUN cd /src && mkdir /manifests \
 && find . -name package.json -not -path '*/node_modules/*' \
    | tar -cf - -T - pnpm-lock.yaml pnpm-workspace.yaml patches | tar -xf - -C /manifests

FROM pnpm AS deps
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,id=landflow-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --shamefully-hoist --store-dir /pnpm/store --filter "@landflow/plugin-desktop..."

FROM ${NODE_IMAGE} AS runtime
ARG HTTP_PORT=7117
ARG GRPC_PORT=7217
ARG TSX_VERSION=4.23.15
LABEL org.opencontainers.image.title="landflow-plugin-desktop"
RUN npm install -g --no-audit --no-fund "tsx@${TSX_VERSION}" && npm cache clean --force
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
ENV NODE_ENV=production LANDFLOW_HTTP_PORT=${HTTP_PORT} LANDFLOW_GRPC_PORT=${GRPC_PORT} LANDFLOW_HOST=0.0.0.0 HOME=/tmp/home
WORKDIR /app
COPY --from=deps /app ./
COPY packages/protocol ./packages/protocol
COPY packages/sdk ./packages/sdk
COPY packages/transports ./packages/transports
COPY plugins/desktop ./plugins/desktop
# Root, because the Docker socket is root's (or its group's); the plugin never runs a shell and each sandbox it starts is
# unprivileged. Still: whoever can call this plugin can start containers. Keep it off a shared host.
USER root
WORKDIR /app/plugins/desktop
EXPOSE ${HTTP_PORT} ${GRPC_PORT}
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.LANDFLOW_HTTP_PORT+'/landflow/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["tsx", "src/main.ts"]
