# syntax=docker/dockerfile:1
#
# The common image for Landflow's Claude Code agents on kagent (docs/a2a.md, "A toolchain image for Claude Code"): kagent's
# claude-harness with the toolchains most projects need, so a run starts with them instead of spending time and tokens
# installing them. Nothing project-specific is in it: a project's own dependencies come over the network when the agent
# installs them, through the package cache (landflow-cache, the only origin deploy/kind/egress-dev.yaml allows). The tools
# are pointed at the cache by env in deploy/kind/harness-claude-dev.yaml; apk's repositories are rewritten here.
#
#   Go          the latest release, with its standard library already built (GOCACHE=/opt/go-build, so the first build in a
#               sandbox doesn't compile std again); a project that asks for another release fetches it through the module
#               proxy (GOTOOLCHAIN=auto)
#   Node        22, npm, and pnpm and Yarn through Corepack (pnpm is prepared here)
#   Python      3.12, pip and uv
#   C           gcc, make and musl headers (build-base), for cgo and native npm and Python packages
#   tools       curl, jq, ripgrep, unzip, openssh-client (git is in the base image)
#   Claude Code a newer release than the base image's (2.1.285), for mods: Landflow's landflow-harness mod needs 2.1.287
#               or later (apps/web/claude-plugins/landflow-harness)
#
# deploy/scripts/claude-harness-dev.sh builds it, puts it in Landflow's registry (kagent pulls by digest; nothing is pushed)
# and applies the Harness landflow-claude-dev that runs it. Build context: the repository root (nothing is copied from it).

ARG HARNESS_IMAGE=ghcr.io/kagent-dev/kagent/claude-harness@sha256:69cbd021825de5b6798723c96a4ae72f78a4916e70e4f1cd7f6bd5678e6641ff
ARG GO_IMAGE=golang:1.27.0-alpine3.24
ARG PNPM_VERSION=10.28.2
ARG CLAUDE_CODE_VERSION=2.1.316
# Where apk fetches from once the image runs: the cache's /apk/ mirror of dl-cdn.alpinelinux.org, as kind's DNS names it
# (deploy/kind/bridge.yaml). The build itself installs from Alpine directly.
ARG APK_CACHE=http://landflow-cache.landflow.svc.cluster.local:8080/apk

FROM ${GO_IMAGE} AS go

FROM ${HARNESS_IMAGE}
ARG PNPM_VERSION
ARG CLAUDE_CODE_VERSION
ARG APK_CACHE
USER root
RUN apk add --no-cache nodejs npm python3 py3-pip uv build-base curl jq ripgrep unzip openssh-client
COPY --from=go /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:/usr/local/share/go/bin:$PATH \
    GOPATH=/usr/local/share/go \
    GOCACHE=/opt/go-build \
    COREPACK_HOME=/usr/local/share/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g --no-fund --no-audit corepack@latest \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && mkdir -p "$GOPATH" "$GOCACHE" \
 && go build std \
 && chmod -R a+rwX "$GOPATH" "$COREPACK_HOME" "$GOCACHE" \
 && sed -i -E "s#https?://dl-cdn\\.alpinelinux\\.org/alpine#${APK_CACHE}#" /etc/apk/repositories \
 && go version && node --version && pnpm --version && python3 --version && uv --version
# Claude Code from npm (the native binary for this platform, linux-arm64-musl here) in place of the base image's.
# kagent 1.0's harness pins the release it was verified on (PinnedClaudeVersion 2.1.285, strict) and refuses to start
# unless `claude --version` names it, with no setting to change that. So `claude` is a wrapper whose version line names
# both: "2.1.316 (Claude Code) (kagent pin 2.1.285)"; everything else goes to the binary as it is.
RUN rm -f /usr/local/bin/claude \
 && npm install -g --no-fund --no-audit @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && rm -f /usr/local/bin/claude
COPY --chmod=755 <<'EOF' /usr/local/bin/claude
#!/bin/sh
real=/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  echo "$("$real" --version) (kagent pin ${KAGENT_CLAUDE_PIN:-2.1.285})"
  exit 0
fi
exec "$real" "$@"
EOF
RUN claude --version | grep -q "^${CLAUDE_CODE_VERSION} .*kagent pin 2.1.285"
USER 65532:65532
