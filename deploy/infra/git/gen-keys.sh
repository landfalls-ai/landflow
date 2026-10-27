#!/bin/sh
# Generates the dev-only key pairs for the `git` compose profile into deploy/infra/git/keys (git-ignored):
#   id_ed25519 (Landflow's key: give it to a "SSH private key" credential) and id_ed25519_passphrase (passphrase "landflow-dev-only").
# Run once; existing keys are kept. Never use these keys anywhere else.
set -eu
dir="$(cd "$(dirname "$0")" && pwd)/keys"
mkdir -p "$dir"
[ -f "$dir/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C 'landflow-dev-only' -f "$dir/id_ed25519"
[ -f "$dir/id_ed25519_passphrase" ] || ssh-keygen -q -t ed25519 -N 'landflow-dev-only' -C 'landflow-dev-only-passphrase' -f "$dir/id_ed25519_passphrase"
echo "keys in $dir"
