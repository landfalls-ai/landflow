#!/usr/bin/env bash
# Sets up OpenFGA (profile tool-policy-openfga of deploy/compose.infra.yml) for Landflow's tool access (docs/agents.md "Tool access").
#
#   deploy/scripts/openfga-tool-policy.sh setup
#       Creates a store named landflow-tools with the model in deploy/tool-policy/openfga/model.json and prints the two variables
#       Landflow needs. OpenFGA here keeps everything in memory: run `setup` again after the container restarts.
#   deploy/scripts/openfga-tool-policy.sh grant <store-id> <user-id|*> <agent-id> <tool>
#       Lets a user (or everyone, `*`) use a tool of an agent. A tool nobody was granted is denied, so grant the tools you want used.
#   deploy/scripts/openfga-tool-policy.sh check <store-id> <user-id> <agent-id> <tool>
#       Asks OpenFGA the question Landflow asks: allowed or not.
#
# OPENFGA_URL defaults to http://127.0.0.1:58080 (this machine only).
set -euo pipefail

url="${OPENFGA_URL:-http://127.0.0.1:58080}"
here="$(cd "$(dirname "$0")" && pwd)"
post() { curl -fsS -X POST "$url$1" -H 'content-type: application/json' -d "$2"; }

case "${1:-}" in
  setup)
    store="$(post /stores '{"name":"landflow-tools"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
    [ -n "$store" ] || { echo "could not create a store at $url" >&2; exit 1; }
    post "/stores/$store/authorization-models" "$(cat "$here/../tool-policy/openfga/model.json")" >/dev/null
    echo "export LANDFLOW_TOOL_POLICY=openfga"
    echo "export LANDFLOW_TOOL_POLICY_URL=$url"
    echo "export LANDFLOW_OPENFGA_STORE_ID=$store"
    ;;
  grant)
    [ $# -eq 5 ] || { echo "usage: $0 grant <store-id> <user-id|*> <agent-id> <tool>" >&2; exit 2; }
    who="user:$3"
    post "/stores/$2/write" "{\"writes\":{\"tuple_keys\":[{\"user\":\"$who\",\"relation\":\"can_use\",\"object\":\"tool:$4/$5\"}]}}" >/dev/null
    echo "granted $who can_use tool:$4/$5"
    ;;
  check)
    [ $# -eq 5 ] || { echo "usage: $0 check <store-id> <user-id> <agent-id> <tool>" >&2; exit 2; }
    post "/stores/$2/check" "{\"tuple_key\":{\"user\":\"user:$3\",\"relation\":\"can_use\",\"object\":\"tool:$4/$5\"}}"
    echo
    ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
