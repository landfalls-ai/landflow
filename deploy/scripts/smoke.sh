#!/usr/bin/env bash
# Smoke-test the Landflow Docker stacks against their published ports.
#
#   deploy/scripts/smoke.sh infra   # Postgres+pgvector, Valkey, Mailpit, MinIO, OpenBao (+ Keycloak, Jaeger, MySQL if running)
#   deploy/scripts/smoke.sh app     # dockerised host: health, sign-in, plugins online, demo pipeline run, webhook
#   deploy/scripts/smoke.sh code    # code runner: health, and its isolation checked from inside snippets
#   deploy/scripts/smoke.sh         # all three
#
# Reads deploy/.env if present; otherwise the defaults from deploy/.env.example.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f .env ] && set -a && . ./.env && set +a

INFRA=(docker compose -f compose.infra.yml)
fails=0
pass() { printf '  \033[32mok\033[0m    %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fails=$((fails + 1)); }
check() { local name=$1; shift; if out=$("$@" 2>&1); then pass "$name ${out:+($out)}"; else fail "$name: $out"; fi; }
running() { [ -n "$("${INFRA[@]}" --profile "*" ps -q --status running "$1" 2>/dev/null)" ]; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
export -f json

infra() {
  echo "infra (project landflow-infra)"
  local pg_user=${LANDFLOW_POSTGRES_USER:-landflow} pg_db=${LANDFLOW_POSTGRES_DB:-landflow}
  check "postgres: vector extension in $pg_db" bash -c "${INFRA[*]} exec -T postgres psql -U $pg_user -d $pg_db -tAc \"select 'vector '||extversion from pg_extension where extname='vector'\" | grep vector"
  check "postgres: vector extension in landflow_test" bash -c "${INFRA[*]} exec -T postgres psql -U $pg_user -d landflow_test -tAc \"select '[1,2,3]'::vector <-> '[1,2,4]'::vector\" | grep -x 1"
  check "valkey: PING on :${LANDFLOW_VALKEY_PORT:-56379}" bash -c "${INFRA[*]} exec -T valkey valkey-cli ping | grep PONG"
  check "mailpit: UI on :${LANDFLOW_MAIL_UI_PORT:-58025}" bash -c "curl -fsS http://127.0.0.1:${LANDFLOW_MAIL_UI_PORT:-58025}/api/v1/info | json 'print(d[\"Version\"])'"
  check "minio: bucket ${LANDFLOW_MINIO_BUCKET:-landflow}" bash -c "${INFRA[*]} exec -T minio mc ls local | grep -o '${LANDFLOW_MINIO_BUCKET:-landflow}/'"
  check "minio: console on :${LANDFLOW_MINIO_CONSOLE_PORT:-59001}" curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${LANDFLOW_MINIO_CONSOLE_PORT:-59001}/"
  check "openbao: KV v2 landflow/ answers with the dev token" bash -c "curl -fsS -H 'X-Vault-Token: ${LANDFLOW_OPENBAO_ROOT_TOKEN:-landflow-dev-root-token}' http://127.0.0.1:${LANDFLOW_OPENBAO_PORT:-58200}/v1/landflow/data/dev/hello | json 'print(d[\"data\"][\"data\"][\"message\"])'"
  if running keycloak; then
    check "keycloak: realm landflow discovery" bash -c "curl -fsS http://127.0.0.1:${LANDFLOW_KEYCLOAK_PORT:-58080}/realms/landflow/.well-known/openid-configuration | json 'print(d[\"issuer\"])'"
    check "keycloak: alice logs in (password grant, test user)" bash -c "curl -fsS -d grant_type=password -d client_id=landflow -d client_secret=landflow-dev-client-secret -d username=alice -d password=alice-test-only -d scope=openid http://127.0.0.1:${LANDFLOW_KEYCLOAK_PORT:-58080}/realms/landflow/protocol/openid-connect/token | json 'import base64; p=d[\"id_token\"].split(\".\")[1]; c=json.loads(base64.urlsafe_b64decode(p+\"==\")); print(c[\"preferred_username\"], sorted(r for r in c.get(\"roles\", []) if r.startswith(\"landflow\")))'"
  else echo "  skip  keycloak (profile auth not running)"; fi
  if running jaeger; then
    check "jaeger: UI on :${LANDFLOW_JAEGER_UI_PORT:-56686}" curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${LANDFLOW_JAEGER_UI_PORT:-56686}/"
    check "jaeger: OTLP/HTTP on :${LANDFLOW_JAEGER_OTLP_HTTP_PORT:-54318}" curl -fsS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"resourceSpans":[]}' "http://127.0.0.1:${LANDFLOW_JAEGER_OTLP_HTTP_PORT:-54318}/v1/traces"
  else echo "  skip  jaeger (profile observability not running)"; fi
  if running mysql; then
    check "mysql: login as ${LANDFLOW_MYSQL_USER:-landflow}" bash -c "${INFRA[*]} exec -T mysql mysql -u${LANDFLOW_MYSQL_USER:-landflow} -p${LANDFLOW_MYSQL_PASSWORD:-landflow-dev-only} -h127.0.0.1 ${LANDFLOW_MYSQL_DATABASE:-landflow_test} -Nse 'select version()' 2>/dev/null"
  else echo "  skip  mysql (profile mysql not running)"; fi
}

app() {
  local base="http://127.0.0.1:${LANDFLOW_HOST_PORT:-53000}"
  local jar; jar=$(mktemp)
  echo "app (project landflow, $base)"
  check "host: /api/health" bash -c "curl -fsS $base/api/health | json 'print(\"online\", d[\"online\"], \"of\", d[\"plugins\"], \"plugins,\", d[\"nodeTypes\"], \"node types\")'"
  # The owner from LANDFLOW_OWNER_EMAIL / LANDFLOW_OWNER_PASSWORD (compose.yml); the session cookie goes in $jar.
  check "host: owner signs in" bash -c "curl -fsS -c $jar -H 'content-type: application/json' -d '{\"email\":\"${LANDFLOW_OWNER_EMAIL:-owner@landflow.test}\",\"password\":\"${LANDFLOW_OWNER_PASSWORD:-landflow-dev-only}\"}' $base/api/auth/login | json 'print(d[\"user\"][\"email\"], d[\"user\"][\"role\"])'"
  check "host: all 8 plugins online" bash -c "curl -fsS -b $jar $base/api/plugins | json '
want = {\"text-toolkit\", \"py-insights\", \"go-crypto\", \"messaging\", \"productivity\", \"google\", \"databases\", \"github\"}
online = {p[\"id\"] for p in d[\"plugins\"] if p[\"status\"] == \"online\"}
missing = want - online
print(\", \".join(sorted(p[\"id\"] + \"@\" + p[\"transport\"] for p in d[\"plugins\"] if p[\"id\"] in want)))
sys.exit(1 if missing else 0)'"
  check "run: Polyglot review pipeline" bash -c "curl -fsS -N -b $jar -XPOST -H 'content-type: application/json' -d '{}' $base/api/workflows/wf_polyglot_pipeline/run | python3 -c '
import json, sys
events = [json.loads(l[5:]) for l in sys.stdin.read().splitlines() if l.startswith(\"data:\")]
done = [e for e in events if e.get(\"type\") == \"execution.finished\"]
nodes = [e for e in events if e.get(\"type\") == \"node.finished\"]
if not done: sys.exit(\"no execution.finished event\")
e = done[-1]; status = e.get(\"status\") or e.get(\"execution\", {}).get(\"status\")
print(status, len(nodes), \"node runs,\", e.get(\"executionId\") or e.get(\"execution\", {}).get(\"id\"))
sys.exit(0 if status == \"success\" else 1)'"
  check "webhook: POST /api/webhook/enrich" bash -c "curl -fsS -XPOST -H 'content-type: application/json' -d '{\"text\":\"Docker makes Landflow plugins easy and great\"}' $base/api/webhook/enrich"
  rm -f "$jar"
}

code() {
  local base="http://127.0.0.1:${LANDFLOW_CODE_RUNNER_PORT:-53300}"
  echo "code runner (project landflow, $base via code-runner-port)"
  check "code runner: /health" curl -fsS "$base/health"
  check "code runner: snippets can't reach the network or write outside /tmp" bash -c "node scripts/code-runner-isolation.mjs $base >/dev/null && echo blocked"
}

case "${1:-all}" in
  infra) infra ;;
  app) app ;;
  code) code ;;
  all) infra; app; code ;;
  *) echo "usage: $0 [infra|app|code|all]" >&2; exit 2 ;;
esac
[ "$fails" -eq 0 ] && echo "all checks passed" || { echo "$fails check(s) failed"; exit 1; }
