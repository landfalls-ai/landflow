#!/usr/bin/env bash
# kagent 1.0 next to Landflow, on this machine only (docs/a2a.md, docs/deployment.md "kagent next to Landflow"):
#
#   1. the kind cluster landflow-kagent (Kubernetes 1.37, which Agent Substrate needs) on the OrbStack Docker engine;
#   2. kagent 1.0 and Agent Substrate in it (the kagent CLI, deploy/kind/kagent-config.yaml), with their traces, metrics and
#      logs going to Landflow's telemetry backend when it runs (the orbstack-observability overlay);
#   3. the bridge both ways (deploy/kind/bridge.yaml, bridge-otel.yaml);
#   4. the Harnesses Landflow's agents run on (deploy/kind/harness.yaml, kagent's own runtime, and harness-claude.yaml, Claude
#      Code), the package registries their sandboxes may reach (deploy/kind/egress-dev.yaml) and a ServiceAccount that may
#      write agents in the kagent namespace (deploy/kind/landflow-access.yaml), whose token goes into a Landflow "kagent
#      cluster" credential, with Landflow's registry for Claude Code plugins and the EgressPolicy every agent references;
#   5. the example agent: "Text formatter" (deploy/kind/agents/text-formatter.json) created and published in Landflow, then
#      deployed to kagent from Landflow as landflow-text. Its persona, model and tools are written by Landflow, not by hand.
#
# Idempotent: run it again after the host's data was reset (a new landflow-data PVC: the credential and agent are gone) or
# to update kagent.
# Your kubectl and docker contexts are left as they are: kind's kubeconfig goes to its own file ($KIND_KUBECONFIG).
#
# Needs Landflow in landflow-dev on the OrbStack cluster, and kind, helm, kubectl, curl, python3 and the kagent CLI
# (KAGENT_CLI, default ~/.local/bin/kagent, version 1.0.0-alpha17). Owner sign-in: the overlay's development credentials.
set -euo pipefail
cd "$(dirname "$0")/../.."

