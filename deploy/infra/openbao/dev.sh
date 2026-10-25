#!/bin/sh
# OpenBao dev server plus Landflow's KV v2 mount at landflow/.
#
# Dev mode keeps everything in memory and starts unsealed with a fixed root token, so the
# mount and a sample secret are (re)created on every start; the healthcheck waits for them.
# Development only: never run dev mode with real secrets.
set -eu

export BAO_ADDR=http://127.0.0.1:8200
rm -f /tmp/landflow-ready

bao server -dev \
  -dev-listen-address=0.0.0.0:8200 \
  -dev-root-token-id="${BAO_DEV_ROOT_TOKEN_ID:?set BAO_DEV_ROOT_TOKEN_ID}" \
  -dev-no-store-token &
server=$!
trap 'kill -TERM "$server" 2>/dev/null || true' TERM INT

until bao status >/dev/null 2>&1; do
  kill -0 "$server" 2>/dev/null || exit 1
  sleep 0.5
done

export BAO_TOKEN="$BAO_DEV_ROOT_TOKEN_ID"
if ! bao secrets list -format=json | grep -q '"landflow/"'; then
  bao secrets enable -path=landflow -version=2 -description="Landflow secrets (dev)" kv
fi
bao kv put -mount=landflow dev/hello message="OpenBao KV v2 at landflow/ is ready" >/dev/null
touch /tmp/landflow-ready
echo "landflow: KV v2 mounted at landflow/ (sample secret landflow/dev/hello)"

wait "$server" || true
wait "$server" 2>/dev/null || true
