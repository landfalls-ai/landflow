# The LLM gateway (LiteLLM)

Every model call can go through one door: a [LiteLLM](https://docs.litellm.ai) proxy in front of the models. Landflow's
own calls (agents, chat model nodes, Spotlight, the brain, the model router) and the agents it deploys to kagent all
send their requests there. LiteLLM keeps a spend log, holds the virtual keys and enforces budgets; Landflow keeps the
caps people see and decide by. LiteLLM's budgets are the backstop: they stop whatever slips past Landflow, such as an
agent running on kagent.

Only LiteLLM's open-source build is used: virtual keys, teams, customers (end users), budgets and spend logs. Its
Customer Portal and organizations are not used by default (the portal is not in a release yet; organizations need
Enterprise).

<!-- Each section below is written by the package named in its comment; the integrator merges them. -->

## Run it

The `llm-gateway` profile of `landflow-infra` runs LiteLLM next to the infra Postgres. It is opt-in:

```bash
COMPOSE_BAKE=false docker --context orbstack compose -p landflow-infra -f deploy/compose.infra.yml --profile llm-gateway up -d --wait
```

- **Ports and URLs.** One port, `127.0.0.1:54100` (`LANDFLOW_LLM_GATEWAY_PORT`), for the API and the admin UI. It is on
  loopback on purpose, not `LANDFLOW_BIND_ADDR`, because the UI shares it. `http://127.0.0.1:54100/v1/messages` and
  `/v1/chat/completions` take calls, `/health/liveliness` is the probe, `/ui` is the login.
- **The image.** `ghcr.io/berriai/litellm:v1.108.2-lts`, pinned by index digest
  `sha256:d8b4ac356743d647a13bb93f45b941fcd5f5354122cfd205948a1b192790389d` (linux/arm64 and linux/amd64), chosen on
  2026-11-15. On 21 October 2026 a supply-chain compromise poisoned `v1.107.0` and its moving tags, and LiteLLM rotated its
  image-signing key on 23 October. Never use `v1.107.0`, `latest`, `main-latest`, `main-stable`, `-nightly` or `-dev`.
  The digest was read with `docker buildx imagetools inspect`; the pinned `cosign.pub` has the expected SHA-256
  (`e3fe3e08...`). **The signature was not verified with cosign on this machine** (it is not installed): run
  `deploy/scripts/verify-litellm-image.sh` where cosign is. It also checks the tag and the pin.
- **The database.** `litellm` in the infra Postgres (`postgresql://landflow:landflow-dev-only@postgres:5432/litellm`),
  created by the one-shot `llm-gateway-db` service when missing. LiteLLM migrates it on start (the healthcheck waits 60 s).
- **Development keys.** Master key `sk-landflow-dev-master-only`, salt key `sk-landflow-dev-salt-only` (never change it
  once keys exist: it encrypts what LiteLLM stores), UI login `admin` / `landflow-dev-only`. They come from
  `LANDFLOW_LLM_GATEWAY_MASTER_KEY`, `_SALT_KEY`, `_UI_USERNAME` and `_UI_PASSWORD` in `deploy/.env`; real ones go there.
- **Models.** [`deploy/llm-gateway/config.yaml`](../deploy/llm-gateway/config.yaml) lists `qwen3-coder:30b` and `qwen3.8`
  on the host's Ollama (`ollama_chat/` serves both `/v1/messages` and `/v1/chat/completions`). To add a model, append a
  `model_list` entry and restart the service. Every model name a client sends must be listed. Ollama models have no
  price, so LiteLLM reports cost 0 for them and Landflow prices them from its own table.
- **Kubernetes.** `kubectl --context orbstack apply -k deploy/k8s/examples/llm-gateway` in `landflow-dev` (it needs the
  `postgres` component): a database Job, a one-replica Deployment and the Service `llm-gateway` on port 4000, with the
  same pinned image. The image runs as root, so the pod does not set `runAsNonRoot`. The UI: `kubectl --context orbstack
  -n landflow-dev port-forward svc/llm-gateway 54100:4000`.
- **From kagent.** In kind or on OrbStack, agents reach it at `http://host.docker.internal:54100` (compose) or
  `http://llm-gateway:4000` (the Kubernetes example).

## Point Landflow at it

<!-- LL02: the Gateway field on the Anthropic API and OpenAI API credentials, agents, chat model nodes, Spotlight and the
router, the headers that say who is calling, the call id and cost on each AI call, the fallback beta. -->

## Agents outside Landflow

<!-- LL03: kagent's ModelConfig and the Claude Code harness through the gateway, the key per agent, the spend import. -->

## Counting each call once

A call is counted in one place only:

- **Calls Landflow makes itself** are counted by Landflow's meter, as before, when they return. Through the gateway they
  also carry LiteLLM's call id (`x-litellm-call-id`) and its cost, so the gateway's log can be matched to them. They are
  marked `in-process` in LiteLLM's spend log, and the spend import skips them.
- **Calls made outside Landflow** (an agent on kagent, Claude Code on kagent, any other client of the gateway) are
  counted from LiteLLM's spend log by the spend import, once per call id.
- **LiteLLM's own totals** are the cross-check and the hard stop, never a second count.
- The tokens a remote agent reports over A2A stay in the Run Trace for reading; they are not counted again.

## Budgets in LiteLLM

<!-- LL04: projects as teams, people as customers, caps as budgets, the headroom, keys of runtimes, orphans, Settings. -->

## Asking for a higher cap

<!-- LL05: the request, the cap-raise flow (Ask a Person), what approval changes in Landflow and in LiteLLM. -->

## The AI page

<!-- LL06: Insights → AI: spend and tokens by project, agent, person, model and source; caps; the gateway; requests. -->

## Not built

<!-- Each package adds its own bullets here. -->

- **High availability.** One replica and no Redis; a restart interrupts calls in flight.
- **TLS.** None on the loopback port; do not expose it beyond the machine.