CLUSTER=landflow-kagent
ORB=orbstack
NS=landflow-dev
KAGENT_CLI=${KAGENT_CLI:-$HOME/.local/bin/kagent}
KAGENT_VERSION=1.0.0-alpha17
SUBSTRATE_VERSION=0.6.0-alpha3
KIND_KUBECONFIG=${KIND_KUBECONFIG:-${TMPDIR:-/tmp}/landflow-kagent.kubeconfig}
LANDFLOW_URL=${LANDFLOW_URL:-http://landflow-host.$NS.svc.cluster.local:3000}
OWNER_EMAIL=${LANDFLOW_OWNER_EMAIL:-owner@landflow.test}
OWNER_PASSWORD=${LANDFLOW_OWNER_PASSWORD:-landflow-dev-only}
AGENT_NAME=landflow-text
AGENT_FILE=deploy/kind/agents/text-formatter.json

# kind talks to the OrbStack engine without switching the docker context.
DOCKER_HOST=$(docker context inspect "$ORB" --format '{{.Endpoints.docker.Host}}')
export DOCKER_HOST
orb() { kubectl --context "$ORB" "$@"; }
k() { kubectl --kubeconfig "$KIND_KUBECONFIG" "$@"; }
h() { helm --kubeconfig "$KIND_KUBECONFIG" "$@"; }
step() { printf '\n== %s\n' "$*"; }

[ -x "$KAGENT_CLI" ] || { echo "kagent CLI not found at $KAGENT_CLI (set KAGENT_CLI)" >&2; exit 1; }
HOST_IP=$(orb -n "$NS" get svc landflow-host -o jsonpath='{.spec.clusterIP}')
OTEL_IP=$(orb -n "$NS" get svc landflow-lgtm -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)

step "kind cluster $CLUSTER"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind get kubeconfig --name "$CLUSTER" >"$KIND_KUBECONFIG"
  echo "exists"
else
  KIND_EXPERIMENTAL_DOCKER_NETWORK=landflow-kind kind create cluster --config deploy/kind/landflow-kagent.yaml --kubeconfig "$KIND_KUBECONFIG"
fi
# Agent Substrate's per-actor networking answers ARP for the sandboxes' addresses on the node.
docker exec "$CLUSTER-control-plane" sysctl -qw net.ipv4.conf.all.proxy_arp=1

step "bridge to Landflow (landflow-host $HOST_IP${OTEL_IP:+, landflow-lgtm $OTEL_IP})"
k apply -f <(sed "s/LANDFLOW_HOST_IP/$HOST_IP/" deploy/kind/bridge.yaml) 2>/dev/null || true # the kagent namespace may not exist yet
if [ -n "$OTEL_IP" ]; then
  k apply -f <(sed "s/LANDFLOW_OTEL_IP/$OTEL_IP/" deploy/kind/bridge-otel.yaml)
else
  echo "no landflow-lgtm in $NS (overlay orbstack-observability): kagent's telemetry endpoint won't answer"
fi

step "kagent $KAGENT_VERSION and Agent Substrate"
if h status kagent -n kagent >/dev/null 2>&1; then
  h upgrade kagent oci://ghcr.io/kagent-dev/kagent/helm/kagent --version "$KAGENT_VERSION" --namespace kagent --reuse-values --values deploy/kind/kagent-values.yaml >/dev/null
  echo "upgraded"
else
  # The CLI asks for the provider's API key even for a local Ollama: any value does.
  KUBECONFIG="$KIND_KUBECONFIG" OLLAMA_API_KEY=local-ollama-no-key "$KAGENT_CLI" --config deploy/kind/kagent-config.yaml install --namespace kagent
fi
if [ "$(h get values substrate -n ate-system -o json | python3 -c 'import json,sys; print((json.load(sys.stdin).get("otel") or {}).get("endpoint", ""))')" = "" ]; then
  h upgrade substrate oci://ghcr.io/kagent-dev/substrate/helm/substrate --version "$SUBSTRATE_VERSION" --namespace ate-system --reuse-values \
    --set otel.endpoint=http://landflow-otel.landflow.svc.cluster.local:4317 --set otel.traces.samplingRatio=1.0 --wait --timeout 10m >/dev/null
  echo "Agent Substrate telemetry on"
fi
k apply -f <(sed "s/LANDFLOW_HOST_IP/$HOST_IP/" deploy/kind/bridge.yaml)
k rollout status deployment/kagent-controller -n kagent --timeout=300s

step "Landflow's access to kagent"
k apply -f deploy/kind/harness.yaml -f deploy/kind/harness-claude.yaml -f deploy/kind/egress-dev.yaml -f deploy/kind/landflow-access.yaml >/dev/null
# GitHub for the sandboxes, only once you've stored a token as the Secret github-git (deploy/kind/egress-github.yaml).
if k -n kagent get secret github-git >/dev/null 2>&1; then k apply -f deploy/kind/egress-github.yaml >/dev/null && echo "EgressPolicy landflow-github applied"; fi
# The example agent of earlier versions was written by hand: Landflow won't take over resources it didn't write.
for kind in agent agenttemplate remotemcpserver; do
  for name in "$AGENT_NAME" landflow-text-toolkit; do
    if k -n kagent get "$kind" "$name" >/dev/null 2>&1 && [ -z "$(k -n kagent get "$kind" "$name" -o jsonpath='{.metadata.labels.landflow\.dev/agent-id}')" ]; then
      k -n kagent delete "$kind" "$name" >/dev/null && echo "removed the hand-written $kind $name"
    fi
  done
done
k -n kagent delete secret landflow-mcp --ignore-not-found >/dev/null
for _ in $(seq 1 30); do
  SA_TOKEN=$(k -n kagent get secret landflow-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d)
  [ -n "$SA_TOKEN" ] && break
  sleep 1
done
[ -n "$SA_TOKEN" ] || { echo "the ServiceAccount token wasn't issued" >&2; exit 1; }
CA_DATA=$(k config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d)
# Landflow's pods reach the API server where kind publishes it on the Mac; its certificate names localhost.
API_PORT=$(docker port "$CLUSTER-control-plane" 6443/tcp | head -1 | sed 's/.*://')

JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT
lf() { curl -fsS -b "$JAR" -H 'content-type: application/json' "$@"; }
curl -fsS -c "$JAR" -H 'content-type: application/json' -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}" "$LANDFLOW_URL/api/auth/login" >/dev/null
# Tokens an earlier version of this script issued for the hand-written agent.
lf "$LANDFLOW_URL/api/mcp/tokens" | python3 -c '
import json, sys
for t in json.load(sys.stdin)["tokens"]:
    if t.get("label") == "kagent (kind)" and not t.get("revokedAt"): print(t["id"])' | while read -r id; do
  lf -X DELETE "$LANDFLOW_URL/api/mcp/tokens/$id" >/dev/null
