#!/bin/sh
# Mount OpenBao's database secrets engine in the local development OpenBao (landflow-infra) and give it a role that makes
# short-lived Postgres logins in the infra Postgres: what Landflow's dynamic secrets (docs/features/secrets-and-environments.md
# #dynamic-secrets) are checked against. Idempotent: running it again changes nothing that is already set.
#
#   docker compose -p landflow-infra -f deploy/compose.infra.yml up -d postgres openbao
#   deploy/scripts/openbao-db-engine.sh                       # database landflow_test, role report-reader
#   LANDFLOW_LEASES_DB=my_scratch_db deploy/scripts/openbao-db-engine.sh
#
# It changes only the in-memory dev OpenBao (gone when the container stops) and, through the roles OpenBao later creates,
# adds logins to that one database for the length of a lease. Development credentials only (deploy/.env.example); it talks
# to the loopback port of the compose service and refuses any other address.
set -eu

BAO="${LANDFLOW_OPENBAO_URL:-http://127.0.0.1:${LANDFLOW_OPENBAO_PORT:-58200}}"
TOKEN="${LANDFLOW_OPENBAO_ROOT_TOKEN:-landflow-dev-root-token}"
DB_USER="${LANDFLOW_POSTGRES_USER:-landflow}"
DB_PASSWORD="${LANDFLOW_POSTGRES_PASSWORD:-landflow-dev-only}"
DB_NAME="${LANDFLOW_LEASES_DB:-landflow_test}"
# The host name OpenBao (in its container, on the landflow-infra network) uses for Postgres.
DB_HOST="${LANDFLOW_LEASES_PG_HOST:-postgres}"
MOUNT="${LANDFLOW_LEASES_MOUNT:-database}"
ROLE="${LANDFLOW_LEASES_ROLE:-report-reader}"

case "$BAO" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "refusing $BAO: this script only talks to the local development OpenBao" >&2; exit 1 ;;
esac

call() { # method path [json body] -> prints the body, fails on an HTTP error
  method="$1"; path="$2"; body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" -H "X-Vault-Token: $TOKEN" -H 'Content-Type: application/json' -d "$body" "$BAO/v1/$path"
  else
    curl -fsS -X "$method" -H "X-Vault-Token: $TOKEN" "$BAO/v1/$path"
  fi
}

if ! curl -fsS "$BAO/v1/sys/health" >/dev/null 2>&1; then
  echo "OpenBao is not answering at $BAO: docker compose -p landflow-infra -f deploy/compose.infra.yml up -d openbao" >&2
  exit 1
fi

# The engine, once.
if call GET sys/mounts | grep -q "\"$MOUNT/\""; then
  echo "mount $MOUNT/ is already there"
else
  call POST "sys/mounts/$MOUNT" '{"type":"database"}' >/dev/null
  echo "mounted the database engine at $MOUNT/"
fi

# The connection (set again every time: it is a PUT of the same values). OpenBao replaces {{username}} and {{password}}.
call POST "$MOUNT/config/landflow-pg" "{\"plugin_name\":\"postgresql-database-plugin\",\"allowed_roles\":\"$ROLE\",\"connection_url\":\"postgresql://{{username}}:{{password}}@$DB_HOST:5432/$DB_NAME?sslmode=disable\",\"username\":\"$DB_USER\",\"password\":\"$DB_PASSWORD\"}" >/dev/null
echo "connection landflow-pg -> $DB_HOST:5432/$DB_NAME"

# The role: a login that can read the public schema, 15 minutes by default, an hour at most.
call POST "$MOUNT/roles/$ROLE" "{\"db_name\":\"landflow-pg\",\"creation_statements\":\"CREATE ROLE \\\"{{name}}\\\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT ON ALL TABLES IN SCHEMA public TO \\\"{{name}}\\\";\",\"default_ttl\":\"15m\",\"max_ttl\":\"1h\"}" >/dev/null
echo "role $ROLE: 15 minutes, at most 1 hour (read $MOUNT/creds/$ROLE)"
