#!/bin/sh
# MinIO server plus Landflow's bucket. The bucket is created (idempotently) on every start, so
# it comes back after a volume reset; the healthcheck waits for it. No separate init container,
# which keeps `docker compose up --wait` happy.
set -eu

rm -f /tmp/landflow-ready
minio server /data --address :9000 --console-address :9001 &
server=$!
trap 'kill -TERM "$server" 2>/dev/null || true' TERM INT

until curl -fsS -o /dev/null http://127.0.0.1:9000/minio/health/ready; do
  kill -0 "$server" 2>/dev/null || exit 1
  sleep 0.5
done

mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing "local/${LANDFLOW_BUCKET:-landflow}"
touch /tmp/landflow-ready

wait "$server" || true
wait "$server" 2>/dev/null || true