done
# kagent's nodes pull Claude Code plugins from Landflow's registry at the Service's private IP (plain HTTP).
CREDENTIAL=$(python3 - "$SA_TOKEN" "$CA_DATA" "$API_PORT" "$HOST_IP" <<'PY'
import json, sys
token, ca, port, host_ip = sys.argv[1:]
print(json.dumps({"name": "kagent (kind)", "type": "core.kagentApi", "data": {
    "server": f"https://host.docker.internal:{port}", "token": token, "caData": ca, "tlsServerName": "localhost",
    "namespace": "kagent", "harness": "landflow-kagent", "controllerUrl": "http://host.docker.internal:58083",
    "landflowUrl": "http://landflow-host.landflow.svc.cluster.local:3000", "pluginRegistry": f"{host_ip}:3000",
    "egressPolicies": "landflow-dev-packages"}}))
PY
)
CREDENTIAL_ID=$(lf "$LANDFLOW_URL/api/credentials" | python3 -c '
import json, sys
print(next((c["id"] for c in json.load(sys.stdin)["credentials"] if c["type"] == "core.kagentApi" and c["name"] == "kagent (kind)"), ""))')
if [ -n "$CREDENTIAL_ID" ]; then
  lf -X PATCH -d "$CREDENTIAL" "$LANDFLOW_URL/api/credentials/$CREDENTIAL_ID" >/dev/null
else
  CREDENTIAL_ID=$(lf -d "$CREDENTIAL" "$LANDFLOW_URL/api/credentials" | python3 -c 'import json,sys; print(json.load(sys.stdin)["credential"]["id"])')
fi
lf -d "{\"type\":\"core.kagentApi\",\"id\":\"$CREDENTIAL_ID\"}" "$LANDFLOW_URL/api/credentials/test" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(("ok: " if r.get("ok") else "FAILED: ") + r.get("message", ""))'

step "agent $AGENT_NAME, written by Landflow"
AGENT_ID=$(lf "$LANDFLOW_URL/api/agents" | python3 -c '
import json, sys
name = json.load(open(sys.argv[1]))["name"]
print(next((a["id"] for a in json.load(sys.stdin)["agents"] if a["name"] == name), ""))' "$AGENT_FILE")
if [ -z "$AGENT_ID" ]; then
  AGENT_ID=$(lf -d "$(python3 -c 'import json,sys; print(json.dumps({"name": json.load(open(sys.argv[1]))["name"]}))' "$AGENT_FILE")" "$LANDFLOW_URL/api/agents" | python3 -c 'import json,sys; print(json.load(sys.stdin)["agent"]["id"])')
  lf -X PUT -d @"$AGENT_FILE" "$LANDFLOW_URL/api/agents/$AGENT_ID" >/dev/null
  lf -X POST "$LANDFLOW_URL/api/agents/$AGENT_ID/publish" >/dev/null
  echo "created and published $AGENT_ID in Landflow"
fi
# After the host's data was reset, kagent still holds the example agent written for an id Landflow no longer has, and
# Landflow won't take over what another agent wrote.
OLD_ID=$(k -n kagent get agenttemplate "$AGENT_NAME" -o jsonpath='{.metadata.labels.landflow\.dev/agent-id}' 2>/dev/null || true)
if [ -n "$OLD_ID" ] && [ "$OLD_ID" != "$AGENT_ID" ] && ! lf "$LANDFLOW_URL/api/agents/$OLD_ID" >/dev/null 2>&1; then
  k -n kagent delete agent,agenttemplate,remotemcpserver,modelconfig,secret -l "landflow.dev/agent-id=$OLD_ID" >/dev/null
  echo "removed kagent/$AGENT_NAME, written for $OLD_ID, which this Landflow no longer has"
fi
curl -sS -b "$JAR" -H 'content-type: application/json' -X PUT -d "{\"credentialId\":\"$CREDENTIAL_ID\",\"name\":\"$AGENT_NAME\"}" "$LANDFLOW_URL/api/agents/$AGENT_ID/kagent" | python3 -c '
import json, sys
answer = json.load(sys.stdin)
if "status" not in answer: sys.exit("deploying to kagent failed: %s" % answer.get("error", answer))
s = answer["status"]
state = "in sync" if s["inSync"] else "drift: %s %s" % ([d["field"] for d in s["drift"]], s.get("error", ""))
print("v%s written to %s/%s: %s" % (s["version"], s["namespace"], s["name"], state))'
k -n kagent wait "agent/$AGENT_NAME" --for=condition=Ready --timeout=300s

cat <<EOF

kagent is up.
  Landflow agent $AGENT_ID ("Text formatter"), deployed as kagent/$AGENT_NAME; credential $CREDENTIAL_ID ("kagent (kind)")
  A2A endpoint   http://127.0.0.1:58083/agents/kagent/$AGENT_NAME           (from the Mac)
                 http://host.docker.internal:58083/agents/kagent/$AGENT_NAME  (from Landflow's pods: use this in Landflow)
  kagent UI      http://127.0.0.1:58082
  kind kubectl   kubectl --kubeconfig $KIND_KUBECONFIG ...
EOF
[ -z "$OTEL_IP" ] || echo "  Grafana        http://landflow-lgtm.$NS.svc.cluster.local:3000  (traces, metrics and logs of Landflow and kagent)"
