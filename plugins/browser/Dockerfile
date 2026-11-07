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
# Built and run on 2026-11-07 (see docs/specs/17-notes/FinishPackaging.md). What the first build settled:
#  - `agent-browser install --with-deps` works in Debian bookworm on amd64 (apt libraries, then Chrome for Testing).
#  - Chrome for Testing has no Linux arm64 build (Apple Silicon builds natively): there the image installs Debian's
#    chromium package instead.
#  - AGENT_BROWSER_HOME is NOT honoured: the CLI installs Chrome under $HOME/.agent-browser/browsers. So the install runs
#    with HOME=/opt/agent-home, and a fixed symlink /opt/agent-browser/chrome points at the browser, which
#    AGENT_BROWSER_EXECUTABLE_PATH names (the runtime HOME is a tmpfs, where nothing is installed).
#  - AGENT_BROWSER_ARGS=--no-sandbox is honoured (documented as the --args flag's env form).

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
# Pinned to the version the image was built and run with; Chrome's version follows it.
ARG AGENT_BROWSER_VERSION=0.41.2
LABEL org.opencontainers.image.title="landflow-plugin-browser" \
      org.opencontainers.image.description="Landflow Browser plugin with Chrome and the agent-browser CLI (headless)"
# The CLI, its Chrome and the system libraries Chrome needs (--with-deps runs apt as root), installed into a fixed,
# world-readable directory so the unprivileged user finds them on a read-only root filesystem.
RUN npm install -g --no-audit --no-fund "tsx@${TSX_VERSION}" "agent-browser@${AGENT_BROWSER_VERSION}" \
 && mkdir -p /opt/agent-home /opt/agent-browser \
 && if [ "$(dpkg --print-architecture)" = "arm64" ]; then \
      apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation \
      && ln -s /usr/bin/chromium /opt/agent-browser/chrome; \
    else \
      HOME=/opt/agent-home agent-browser install --with-deps \
      && ln -s "$(find /opt/agent-home/.agent-browser/browsers -name chrome -type f | head -n1)" /opt/agent-browser/chrome; \
    fi \
 && npm cache clean --force && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /opt/agent-home /opt/agent-browser
ENV NODE_ENV=production \
    LANDFLOW_HTTP_PORT=${HTTP_PORT} \
    LANDFLOW_GRPC_PORT=${GRPC_PORT} \
    LANDFLOW_HOST=0.0.0.0 \
    HOME=/tmp/home \
    AGENT_BROWSER_EXECUTABLE_PATH=/opt/agent-browser/chrome \
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
