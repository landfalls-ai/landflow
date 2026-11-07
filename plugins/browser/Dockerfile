# syntax=docker/dockerfile:1
#
# The Browser plugin (plugins/browser, package @landflow/plugin-browser) with Chrome and Vercel's agent-browser CLI.
# A separate image on the code-runner pattern, not deploy/docker/node-plugin.Dockerfile: that one is Alpine and has no
# browser, and Chrome for Testing needs glibc, so this one is Debian. Build context: the repository root.
#
#   docker build -f plugins/browser/Dockerfile \
#     --build-arg HTTP_PORT=7112 --build-arg GRPC_PORT=7212 -t landflow/plugin-browser:dev .
#
# In a container the browser always runs headless (there is no display; LANDFLOW_BROWSER_HEADED is for a desktop).
# Run it the way deploy/compose.yml does (profile `browser`): read-only root filesystem, a tmpfs /tmp and HOME, no
# capabilities. Chrome's own sandbox needs privileges the container drops, so the container is the boundary and Chrome
# starts with --no-sandbox (AGENT_BROWSER_ARGS). Set LANDFLOW_BROWSER_ALLOWED_DOMAINS: see docs/deployment.md "Browser".
#
# Not built or run when this file was written: the agent-browser install step (and whether it honours
# AGENT_BROWSER_HOME and AGENT_BROWSER_ARGS) is the first thing to check on the first build.

ARG NODE_IMAGE=node:22.23.2-bookworm-slim

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

FROM pnpm AS deps
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,id=landflow-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --shamefully-hoist --store-dir /pnpm/store --filter "@landflow/plugin-browser..."

FROM ${NODE_IMAGE} AS runtime
ARG HTTP_PORT=7112
ARG GRPC_PORT=7212
ARG TSX_VERSION=4.23.15
# Pin it (for example 0.1.0) for a reproducible image.
ARG AGENT_BROWSER_VERSION=latest
LABEL org.opencontainers.image.title="landflow-plugin-browser" \
      org.opencontainers.image.description="Landflow Browser plugin with Chrome and the agent-browser CLI (headless)"
# The CLI, its Chrome and the system libraries Chrome needs (--with-deps runs apt as root), installed into a fixed,
# world-readable directory so the unprivileged user finds them on a read-only root filesystem.
ENV AGENT_BROWSER_HOME=/opt/agent-browser \
    PLAYWRIGHT_BROWSERS_PATH=/opt/agent-browser/browsers
RUN npm install -g --no-audit --no-fund "tsx@${TSX_VERSION}" "agent-browser@${AGENT_BROWSER_VERSION}" \
 && agent-browser install --with-deps \
 && npm cache clean --force && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /opt/agent-browser
ENV NODE_ENV=production \
    LANDFLOW_HTTP_PORT=${HTTP_PORT} \
    LANDFLOW_GRPC_PORT=${GRPC_PORT} \
    LANDFLOW_HOST=0.0.0.0 \
    HOME=/tmp/home \
    AGENT_BROWSER_ARGS=--no-sandbox
WORKDIR /app
COPY --from=deps /app ./
COPY packages/protocol ./packages/protocol
COPY packages/sdk ./packages/sdk
COPY packages/transports ./packages/transports
COPY plugins/browser ./plugins/browser
USER node
WORKDIR /app/plugins/browser
EXPOSE ${HTTP_PORT} ${GRPC_PORT}
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.LANDFLOW_HTTP_PORT+'/landflow/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["tsx", "src/main.ts"]
