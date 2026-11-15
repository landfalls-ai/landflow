#!/usr/bin/env bash
# Checks the LiteLLM image the llm-gateway service pins (deploy/compose.infra.yml): the tag is not one of the forbidden ones
# (v1.107.0 and its variants, latest, main-latest, main-stable, -nightly, -dev; see the 21 October 2026 compromise), the image
# is pinned by @sha256, the pinned cosign.pub still has the expected SHA-256 (the key rotated on 23 October), and cosign
# verifies the image's signature with it. Exits 2 when cosign is not installed. Needs network (ghcr.io, raw.githubusercontent.com).
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
compose="$root/deploy/compose.infra.yml"
key_url="https://raw.githubusercontent.com/BerriAI/litellm/e82a3c646908ba0a6ee0beddc4310d7a6cac4065/cosign.pub"
key_sha256="e3fe3e08c44b16407fe0b37c43b4f8b603b3a0f4ee74c29e647bc022d762c2c0"

image="$(awk '/^  llm-gateway:/{f=1;next} f&&/^  [a-z]/{f=0} f&&/^    image:/{print $2; exit}' "$compose")"
[ -n "$image" ] || { echo "no image: line found for the llm-gateway service in $compose" >&2; exit 1; }
echo "image: $image"

tag="${image#*:}"; tag="${tag%%@*}"
case "$tag" in
  v1.107.0|v1.107.0-*|latest|main-latest|main-stable|*-nightly*|*-dev*)
    echo "forbidden tag: $tag" >&2; exit 1 ;;
esac
case "$image" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "the image is not pinned by @sha256:<64 hex>" >&2; exit 1 ;;
esac

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$key_url" -o "$tmp/cosign.pub"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/cosign.pub" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/cosign.pub" | cut -d' ' -f1)"; fi
[ "$got" = "$key_sha256" ] || { echo "cosign.pub has SHA-256 $got, expected $key_sha256" >&2; exit 1; }

if ! command -v cosign >/dev/null 2>&1; then
  echo "cosign is not installed: tag and digest checks passed, the signature was not verified" >&2
  exit 2
fi
cosign verify --key "$tmp/cosign.pub" "$image"
echo "verified"
