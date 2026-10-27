# deploy/

Compose stacks, Dockerfiles, Kubernetes manifests and the MCP gateway config. How to use them (ports, credentials,
profiles, queue mode, the code runner, Kubernetes on OrbStack, resetting everything) is in
**[docs/deployment.md](../docs/deployment.md)**.

| Project | File | What |
|---|---|---|
| `landflow-infra` | [`compose.infra.yml`](compose.infra.yml) | Development and test services: Postgres + pgvector, Valkey, Mailpit, MinIO, OpenBao, plus one profile per optional service (Keycloak, Jaeger, MySQL, GreenMail, Vector, LocalStack, Git over SSH, Valkey Cluster, each message broker, agentgateway) |
| `landflow` | [`compose.yml`](compose.yml) | Landflow itself as images: the host, the seven plugins and the sandboxed code runner |
| `landflow-queue` | [`compose.queue.yml`](compose.queue.yml) | Queue mode with high availability: two mains behind a load balancer ([`queue/lb.mjs`](queue/lb.mjs)) and two workers |

Two overlays go with them: [`compose.infra-link.yml`](compose.infra-link.yml) attaches the app stack to the infra network, and
[`compose.sentinel.yml`](compose.sentinel.yml) runs Valkey with Sentinel (a primary, a replica and three sentinels) for queue-mode failover.

| Path | |
|---|---|
| [`docker/`](docker) | Dockerfiles: the host, Node, Python and Go plugins, the code runner and `landflow-bridge` |
| [`k8s/`](k8s) | kustomize base, components, overlays (`overlays/orbstack`, `orbstack-brokers`, `orbstack-queue`, gateway and ingress variants) and examples (KEDA, Envoy Gateway) |
| [`infra/`](infra) | what the infra stack mounts: the Keycloak realm, the Postgres init script, Git server keys, OpenBao, MinIO, Mosquitto, Service Bus and Vector configs |
| [`mcp-gateway/`](mcp-gateway) | agentgateway configs and compose overrides (file, auth, Landflow tokens, tokens plus an identity provider) |
| [`scripts/`](scripts) | smoke tests (`smoke.sh`, `brokers-smoke.sh`), the queue-mode end-to-end test, the transport benchmark and the MCP gateway spike |
| [`.env.example`](.env.example) | every value the compose files read, with its default (development values only) |

Build on this machine with `COMPOSE_BAKE=false` (the default buildx builder belongs to another project), and deploy only
to the local OrbStack Docker engine and cluster (`--context orbstack`).
