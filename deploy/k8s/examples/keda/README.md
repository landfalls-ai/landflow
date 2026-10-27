# KEDA ScaledObjects for brokered plugins

One example per broker, each scaling the `plugin-text-toolkit` Deployment on the backlog of its request channel
(`landflow.v1.plugin.<pluginId>`, docs/protocol.md §14.2). They are examples, not part of any overlay: KEDA is not installed by
these manifests, and **only one ScaledObject may target a Deployment**, so apply the one that matches the broker the plugin
consumes and change `name`, the target and the channel names for another plugin. How to read them, and how the numbers relate to
`maxConcurrency` and the spill-over rule: [docs/deployment.md, "Autoscaling with KEDA"](../../../../docs/deployment.md#autoscaling-with-keda).

| File | Broker | KEDA trigger | Metric |
|---|---|---|---|
| `kafka.yaml` | Kafka | `kafka` | consumer group lag of the plugin's topic |
| `rabbitmq.yaml` | RabbitMQ | `rabbitmq` (AMQP, `QueueLength`) | messages ready in the plugin's quorum queue |
| `jetstream.yaml` | NATS JetStream | `nats-jetstream` | `num_pending` of the plugin's durable pull consumer |
| `valkey.yaml` | Valkey / Redis Streams | `redis-streams` | pending entries of the plugin's consumer group |
| `queue-workers.yaml` | Valkey (queue mode) | `redis-streams` | lag and pending entries of the job streams, scaling `landflow-worker` (not a plugin) |

```sh
kubectl --context orbstack apply -f deploy/k8s/examples/keda/jetstream.yaml      # needs KEDA and components/brokers
kubectl --context orbstack -n landflow-dev get scaledobject,hpa
```
