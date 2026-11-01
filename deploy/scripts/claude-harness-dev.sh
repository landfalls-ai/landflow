#!/usr/bin/env bash
# The common toolchain image for Landflow's Claude Code agents on kagent (docs/a2a.md, "A toolchain image for Claude Code"),
# on this machine only:
#
#   1. builds deploy/docker/claude-harness-dev.Dockerfile on the OrbStack engine (--load; nothing is pushed);
#   2. puts its blobs in Landflow's own registry store (LANDFLOW_DATA_DIR/oci on the host's volume), which serves them at
#      /v2 by digest, as it serves Claude Code plugins;
#   3. applies the Harness landflow-claude-dev in the landflow-kagent kind cluster: kagent's Claude runtime with
#      workload.image = that image, pinned by digest at the Landflow Service's private IP (atelet pulls it over plain HTTP).
#
# Run it after kagent-up.sh, and again when the Dockerfile changes (a new digest; agents on the Harness get it on their
# next deploy). An agent runs on it when its kagent card's Runtime is "Claude Code · landflow-claude-dev".
set -euo pipefail
cd "$(dirname "$0")/../.."

NS=${LANDFLOW_NAMESPACE:-landflow-dev}
CLUSTER=${KIND_CLUSTER:-landflow-kagent}
IMAGE=landflow/claude-harness-dev:dev
REPOSITORY=runtimes/claude-harness-dev
step() { printf '\n== %s\n' "$*"; }
orb() { kubectl --context orbstack "$@"; }
k() { kubectl --context "kind-$CLUSTER" "$@"; }

step "build $IMAGE"
COMPOSE_BAKE=false docker --context orbstack buildx build --builder orbstack --load -f deploy/docker/claude-harness-dev.Dockerfile -t "$IMAGE" . >/dev/null

step "save it as an OCI layout"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
docker --context orbstack save "$IMAGE" -o "$WORK/image.tar"
mkdir "$WORK/layout"
tar -C "$WORK/layout" -xf "$WORK/image.tar"
# index.json names the image: a manifest, or an index with one manifest per platform (kind's node is linux/arm64 here).
DIGEST=$(python3 - "$WORK/layout" <<'PY'
import json, os, platform, sys
root = sys.argv[1]
blob = lambda d: json.load(open(os.path.join(root, 'blobs', *d.split(':'))))
arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'amd64'}.get(platform.machine(), 'arm64')
entry = json.load(open(os.path.join(root, 'index.json')))['manifests'][0]
while 'index' in entry.get('mediaType', '') or 'manifest.list' in entry.get('mediaType', ''):
    entry = next(m for m in blob(entry['digest'])['manifests'] if m.get('platform', {}).get('architecture') == arch and m.get('platform', {}).get('os') == 'linux')
print(entry['digest'])
PY
)
echo "manifest $DIGEST"

step "put its blobs in Landflow's registry store"
POD=$(orb -n "$NS" get pod -l app.kubernetes.io/name=landflow-host -o jsonpath='{.items[0].metadata.name}')
# blobs/sha256/<hex> in the layout, sha256-<hex> in the store (lib/server/kagent/oci.ts); existing ones are kept.
# COPYFILE_DISABLE and --no-mac-metadata keep macOS's AppleDouble ._ files out; only sha256 names are moved in.
COPYFILE_DISABLE=1 tar --no-mac-metadata -C "$WORK/layout/blobs/sha256" -cf - . | orb -n "$NS" exec -i "$POD" -c host -- sh -c '
  set -e; store=${LANDFLOW_DATA_DIR:-/data}/oci/blobs; rm -rf "$store/.in"; mkdir -p "$store/.in"; tar -C "$store/.in" -xf -
  for f in "$store"/.in/*; do h=$(basename "$f"); case "$h" in *[!0-9a-f]*) continue ;; esac; [ ${#h} -eq 64 ] || continue
    [ -e "$store/sha256-$h" ] && rm "$f" || mv "$f" "$store/sha256-$h"; done
  rm -rf "$store/.in"'
HOST_IP=$(orb -n "$NS" get svc landflow-host -o jsonpath='{.spec.clusterIP}')
REF="$HOST_IP:3000/$REPOSITORY@$DIGEST"
orb -n "$NS" exec "$POD" -c host -- wget -q -O /dev/null "http://127.0.0.1:3000/v2/$REPOSITORY/manifests/$DIGEST"
echo "served as $REF"

step "Harness landflow-claude-dev"
sed "s|image: .*# set by claude-harness-dev.sh|image: $REF  # set by claude-harness-dev.sh|" deploy/kind/harness-claude-dev.yaml | k apply -f - >/dev/null
k -n kagent get harness landflow-claude-dev
