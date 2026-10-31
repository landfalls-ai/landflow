# syntax=docker/dockerfile:1
#
# The common image for Landflow's Claude Code agents on kagent (docs/a2a.md, "A toolchain image for Claude Code"): kagent's
# claude-harness with the toolchains most projects need, so a run starts with them instead of spending time and tokens
# installing them. Nothing project-specific is in it: a project's own dependencies come over the network when the agent
# installs them (the package registries in deploy/kind/egress-dev.yaml).
#
#   Go          the latest release; a project that asks for another fetches it through the module proxy (GOTOOLCHAIN=auto)
#   Node        22, npm, and pnpm and Yarn through Corepack (pnpm is prepared here)
#   Python      3.12, pip and uv
#   C           gcc, make and musl headers (build-base), for cgo and native npm and Python packages
#   tools       curl, jq, ripgrep, unzip, openssh-client (git is in the base image)
#
# deploy/scripts/claude-harness-dev.sh builds it, puts it in Landflow's registry (kagent pulls by digest; nothing is pushed)
# and applies the Harness landflow-claude-dev that runs it. Build context: the repository root (nothing is copied from it).

ARG HARNESS_IMAGE=ghcr.io/kagent-dev/kagent/claude-harness@sha256:69cbd021825de5b6798723c96a4ae72f78a4916e70e4f1cd7f6bd5678e6641ff
ARG GO_IMAGE=golang:1.27.0-alpine3.24
ARG PNPM_VERSION=10.28.2

FROM ${GO_IMAGE} AS go

FROM ${HARNESS_IMAGE}
ARG PNPM_VERSION
USER root
RUN apk add --no-cache nodejs npm python3 py3-pip uv build-base curl jq ripgrep unzip openssh-client
COPY --from=go /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:/usr/local/share/go/bin:$PATH \
    GOPATH=/usr/local/share/go \
    COREPACK_HOME=/usr/local/share/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g --no-fund --no-audit corepack@latest \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && mkdir -p "$GOPATH" && chmod -R a+rwX "$GOPATH" "$COREPACK_HOME" \
 && go version && node --version && pnpm --version && python3 --version && uv --version
USER 65532:65532
