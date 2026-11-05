# deploy/

Compose stacks, Dockerfiles, Kubernetes manifests and the MCP gateway config. How to use them (ports, credentials,
profiles, queue mode, the code runner, Kubernetes on OrbStack, resetting everything) is in
**[docs/deployment.md](../docs/deployment.md)**.

| Project | File | What |
|---|---|---|
| `landflow-infra` | [`compose.infra.yml`](compose.infra.yml) | Development and test services: Postgres + pgvector, Valkey, Mailpit, MinIO, OpenBao, plus one profile per optional service (Keycloak, Jaeger, MySQL, GreenMail, Vector, LocalStack, Git over SSH, Valkey Cluster, each message broker, agentgateway, and `llm-gateway`: agentgateway in front of the models) |
| `landflow` | [`compose.yml`](compose.yml) | Landflow itself as images: the host, the seven plugins and the sandboxed code runner |
| `landflow-queue` | [`compose.queue.yml`](compose.queue.yml) | Queue mode with high availability: two mains behind a load balancer ([`queue/lb.mjs`](queue/lb.mjs)) and two workers |

Two overlays go with them: [`compose.infra-link.yml`](compose.infra-link.yml) attaches the app stack to the infra network, and
[`compose.sentinel.yml`](compose.sentinel.yml) runs Valkey with Sentinel (a primary, a replica and three sentinels) for queue-mode failover.

| Path | |
|---|---|
| [`docker/`](docker) | Dockerfiles: the host, Node, Python and Go plugins, the code runner and `landflow-bridge` |
| [`k8s/`](k8s) | kustomize base, components, overlays (`overlays/orbstack`, `orbstack-brokers`, `orbstack-queue`, `orbstack-observability` with Grafana, Tempo, Prometheus and Loki, gateway and ingress variants) and examples (KEDA, Envoy Gateway, an LLM gateway) |
| [`kind/`](kind) | kagent 1.0 next to Landflow: the kind cluster (`landflow-kagent`, Kubernetes 1.37), kagent's install config and values, the bridges to Landflow and its telemetry, the Harnesses (`harness.yaml`, kagent's own runtime; `harness-claude.yaml`, Claude Code on Ollama; `harness-claude-dev.yaml`, Claude Code on the common toolchain image), the package registries agents may reach (`egress-dev.yaml`), Landflow's ServiceAccount and Role for writing agents, and the example agents as Landflow config (`agents/text-formatter.json`; `agents/dev-agent.json`, a developer on Claude Code), which Landflow deploys ([docs/a2a.md](../docs/a2a.md#landflow-agents-on-kagent)) |
| [`infra/`](infra) | what the infra stack mounts: the Keycloak realm, the Postgres init script, Git server keys, OpenBao, MinIO, Mosquitto, Service Bus and Vector configs |
| [`llm-gateway/`](llm-gateway) | the agentgateway config of the `llm-gateway` profile: one OpenAI-compatible endpoint in front of the models ([docs/agents.md](../docs/agents.md#model-router)) |
| [`mcp-gateway/`](mcp-gateway) | agentgateway configs and compose overrides (file, auth, Landflow tokens, tokens plus an identity provider) |
| [`scripts/`](scripts) | smoke tests (`smoke.sh`, `brokers-smoke.sh`), the queue-mode end-to-end test, the transport benchmark, the MCP gateway spike, `kagent-up.sh` (kagent in kind, bridged to Landflow, with the example agent deployed from Landflow) and `claude-harness-dev.sh` (the common toolchain image for Claude Code agents, served from Landflow's registry) |
| [`.env.example`](.env.example) | every value the compose files read, with its default (development values only) |

Build on this machine with `COMPOSE_BAKE=false` (the default buildx builder belongs to another project), and deploy only
to the local OrbStack Docker engine and cluster (`--context orbstack`), plus the kind cluster `landflow-kagent` on that
same engine for kagent.
