#!/usr/bin/env bash
# Checks every transport-layer broker of deploy/compose.infra.yml from the Mac: one produce/consume (or ping) per
# broker through the published 127.0.0.1 ports, using each container's own CLI where the Mac has none (those calls go
# to host.docker.internal:<Mac port>, so they prove the published port, not the in-network one).
#
#   deploy/scripts/brokers-smoke.sh            # every broker whose container is running
#   deploy/scripts/brokers-smoke.sh kafka nats # only these
#
# Exit code 1 if any check fails. Brokers whose container isn't running are reported as SKIP.
set -u
cd "$(dirname "$0")/../.."
BIND=${LANDFLOW_BIND_ADDR:-127.0.0.1}
dc() { docker compose -f deploy/compose.infra.yml -p landflow-infra "$@"; }
fail=0
ok()   { printf 'PASS  %-12s %s\n' "$1" "$2"; }
bad()  { printf 'FAIL  %-12s %s\n' "$1" "$2"; fail=1; }
skip() { printf 'SKIP  %-12s %s\n' "$1" "$2"; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "landflow-infra-$1-1" 2>/dev/null)" = "true" ]; }
want() { [ $# -eq 0 ] && return 0; for w in "$@"; do [ "$w" = "$1" ] && return 0; done; return 1; }
selected=("$@")
sel() { [ ${#selected[@]} -eq 0 ] && return 0; for w in "${selected[@]}"; do [ "$w" = "$1" ] && return 0; done; return 1; }
stamp="smoke-$(date +%s)"

if sel kafka; then
  if running kafka; then
    port=${LANDFLOW_KAFKA_PORT:-59092}
    # the share consumer starts first (share groups deliver from "latest" by default), the producer 5 s later
    out=$(dc exec -T kafka bash -c "/opt/kafka/bin/kafka-console-share-consumer.sh --bootstrap-server host.docker.internal:$port --topic landflow.smoke --group landflow-smoke-\$RANDOM --timeout-ms 25000 --max-messages 1 2>/dev/null & pid=\$!; sleep 5; echo $stamp | /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server host.docker.internal:$port --topic landflow.smoke >/dev/null 2>&1; wait \$pid" 2>&1)
    if grep -q "$stamp" <<<"$out"; then ok kafka "share-group consumer got the record via localhost:$port (share.version=$(dc exec -T kafka /opt/kafka/bin/kafka-features.sh --bootstrap-server localhost:9092 describe 2>/dev/null | awk '/share.version/ {print $8}'))"; else bad kafka "no record received: $(tail -1 <<<"$out")"; fi
  else skip kafka "container not running (profile kafka)"; fi
fi

if sel rabbitmq; then
  if running rabbitmq; then
    port=${LANDFLOW_RABBITMQ_MANAGEMENT_PORT:-55673}; auth="${LANDFLOW_RABBITMQ_USER:-landflow}:${LANDFLOW_RABBITMQ_PASSWORD:-landflow-dev-only}"
    curl -fsS -u "$auth" -H 'content-type: application/json' -X PUT "http://$BIND:$port/api/queues/%2F/landflow.smoke" -d '{"durable":true,"auto_delete":false,"arguments":{}}' >/dev/null &&
    curl -fsS -u "$auth" -H 'content-type: application/json' -X POST "http://$BIND:$port/api/exchanges/%2F/amq.default/publish" -d "{\"properties\":{},\"routing_key\":\"landflow.smoke\",\"payload\":\"$stamp\",\"payload_encoding\":\"string\"}" | grep -q '"routed":true' &&
    got=$(curl -fsS -u "$auth" -H 'content-type: application/json' -X POST "http://$BIND:$port/api/queues/%2F/landflow.smoke/get" -d '{"count":1,"ackmode":"ack_requeue_false","encoding":"auto"}') && grep -q "$stamp" <<<"$got" &&
    curl -fsS -u "$auth" -X DELETE "http://$BIND:$port/api/queues/%2F/landflow.smoke" >/dev/null &&
    ok rabbitmq "declared, published and got a message through the management API on $port (AMQP on ${LANDFLOW_RABBITMQ_PORT:-55672}; v$(curl -fsS -u "$auth" "http://$BIND:$port/api/overview" | jq -r .rabbitmq_version))" || bad rabbitmq "management API round trip failed"
  else skip rabbitmq "container not running (profile rabbitmq)"; fi
fi

if sel nats; then
  if running nats; then
    port=${LANDFLOW_NATS_PORT:-54222}; mon=${LANDFLOW_NATS_MONITOR_PORT:-58222}
    js=$(curl -fsS "http://$BIND:$mon/varz" | jq -r 'if .jetstream then "jetstream on" else "jetstream OFF" end' 2>/dev/null)
    pong=$(python3 - "$BIND" "$port" <<'EOF'
import socket, sys
s = socket.create_connection((sys.argv[1], int(sys.argv[2])), 3); s.recv(1024)
s.sendall(b'PUB landflow.smoke 2\r\nhi\r\nPING\r\n'); print(s.recv(100).decode().strip().replace('\r\n', ' '))
EOF
)
    if [[ "$pong" == *PONG* && "$js" == "jetstream on" ]]; then ok nats "PUB + PING answered '$pong' on $port; $js (monitor $mon)"; else bad nats "got '$pong', $js"; fi
  else skip nats "container not running (profile nats)"; fi
fi

if sel mqtt; then
  if running mosquitto; then
    port=${LANDFLOW_MQTT_PORT:-51883}
    got=$(dc exec -T mosquitto sh -c "mosquitto_pub -h host.docker.internal -p $port -V 5 -t landflow/smoke -m $stamp -r && mosquitto_sub -h host.docker.internal -p $port -V 5 -t landflow/smoke -C 1 -W 3 && mosquitto_pub -h host.docker.internal -p $port -V 5 -t landflow/smoke -n -r" 2>&1)
    if [ "$got" = "$stamp" ]; then ok mqtt "MQTT 5 publish and subscribe on $port (anonymous)"; else bad mqtt "$got"; fi
  else skip mqtt "container not running (profile mqtt)"; fi
fi

if sel artemis; then
  if running artemis; then
    port=${LANDFLOW_ARTEMIS_AMQP_PORT:-55674}; user=${LANDFLOW_ARTEMIS_USER:-landflow}; pass=${LANDFLOW_ARTEMIS_PASSWORD:-landflow-dev-only}
    out=$(dc exec -T artemis bash -c "cd /var/lib/artemis-instance && ./bin/artemis producer --url amqp://host.docker.internal:$port --protocol amqp --user $user --password $pass --destination landflow.smoke --message-count 1 --silent >/dev/null 2>&1 && ./bin/artemis consumer --url amqp://host.docker.internal:$port --protocol amqp --user $user --password $pass --destination landflow.smoke --message-count 1 --receive-timeout 5000 2>&1 | tail -1")
    if grep -q "Consumer thread finished" <<<"$out"; then ok artemis "AMQP 1.0 produce and consume on $port (console ${LANDFLOW_ARTEMIS_CONSOLE_PORT:-58161})"; else bad artemis "$out"; fi
  else skip artemis "container not running (profile artemis)"; fi
fi

if sel pulsar; then
  if running pulsar; then
    port=${LANDFLOW_PULSAR_PORT:-56650}; admin=${LANDFLOW_PULSAR_ADMIN_PORT:-58180}
    out=$(dc exec -T pulsar bash -c "bin/pulsar-client --url pulsar://host.docker.internal:$port produce persistent://public/default/landflow.smoke -m $stamp 2>&1 | grep -c 'successfully produced'; bin/pulsar-client --url pulsar://host.docker.internal:$port consume persistent://public/default/landflow.smoke -s landflow-smoke -t Shared -p Earliest -n 1 2>&1 | grep -c 'successfully consumed'")
    if [ "$(tr -d '[:space:]' <<<"$out")" = "11" ] && curl -fsS "http://$BIND:$admin/admin/v2/brokers/health" | grep -q ok; then ok pulsar "produce and shared-subscription consume on $port; admin API healthy on $admin"; else bad pulsar "$out"; fi
  else skip pulsar "container not running (profile pulsar)"; fi
fi

if sel pubsub; then
  if running pubsub; then
    port=${LANDFLOW_PUBSUB_PORT:-58085}; project=${LANDFLOW_PUBSUB_PROJECT:-landflow-dev}; base="http://$BIND:$port/v1/projects/$project"
    curl -fsS -X PUT "$base/topics/landflow.smoke" >/dev/null 2>&1 || true
    curl -fsS -X PUT "$base/subscriptions/landflow.smoke-sub" -H 'content-type: application/json' -d "{\"topic\":\"projects/$project/topics/landflow.smoke\"}" >/dev/null 2>&1 || true
    data=$(printf '%s' "$stamp" | base64)
    curl -fsS -X POST "$base/topics/landflow.smoke:publish" -H 'content-type: application/json' -d "{\"messages\":[{\"data\":\"$data\"}]}" >/dev/null &&
    got=$(curl -fsS -X POST "$base/subscriptions/landflow.smoke-sub:pull" -H 'content-type: application/json' -d '{"maxMessages":10}') && grep -q "$data" <<<"$got" &&
    ok pubsub "REST publish and pull on $port (project $project; PUBSUB_EMULATOR_HOST=$BIND:$port)" || bad pubsub "publish/pull failed: $(head -c 200 <<<"${got:-}")"
  else skip pubsub "container not running (profile pubsub)"; fi
fi

if sel servicebus; then
  if running servicebus; then
    port=${LANDFLOW_SERVICEBUS_HTTP_PORT:-55300}
    health=$(curl -fsS "http://$BIND:$port/health" 2>&1)
    if grep -q healthy <<<"$health"; then ok servicebus "emulator healthy on $port (AMQP on ${LANDFLOW_SERVICEBUS_PORT:-55675}); entities from deploy/infra/servicebus/Config.json: $(jq -r '.UserConfig.Namespaces[0] | ((.Queues|length|tostring) + " queues, " + (.Topics|length|tostring) + " topics")' deploy/infra/servicebus/Config.json)"; else bad servicebus "$health"; fi
  else skip servicebus "container not running (profile servicebus)"; fi
fi

if sel mcp-gateway; then
  if running mcp-gateway; then
    admin=${LANDFLOW_MCP_GATEWAY_ADMIN_PORT:-55000}; mcp=${LANDFLOW_MCP_GATEWAY_PORT:-54000}
    n=$(curl -fsS "http://$BIND:$admin/api/config/resources/mcp.target" | jq '.resources | length' 2>/dev/null)
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://$BIND:$mcp/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
    if [ -n "$n" ]; then ok mcp-gateway "admin API on $admin lists $n target(s); POST /mcp tools/list on $mcp answered $code (500 'no upstreams' is normal with 0 targets)"; else bad mcp-gateway "admin API on $admin not answering"; fi
  else skip mcp-gateway "container not running (profile mcp-gateway)"; fi
fi

exit $fail
