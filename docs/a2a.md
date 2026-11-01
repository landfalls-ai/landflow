# Remote agents over A2A, and kagent next to Landflow

Landflow talks to agents that run somewhere else over [A2A 1.0](https://a2a-protocol.org) (the JSON-RPC binding). A
standalone agent can take a remote agent as a capability, and a workflow can call one with the **A2A Agent** node. Both
were built for, and checked live against, [kagent](https://kagent.dev) 1.0 on Agent Substrate, running in a local kind
cluster next to Landflow ([below](#kagent-next-to-landflow)). Any agent that serves an A2A 1.0 card with a JSON-RPC
interface works; kagent's human-in-the-loop and usage extensions are used when the card offers them.

The loop that was checked: a Landflow agent asks the kagent agent over A2A, the kagent agent calls Landflow's own plugin
tools over MCP, one of those calls needs approval, the approval card shows in Landflow, a person approves, and the
answer comes back. Every hop is in one trace ([Tracing](#tracing)).

The kagent agent itself is a Landflow agent: Landflow writes its persona (the system prompt built from its instructions,
skills, name and description), model and tools to kagent, on deploy and on every publish, and shows whether kagent still
holds exactly that ([Landflow agents on kagent](#landflow-agents-on-kagent)).

## The agent capability

Agent builder → Capabilities → **Add A2A agent** ([agents.md](agents.md#building-an-agent)):

| Setting | Meaning |
|---|---|
| Name | The tool is `ask_<name>`; the timeline, approval cards and notices use the name too |
| Agent URL | The agent's A2A endpoint, for kagent `http://<controller>/agents/<namespace>/<name>`. The card is read from `<url>/.well-known/agent-card.json` |
| Authentication | None, Bearer Auth (`httpBearerAuth`) or Header Auth (`httpHeaderAuth`) |
| Options | Timeout (ms, default 300000), Human in the Loop (default on: ask for kagent's HITL extension when the card offers it) |
| Use when | The tool's description. Empty: the card's description and its skills |
| Require approval | Pause before every message to this agent. The agent's own approvals pause the run either way |

How a call goes:

- **When the run starts** the card is read (cached 60 s per URL and credentials). An agent that can't be reached, or
  whose card has no JSON-RPC 1.0 interface (an A2A 0.3 card, for example), is left out with a notice, like an offline
  plugin. The tool takes one argument, `message`: what to ask, with everything the agent needs, since it doesn't see the
  conversation.
- **The message** goes with `SendStreamingMessage` when the card says `capabilities.streaming` (kagent does), else with
  `SendMessage` and `GetTask` polls until the task settles. While it streams, the timeline shows each of the remote
  agent's tool calls as it happens.
- **The conversation carries on.** The task's `contextId` is kept in the session (`remoteContexts`), so the next call in
  the same session continues the remote conversation.
- **What the timeline shows**: the tool row with the agent's card name, its final state and token usage, and under it
  the remote agent's own tool calls (kagent's `function_call` / `function_response` parts, ordered by their timeline
  positions), each with its arguments, result and time.
- **Final states.** `completed`: the reply is the tool result. `failed`, `rejected`, `canceled`: the tool fails with the
  agent's status message. `auth-required`: the tool fails ("needs credentials Landflow can't give it").

### Pauses

A kagent agent pauses with `input-required` and a HITL request in the status message's metadata:

- **Tool approvals** (`tool_approval_request`, a tool bound with `requireApproval: true`): the Landflow run pauses with
  an approval card, "*\<agent\>* wants to run *\<tool\>*", with the call's arguments. It is answered wherever Landflow
  approvals are: the test chat, Slack, Teams and the approval email
  ([agents.md](agents.md#how-a-run-works)). The answer goes back to the same task (`tool_approval_response`, with the
  reason on a rejection); the remote agent carries on, and may pause again. A remote rejection is reported to the model
  like a failed call, not as a denial of Landflow's own tool.
- **Where no one can approve** (sub-agents, workflow nodes, schedules), the pause is rejected for the model with a
  reason ("carry on without them"), up to 3 times per call; then the tool fails.
- **Questions** (`ask_user_request`, or `input-required` without a HITL request): the tool result lists the questions
  and tells the model to answer from what it knows or ask the user, then call the tool again. That next call answers the
  same task (`ask_user_response`).
- **A reason with every request.** `ask_<name>` takes `message` and `reason` ("why you are asking and what done looks
  like"); the reason is recorded in the run trace beside the request, not sent to the agent
  ([run-trace.md](run-trace.md#iterations-rounds-turns-and-fix-cycles)).

## The A2A Agent node

**A2A Agent** (`core.a2aAgent`), in the node creator's AI section, has the same Agent URL, Authentication and options
plus an **Operation**:

| Operation | Parameters | Does |
|---|---|---|
| Send Message | Message, Context ID (optional: carry on a conversation) | Sends and waits for the task to settle or pause |
| Answer a Pause | Task ID, Answer (Approve, Reject with a reason, Answer Questions one per line) | Reads the task, checks what it waits for, and answers it |
| Get Task | Task ID | Reads a task |
| Cancel Task | Task ID | Stops a task |

Each item outputs `{ reply, state, taskId, contextId, agent }`, plus `message` (the status text of a task that isn't
completed), `pause` (`{ type: 'approval', calls, hint }` or `{ type: 'question', questions }`), `steps` (the agent's tool
calls), `said` (what it said between them: `{ id, text, afterSteps }`), `data` (data parts) and `usage` when there are any. A failed, rejected or canceled task fails the item. A paused
task doesn't: a later node (after a Wait, a form or an approval step) answers it with **Answer a Pause** and the
`taskId`.

**As an agent's tool.** Attached to an AI Agent or Run an Agent node, the node is a tool with `message` (the task, or a
follow-up) and a required `reason` (recorded in the trace, never sent to the agent; the descriptor says `delegates:
true`). Within one execution it remembers the conversation (`ctx.getNodeState`, which the engine now also gives a tool
sub-node, kept for the length of the run and saved if the execution waits): the second call, and the call in round 2 of a
looping flow, continues the same `contextId`, so the agent still knows what it did. A Context ID set on the node wins. The
tool description says so. The agent does not see the calling agent's own conversation.

**Questions.** The option **Questions Go To** (default **The Calling Agent**) decides what happens when the remote
agent pauses with a question (`ask_user_request`, or `input-required` without a HITL request) in tool mode:

- *The calling agent*: the tool result is "*\<Agent\>* asks: …. Call *\<tool\>* again with your answer as the message."
  (`reply`, with `state: "input-required"` and `asksCaller: true`, and no `pause`), and the node remembers the task and
  the question. The calling agent's next call is the answer: it goes to the same task as an `ask_user_response`. The
  journal shows the question as the reply of that request, not as a wait for a person.
- *A person*: as before, the item is paused with `pause: { type: "question" }` and the next call is a new message in the
  same conversation.

Tool approvals (`tool_approval_request`) are not changed: the item carries the `pause`, and the next call is a new message
in the same conversation. Outside tool mode, questions and approvals are as described above and the option has no effect.

**Progress.** A send or an answer can take minutes (a Claude Code agent on kagent). While it runs, the node reports
`{ agent, state, taskId, contextId, steps }` through `ctx.sendProgress`, as the task updates (at most twice a second): the
latest 20 `steps`, each `{ id, name, status, args, output, error, startedAt, endedAt }` with `args` and `output` shortened
to 400 characters. The engine turns it into `node.progress` events, also when the node is a tool of a Run an Agent node.
The execution view shows the node lit on the canvas with a line above it ("Developer · Bash: pnpm test"), and its detail
pane lists the steps as they come, auto-scrolling ([agents.md](agents.md#from-workflows)). After the run, the node's
output `steps` show as the same list. The final output doesn't change. A card that doesn't stream still reports, on
each poll.

## The protocol, as built

`apps/web/src/lib/server/a2a/client.ts`: A2A 1.0 over JSON-RPC 2.0 with the `A2A-Version: 1.0` header; the methods
`SendMessage`, `SendStreamingMessage` (server-sent events: `task`, `statusUpdate` and `artifactUpdate` events merged in
order, `append` chunks joined), `GetTask` and `CancelTask`; the 1.0 enum spellings (`TASK_STATE_*`, `ROLE_*`). Requested
extensions go in the `A2A-Extensions` header. From kagent it reads:

- **HITL** (`https://kagent.dev/extensions/hitl/v1`): approval and question requests in the status message's metadata,
  answered with a message whose metadata carries the response.
- **Usage** (`https://kagent.dev/extensions/usage/v1`): input, output, cached and reasoning tokens in the task metadata.
- **Part types** (`kagent.dev/a2a/part-type`, `kagent.dev/a2a/timeline-position`): which data parts are tool calls and
  results, and when they happened.

Every message carries `landflow.*` tags in its metadata: `agent.id`, `session.id`, `run.id` from an agent;
`workflow.id`, `execution.id`, `node.name` from the node.

## Tracing

Each call is an `invoke_agent {card name}` client span (`apps/web/src/lib/server/telemetry/a2a.ts`), and its W3C trace
context goes along as `traceparent`. kagent continues it, so the remote side lands in the same trace:

```text
landflow-host     invoke_agent Text desk                     the Landflow agent's run
landflow-host       execute_tool ask_texter
landflow-host         invoke_agent landflow_text              the A2A call (client span)
kagent-controller       lf.a2a.v1.A2AService/SendStreamingMessage
agentgateway              … → ateapi ResumeActor → atelet Restore   Agent Substrate wakes the sandbox
landflow-text             a2a.request → invoke_agent landflow_text
landflow-text               generate_content qwen3-coder:30b
landflow-text               execute_tool changeCase → HTTP POST
landflow-host                 POST /api/mcp/plugins/[id] → mcp.tool.call → workflow.execute → node.execute → plugin.rpc
landflow-plugin-text-toolkit    plugin.execute text-toolkit.changeCase
```

The span's attributes, events and the `landflow.a2a.*` metrics are in [observability.md](observability.md#remote-agents-a2a).
The Grafana dashboard of the local telemetry stack shows them next to kagent's and Agent Substrate's
([deployment.md](deployment.md#telemetry-on-kubernetes)).

Seen from the trace, on kagent 1.0.0-alpha17:

- **The MCP call back into Landflow sits in the trace but not under its parent.** kagent's HTTP client sends a
  `traceparent` whose span it never exports, so Grafana shows `POST /api/mcp/plugins/[id]` and what's under it as
  separate roots of the same trace. A TraceQL query finds the whole path:
  `{ trace:id = "<id>" && name =~ "invoke_agent.*|execute_tool.*|mcp.tool.call|node.execute.*|plugin.*" }`.
- **kagent-controller and agentgateway mark their `SendStreamingMessage` spans as errors when a stream closes** ("grpc:
  the client connection is closing", "RST_STREAM … INTERNAL_ERROR", and in agentgateway's access log "response body
  failed" on the `substrate-actors-grpc` route) although Landflow received the whole task. It shows as a red span;
  Landflow's own spans are fine.
- **The `landflow.*` tags don't reach kagent's spans.** kagent documents copying message metadata onto `a2a.request` as
  `a2a.message.metadata.*`; alpha17 doesn't. The shared trace, `gen_ai.conversation.id` (the A2A context) and
  `a2a.task.id` tie the two sides together instead.
- **The remote agent's messages are elided in its logs** (`"content": "<elided>"`) even with `captureContent: true` in
  the agent's runtime defaults.

## kagent next to Landflow

kagent 1.0 runs agents on Agent Substrate, which needs Kubernetes 1.37 (the PodCertificateRequest and ClusterTrustBundle
APIs) and gVisor. The OrbStack cluster is 1.36, so kagent runs in a **kind** cluster, `landflow-kagent`, on the same
OrbStack Docker engine, and Landflow stays in `landflow-dev` on the OrbStack cluster.

```bash
deploy/scripts/kagent-up.sh
```

The script is idempotent: run it again after Landflow restarts (the host's data is an emptyDir, so the credential and
the example agent are gone; kagent still holds `landflow-text` written for the old agent id, which the script removes
before Landflow deploys the new one) or to upgrade kagent. It leaves your kubectl and docker contexts alone (kind's kubeconfig goes to
`$KIND_KUBECONFIG`, by default `$TMPDIR/landflow-kagent.kubeconfig`). It needs Landflow running in `landflow-dev`, and
`kind`, `helm`, `kubectl`, `curl`, `python3` and the kagent CLI 1.0.0-alpha17 (`KAGENT_CLI`, default
`~/.local/bin/kagent`). In order, it:

1. creates the kind cluster from `deploy/kind/landflow-kagent.yaml` (Kubernetes 1.37, the controller's NodePorts
   published on the Mac's loopback) and turns on proxy ARP on its node, which Substrate's per-actor networking needs;
2. applies the bridges: `deploy/kind/bridge.yaml` (a `landflow-host` Service in kind's namespace `landflow` whose
   endpoint is the host's ClusterIP, which OrbStack routes to every container on its engine) and
   `deploy/kind/bridge-otel.yaml` (the same for `landflow-lgtm`, when the observability overlay runs);
3. installs kagent 1.0.0-alpha17 and Agent Substrate 0.6.0-alpha3 with `deploy/kind/kagent-config.yaml` (Ollama on the
   Mac as the model provider, `qwen3-coder:30b`), or upgrades them with `deploy/kind/kagent-values.yaml` (telemetry to
   Landflow's backend). Substrate's own telemetry is set on its release (`otel.endpoint`, sampling 1.0);
4. applies `deploy/kind/harness.yaml` (the Harness `landflow-kagent` on the gVisor worker pool) and
   `deploy/kind/landflow-access.yaml` (a ServiceAccount `landflow` whose Role may write kagent's Agents, AgentTemplates,
   ModelConfigs, RemoteMCPServers and Secrets in the `kagent` namespace, and a token for it), removes the hand-written
   example agent of earlier versions, signs in to Landflow as the development owner and saves the token in a **kagent
   cluster** credential, `kagent (kind)` ([below](#landflow-agents-on-kagent));
5. creates and publishes the example agent **Text formatter** in Landflow from `deploy/kind/agents/text-formatter.json`
   (if there isn't one), with a persona (role, tone, a one-sentence answer length, Always and Never rules) and the Text
   Toolkit's `slugify` and `changeCase` as tools (`changeCase` needs approval), deploys
   it to kagent from Landflow as `landflow-text`, and waits for it to be Ready.

| | From the Mac | From Landflow's pods |
|---|---|---|
| The agent's A2A endpoint | `http://127.0.0.1:58083/agents/kagent/landflow-text` | `http://host.docker.internal:58083/agents/kagent/landflow-text` (use this in Landflow) |
| kagent UI | http://127.0.0.1:58082 | |
| kind | `kubectl --kubeconfig $KIND_KUBECONFIG …` | |

kagent reaches Landflow as `http://landflow-host.landflow.svc.cluster.local:3000`, a name in kind's own DNS, so
kagent's egress rules can allow it by hostname. Landflow reaches kind's Kubernetes API where kind publishes it on the
Mac, `https://host.docker.internal:<port>`, checking its certificate against `localhost` (the credential's TLS server
name). Removing it all: `kind delete cluster --name landflow-kagent` (the Docker network `landflow-kind` stays until
removed).

## Landflow agents on kagent

An agent built in Landflow can run on kagent with the persona built here. Deploying it (the **kagent** card at the
bottom of the agent's Build tab, or `PUT /api/agents/<id>/kagent`) writes the published version to kagent as five
resources, all named after the deployment (default: the agent's name as a DNS label) and labelled
`landflow.dev/agent-id`:

| kagent resource | What Landflow writes |
|---|---|
| AgentTemplate | `systemPrompt`: the system prompt Landflow's runtime gives the model (`apps/web/src/lib/shared/persona.ts`, the text the Persona tab shows): the persona parts and instructions, the skills with their "use when", the name and the description. `description`: the agent's. `tools`: one MCP binding for the tools that run freely and one with `requireApproval` for those that need approval |
| RemoteMCPServer | The agent's own tools, served by Landflow at `/api/mcp/agents/<id>`: the tools the runtime builds from the deployed version, run the same way (node, workflow, knowledge base, sub-agent, MCP server and A2A tools, `load_skill`) |
| ModelConfig | The agent's model: Ollama (the model's server URL, which kagent must reach too), OpenAI or Anthropic (the credential's base URL; the API key goes in the Secret) and the temperature |
| Agent | The template on the credential's harness |
| Secret `<name>-landflow` | `authorization`: the token kagent calls the MCP endpoint with (Landflow keeps it sealed with its encryption key), and `api-key` |

Writing uses server-side apply (field manager `landflow`), so a deploy sets every field Landflow owns back to Landflow's
value. **Publishing writes the new version too**: the publish answer carries `kagent` (the status, or why kagent
couldn't be written; the publish itself still happens). Unpublishing leaves kagent's copy as it is; deleting the agent
removes it from kagent. When kagent can't be reached then, Landflow remembers what it left (the `settings` row
`kagent.leftovers`) and removes it the next time it deploys an agent to that cluster. Landflow never takes over a kagent agent it didn't write (409), and removing deletes only
resources labelled with the agent's id. Moving a deployment to another name or cluster removes the old resources.

**Checking that kagent holds the persona.** `GET /api/agents/<id>/kagent` (and the card) reads the resources back and
compares them with what Landflow writes from the deployed version: the system prompt, description, tools, model, harness
and MCP server. Every field that differs is named, with both values, so an edit made in kagent's UI or with kubectl shows
as **Changed in kagent** until it is redeployed; a missing resource is drift too. Fields kagent adds on its own (defaults
such as `stream: true`) aren't. A publish kagent didn't get shows as `outdated` (the card: `v2 in kagent`). The status
also gives the Agent's Ready condition, the system prompt as kagent holds it and the agent's A2A URL
(`<controller URL>/agents/<namespace>/<name>`), which another Landflow agent's A2A capability or an A2A Agent node can
use.

**The kagent cluster credential** (`core.kagentApi`): the Kubernetes API server URL, a ServiceAccount token, the CA,
the TLS server name (when the URL's host isn't on the certificate), the namespace (default `kagent`), the harness
(default `landflow-kagent`), kagent's controller URL as Landflow reaches it, Landflow's URL as kagent's agents reach
it, and the plugin registry (Landflow as kagent's nodes reach it, for Claude Code plugins; see below). Its Test lists the namespace's agents and looks for the harness. The token needs a Role like
`deploy/kind/landflow-access.yaml`'s.

**The tools' endpoint**, `/api/mcp/agents/<id>`: MCP over Streamable HTTP (both protocol eras, like the other
endpoints), only for the bearer token in the agent's Secret (anything else is 401; an agent that isn't deployed is 404).
It serves the version kagent runs, so a publish kagent didn't get doesn't change kagent's tools under it. kagent pauses
on the tools whose binding needs approval, so a call that arrives was approved; each runs in an `execute_tool {tool}`
span with the agent's id and name.

What stays in Landflow: cross-session memory (the `remember` tool and the notes need the person the agent talks to, so
kagent doesn't get them), the run's date and time in the prompt, guardrails, usage limits, schedules and channels.

### On Claude Code

A cluster can have several Harnesses, and each runs one runtime: kagent's own (ADK), Claude Code, Codex or an image of
one's own. The card's **Runtime** picks the Harness a deploy goes to (`PUT` with `harness`; `GET ?credentialId=` lists
the cluster's Harnesses with their runtimes). Without one a deploy keeps the agent's Harness, else the credential's.
Landflow writes agents for kagent's own runtime and for Claude Code; it refuses Codex and own-image Harnesses.
`deploy/kind/harness-claude.yaml` is a Claude Code Harness, `landflow-claude`, that maps every Claude model name
(`ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) to `qwen3-coder:30b` on Ollama.

On Claude Code three things are written differently (`apps/web/src/lib/server/kagent/manifests.ts`):

- **The model** is always `Anthropic`. An Ollama model gets Ollama as the base URL (Ollama serves Anthropic's Messages
  API) and the key `ollama`, which Ollama ignores. An Anthropic model gets the credential's base URL and key. OpenAI
  models are refused, and there is no temperature.
- **The tools** are on two RemoteMCPServers, because Claude Code binds a server whole and kagent pauses per server:
  `<name>` (`?tools=free`) and, when a tool needs approval, `<name>-approval` (`?tools=approval`, bound with
  `requireApproval`). The endpoint serves each URL only its own tools, in `tools/list` and in `tools/call`. Claude Code
  then sees them as `mcp__<server>__<tool>`.
- **The agent's plugins** go in the template's `plugins`.

**Claude Code plugins.** The agent's **Abilities** tab has a **Claude Code plugins** card that picks plugins from the
added marketplaces (Explore's list). Landflow plugins and plugins without `.claude-plugin/plugin.json` aren't offered.
The config keeps them as `<plugin>@<marketplace>` (`plugins`, at most 20). Deploying or publishing to a Claude Code
Harness resolves each one (`marketplace.claudePlugin`), and that needs:

- a GitHub source;
- a `.claude-plugin/plugin.json`, so kagent hands the plugin whole to Claude Code (`--plugin-dir`) rather than copying
  selected skills;
- a commit, pinned from the branch it is on now.

The pins are kept in the deployment and the status. The status compares against them without resolving them again, and
`plugins` is a drift field. kagent's own runtime ignores plugins.

kagent 1.0's Agent Substrate builds the agent's golden snapshot with all egress blocked, so it can't clone a git
source or read a bucket: the golden actor crashes (`materialize plugin 0: exit status 128`, "Could not resolve host:
github.com"). OCI sources work, because the node's atelet pulls and mounts them. So **Landflow serves plugins as OCI
images.** When the credential's **Plugin Registry** is set (host:port as kagent's nodes reach Landflow), a deploy:

1. packs each pinned plugin's folder into a one-layer image (`apps/web/src/lib/server/kagent/oci.ts`). Packing is
   deterministic (sorted entries, no times or owners, a fixed gzip header), so a commit always gives the same digest;
2. keeps the image in `LANDFLOW_DATA_DIR/oci`;
3. writes `source: { oci: <registry>/plugins/<marketplace>/<plugin>@sha256:… }`.

`/v2` is the pull half of the registry API: the version check, and manifests and blobs **by digest only**. It is
public, like a registry's anonymous pulls, because it holds only files of public GitHub repositories and answers only
digests Landflow packed. An image that is gone (a host whose data isn't on a volume) is packed again from the
deployment that pinned it when kagent asks for it.

Use a private IP (10.x, 172.16–31.x, 192.168.x), so atelet's registry client (go-containerregistry) pulls over plain
HTTP. `kagent-up.sh` sets it to the Landflow Service's ClusterIP. Without a registry, plugins are written as git
sources, for a kagent that can fetch them.

Checked live on 2026-10-31 on kagent 1.0.0-alpha17. The Dev agent (`deploy/kind/agents/dev-agent.json`: a developer
persona, test first, with `submit_work`, which needs approval) ran on `landflow-claude`. Dev desk, a Landflow agent with
an A2A tool pointing at it, handed it a task from the test chat. On qwen3-coder through Ollama's Anthropic API, Claude
Code wrote the bash function and its tests, ran and debugged them, and called
`mcp__landflow-dev-approval__submit_work`. kagent's pause showed as Landflow's approval card with the files, summary
and test output, and approving ran the tool in Landflow. With the `mattpocock-skills` plugin from Anthropic's
marketplace, Landflow pinned it at `49dd158`, packed it and wrote the OCI source. atelet pulled it from `/v2` at the
Service's ClusterIP, and the golden snapshot came up Ready. Claude Code ran with the image as a `--plugin-dir`, and
its Skill tool loaded `mattpocock-skills:tdd`.

qwen3-coder doesn't stop there. After the tool's answer ("the task is over: answer with one line, and call no more
tools") it writes its last line and calls `submit_work` again. Denying makes it check its work again and resubmit. In
one run it handed in a check of its own instead of the failing test run. Claude models are what Claude Code expects.
Landflow can't make the model stop.

### Network for Claude Code

kagent's sandboxes reach only what their Agent is granted: the model, kagent's controller and the MCP servers of their
tools (Landflow, but only for an agent that binds at least one of its tools). Everything else fails at DNS (kagent's egress gateway answers NXDOMAIN), so `apk add`, `go get`,
`npm install` or `pip install` can't run. An **EgressPolicy** grants more origins, and an Agent gets them only by
naming it in `egressPolicyRefs`.

- `deploy/kind/egress-dev.yaml` is `landflow-dev-packages`, and its only destination is the **package cache**,
  `http://landflow-cache.landflow.svc.cluster.local:8080`. No registry is reachable directly. `kagent-up.sh` applies it
  and names it in the credential's **Egress Policies**.
- The cache is `deploy/k8s/components/package-cache`, part of the OrbStack overlay: one Service `landflow-cache:8080` in
  `landflow-dev`, fronted by nginx, which routes `/npm/` to Verdaccio 6.2.0 (uplink registry.npmjs.org), `/go/` to
  Athens v0.16.0 (proxy.golang.org, and the checksum database at `/go/sumdb/sum.golang.org`, so `GOSUMDB` works through
  it), `/pypi/` to proxpi 1.3.0 (pip's `/pypi/simple/`; `PROXPI_DOWNLOAD_TIMEOUT` is 120 s, because at the default 0.9 s
  proxpi redirects the client to files.pythonhosted.org, which a sandbox can't reach) and `/apk/` to an nginx
  `proxy_cache` of dl-cdn.alpinelinux.org (packages kept 30 days, `APKINDEX.tar.gz` one hour; the response header
  `X-Cache-Status` says HIT or MISS). Each store has a PersistentVolumeClaim (npm, Go and PyPI 5 Gi, Alpine 2 Gi), so a
  restart keeps what was fetched. Its pods are labelled `part-of: landflow-cache` so the overlay's
  `imagePullPolicy: Never` patch, for images built here, doesn't apply to them.
- The bridge brings it to kind the way it brings `landflow-host`: `deploy/kind/bridge.yaml` has a Service
  `landflow-cache` in kind's `landflow` namespace and an EndpointSlice holding the OrbStack ClusterIP, which
  `kagent-up.sh` fills in (it stops if the overlay isn't applied). The gateway can allow it by name.
- The tools are pointed at it in the Harness (`deploy/kind/harness-claude-dev.yaml`, env): `npm_config_registry`
  (npm and pnpm), `YARN_NPM_REGISTRY_SERVER` with `YARN_UNSAFE_HTTP_WHITELIST`, `COREPACK_NPM_REGISTRY`, `GOPROXY` and
  `GOSUMDB`, `PIP_INDEX_URL` with `PIP_TRUSTED_HOST`, and `UV_DEFAULT_INDEX` with `UV_INSECURE_HOST`. apk's repositories
  are rewritten in the image (the Dockerfile's `APK_CACHE` build argument), after the build's own `apk add`.
- Landflow writes `egressPolicyRefs` on every deploy: the agent's own list (the kagent card's **Network access**, the
  namespace's EgressPolicies as toggles with their origins), else the credential's. A name kagent doesn't have is
  refused before anything is written, and a list changed in kagent is drift (`egressPolicies`). kagent applies a change
  to running sessions without a restart.
- A Claude Code agent with Landflow's mod also gets an EgressPolicy of its own, `<name>-landflow`, with Landflow's
  origin (the credential's Landflow URL), referenced after the others: the mod reports there even when the agent has no
  Landflow tools ("The landflow-harness mod" below). It is labelled with the agent, isn't offered in **Network access**,
  goes when the agent is removed or moves off the mod, and a changed one is drift (`landflowEgress`). Landflow's access
  Role (`deploy/kind/landflow-access.yaml`) may write EgressPolicies for this; with an older Role that only reads them,
  the deploy writes the agent without it and says the run reports are missing. A Landflow URL with an IP address can't
  be an EgressPolicy origin, so no policy is written for one.
- An EgressPolicy destination can carry a credential: the sandbox sends a placeholder header and the gateway swaps in
  a Secret's value, so the runtime never sees it (for a private git host, for example).

Checked live on 2026-10-31 (with the public registries as the policy's origins, before the cache): before the policy,
every outside host failed DNS; after referencing it, `apk add go nodejs npm python3` took 10 s, `go get` of a module
1.7 s and `npm view` 1.1 s, and github.com, not in the policy, still failed to resolve.

Checked live on 2026-11-01 against the cache, from pods in `landflow-dev` and kind's `landflow` namespace: `npm view
left-pad version`, `go mod download golang.org/x/text@latest` (modules and the checksum database's tiles through
`/go/sumdb/`), `pip download requests`, an `APKINDEX.tar.gz` and `apk add jq` all worked. A second request for the same
file was served from the cache: a tarball, a module zip and a wheel took 0.3 s the first time and 3 to 7 ms the second
(Verdaccio logged one request to registry.npmjs.org for two to the client; proxpi sent no redirect), and the second
APKINDEX answered `X-Cache-Status: HIT`. From kind, `landflow-cache.landflow.svc.cluster.local:8080/npm/left-pad`
answered through the bridge.

### GitHub from the sandbox

`deploy/kind/egress-github.yaml` is `landflow-github`: github.com (git clone, fetch and push) with
`Authorization: Basic x-access-token:<token>`, api.github.com with `Authorization: Bearer <token>`, plus
codeload.github.com and raw.githubusercontent.com without a token. The token is a fine-grained one the person creates
and stores themselves, as the Secret `github-git` in the `kagent` namespace (keys `token` and `basic`; the command is
in the file's header); `kagent-up.sh` applies the policy when that Secret exists. The gateway replaces a placeholder
header, so the Harness **landflow-claude-dev** sets git's `http.https://github.com/.extraHeader` to a placeholder
through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`, and a `curl` to the API sends
`-H 'Authorization: x'`. The sandbox never holds the token: `git config` shows only the placeholder.

Checked live on 2026-10-31 from a sandbox with both policies: `git ls-remote` of the private repo answered, a blobless
clone took 4 s (69 MB), `pnpm install --filter '@landflow/plugin-text-toolkit...' --ignore-scripts` 11 s and its tests
5 s (17 passed); the API without the header answered 404 (no token added), and gitlab.com stayed unreachable.

The token's scope is what limits the agents: a fine-grained token on one repository with Contents and Pull requests
read and write lets them push any branch, `main` included, so protect `main` with a branch rule if agents must never
land on it (the flows here only push `agents/*` branches and open draft pull requests).

### GitHub's MCP tools for agents

Agents can read and review pull requests through GitHub's own MCP server, with a GitHub token Landflow holds. It is an
ordinary MCP server tool of the agent (**Add GitHub MCP** in Capabilities; `type: 'mcp'` with `preset: 'github'` and
`access: 'read' | 'review'`), so it works for a Landflow agent on its own runtime and, through the agents' MCP endpoint
(`/api/mcp/agents/:id`, built with `kagentTools`), for a member on kagent, Claude Code included. Nothing else changed in
that path: kagent calls Landflow, Landflow calls the GitHub MCP server.

- **The server**: `ghcr.io/github/github-mcp-server:v2.0.2` (released 2026-10-08), deployed by the component
  `deploy/k8s/components/github-mcp` (wired into the OrbStack overlay) as the Service `landflow-github-mcp:8082`, command
  `http --toolsets=repos,issues,pull_requests,actions --exclude-tools=<every merge and write tool>`. `http` serves
  Streamable HTTP at `/` and takes the GitHub token from each request's `Authorization: Bearer` header, so the pod holds
  no token and the manifest has none. Chosen over GitHub's remote server (`api.githubcopilot.com/mcp/`) because it runs
  on this machine only, its tool names are checkable here (the pinned image was run and its `tools/list` read), and the
  bundled server's `--exclude-tools` is a second wall; the remote one needs a Copilot-capable token and sends the agent's
  traffic off the machine. A different server (a remote one, GHES) is the tool's **Server URL**, or
  `LANDFLOW_GITHUB_MCP_URL` for the default.
- **The credential**: an existing **Bearer Auth** credential (`core.httpBearerAuth`) whose token is the GitHub one, a
  fine-grained token on the repository with Pull requests and Contents read, plus Pull requests write for a reviewer.
  Landflow sends it as the bearer, encrypted at rest like any credential; it never reaches kagent, the sandbox, a
  manifest or a log. The token's scope is still the outer limit.
- **The allow-list, per agent, server side** (`apps/web/src/lib/server/mcp/github.ts`). The tools an agent gets are the
  server's `tools/list` cut down to its access, before they reach the model or kagent, whatever the settings' `include`
  fields say (they are ignored for the preset), so a hidden tool can't be called by name either:
  - **Read** (every member): `pull_request_read` (details, diff, files, reviews, review comments, checks),
    `list_pull_requests`, `search_pull_requests`, `get_file_contents`, `get_repository_tree`, `get_commit`,
    `list_commits`, `list_branches`, `list_tags`, `get_tag`, releases, `issue_read`, `list_issues`, `search_issues`,
    `search_code`, `search_commits`, `search_repositories`, `actions_get`, `actions_list`, `get_job_logs`, labels.
  - **Review** (the Reviewer; read plus): `pull_request_review_write` (create, submit or delete a pending review,
    resolve a thread), `add_comment_to_pending_review` (a line comment), `add_reply_to_pull_request_comment`,
    `add_issue_comment`.
  - **Never**, at either level: `merge_pull_request`, `create_pull_request`, `update_pull_request`,
    `update_pull_request_branch`, `create_branch`, `create_or_update_file`, `push_files`, `delete_file`, repository
    create, fork and delete, rulesets, `issue_write`, `sub_issue_write`, `update_issue_comment`, labels, projects,
    `actions_run_trigger`, Copilot assignment and review requests, gists. Merging stays with the flow. The same list is
    the pod's `--exclude-tools`. An access that is not `review` is `read`; `get_me`, notifications and the rest of the
    server's tools aren't offered either, since the list is an allow-list.
- **Approval**: the tool has the usual **Require approval** switch; on kagent it makes the Claude Code binding split
  (`?tools=approval`). Review comments are written to GitHub when the agent calls them, so ask for approval where a person
  should read them first.
- **The guard** is about the sandbox's own tools (shell, files, `gh`): Read-only still allows `gh pr review` and
  `gh pr comment`, and the MCP tools above are the other way to do the same, with the token held outside the sandbox. The
  mod does not look at MCP calls; the allow-list is what limits them.
- **Run Trace** shows the tool among the agent's connections with GitHub's mark: *GitHub MCP · Tool · pull requests,
  reviews, line comments* for review access, *read only* otherwise.
- **Setting up the Tech Lead team**: add **GitHub MCP** with access *Read* to the Planner and Developer and *Read and
  review* to the Reviewer, then deploy each again, since kagent binds the tools it was deployed with. Verified on
  2026-11-01: the pinned image started with those flags (also read-only, all capabilities dropped), its `tools/list`
  was exactly the toolsets minus the excluded tools, and Landflow's client built an agent's tools from it. No call was
  made to GitHub, as no GitHub token was used.

### A toolchain image for Claude Code

Installing a toolchain on every run costs time and tokens, so the Harness **landflow-claude-dev** runs Claude Code on
a common image with what most projects need, and nothing project-specific:
`deploy/docker/claude-harness-dev.Dockerfile` adds Go (latest, with its standard library already built into a
`GOCACHE=/opt/go-build` baked into the image by `go build std`, 182 MB, writable by the sandbox's user, so a project's
first `go build` compiles only its own code; another Go version comes through the module proxy), Node 22
with npm and pnpm (Corepack), Python 3.12 with pip and uv, a C toolchain (build-base), curl, jq, ripgrep, unzip and
openssh-client to kagent's claude-harness image. A project's own dependencies are fetched when the agent installs them,
through the package cache (the Harness's env points npm, pnpm, Yarn, Corepack, Go, pip and uv at it, and the image's apk
repositories at its `/apk/`; see Network for Claude Code).

A Harness's `workload.image` must be pinned by digest and pulled from a registry, and nothing is pushed anywhere, so
Landflow's registry serves it. `deploy/scripts/claude-harness-dev.sh` builds the image with `--load`, saves it as an
OCI layout, puts its blobs in Landflow's store (`LANDFLOW_DATA_DIR/oci`, on the host's volume) and applies
`deploy/kind/harness-claude-dev.yaml` with `<Service IP>:3000/runtimes/claude-harness-dev@sha256:…`. `/v2` serves each
manifest with its own media type and streams blobs from disk. Run the script after `kagent-up.sh`, and again when the
Dockerfile changes.

Checked live on 2026-10-31: a probe agent deployed on `landflow-claude-dev` had its golden snapshot Ready about 15 s
later, pulled from Landflow. In it: Go 1.27.0, Node 22.23.4, pnpm 10.28.2, Python 3.12.16, uv 0.7.22 and gcc 14.2.0.
A Go program with a module dependency built and ran in 17 s, nearly all of it compiling the standard library on a cold
cache. `pnpm add` and `node` took 1.2 s.

### The landflow-harness mod

kagent's Claude Code harness sends no token usage over A2A, so a run could only estimate what its Claude Code agents
spent. Claude Code 2.1.287 added mods: a plugin's hooks module that sees every model request, tool call and result. So
every Claude Code agent Landflow deploys gets Landflow's own mod, **landflow-harness**
(`apps/web/claude-plugins/landflow-harness`), which does three things:

- **Trace.** A request from a run starts with a line `<!-- landflow-trace <url> -->`. The mod takes the line off the
  prompt before the model reads it, and until the turn ends posts what Claude Code does to that URL
  (`POST /api/agent-trace/<id>`): each model request's tokens (input, output, cache reads and writes), model and time,
  subagents' requests too, the tool calls the API ran itself, each tool call's time and outcome, the subagents it
  started, and the turn's end. Events go in batches at most every 3 s, and once more before the turn ends, so the run
  has them when the answer arrives.
- **Guard.** Before a tool call runs, its rules (`hooks/rules.ts`) refuse what an agent here never needs to do. The
  model reads the reason as the tool's error and carries on another way:

  | Rule | What it stops |
  | --- | --- |
  | `secret-file` | reading `.env` files (not `.env.example` and other templates), `.netrc`, `.git-credentials`, `.pgpass`, SSH keys, AWS, Docker, kube and gh credentials, `*.pem` keys, `credentials.json`/`secrets.yaml`, `/var/run/secrets` and `/proc/*/environ`, with file tools or shell readers (`cat`, `grep`, `cp`…) |
  | `env-dump` | `printenv`, a bare `env`, `export -p`, `declare -x`, a bare `set`, echoing a variable named like a key or token, `gh auth token` |
  | `git-push` | force pushes, `+refspec` and `:branch` refspecs, pushes to `main` or `master` |
  | `git-auth-config` | changing git's `http.*`, `credential.*`, `url.*`, `core.sshCommand` or `include` settings, `-c` included |
  | `merge` | `gh pr merge`, and merging through `gh api …/pulls/<n>/merge` |
  | `destructive` | `rm -r` on `/`, `~`, `$HOME` or a system folder, `mkfs`, `dd` onto a device, `chmod -R` on `/`, a fork bomb, writing to a disk |
  | `upload` | `nc`, `socat`, `telnet`; `curl`/`wget` sending a file (`-T`, `-d @file`, `-F x=@file`) |
  | `write-outside-workspace` | Write, Edit, MultiEdit and NotebookEdit outside the working directory, `/tmp` and `~/.claude` (the same idea as Claude Code 2.1.314's `permissions.blockWritesOutsideWorkingDirectories`) |

  **The guard per agent.** The Deploy tab's kagent card picks one of three for a Claude Code agent (`guard` on
  `PUT /api/agents/:id/kagent`, kept across redeploys and publishes):

  | Guard | What it does |
  | --- | --- |
  | **Read-only** (`strict`) | the rules above, and the agent is read-only on the code (`read-only`): no Write, Edit, MultiEdit or NotebookEdit outside `/tmp`; no `git commit`, `push`, `merge`, `rebase`, `reset`, `add`, `stash`, `restore`, `clean`, `pull`, new branches or tags, deleting or moving branches, `checkout --`; no `gh pr create/merge/close/edit`, issue, release, repo, label, workflow, secret or gist changes, no `gh api` writes (a pull request's review and line comments are allowed); no `rm`, `mv`, `cp`, `tee`, `touch` or redirections (`>`, `>>`) outside `/tmp`, no `sed -i`/`perl -i`, no publishing packages. Reading, searching, checking out a branch, installing dependencies, running tests and builds, and `gh pr review`/`gh pr comment` go on. For a reviewer |
  | **Normal** (`enforce`, the default) | the rules above |
  | **Report only** (`report`) | nothing is refused; each stop is reported (`action: report`) |

  The deploy writes it into the mod's `plugin.json` as the default of its `guard` option (`userConfig`), so the packed
  image differs per guard (`KagentPlugin.options`). A request can make it stricter for one turn (the marker's
  `guard=strict`), never looser: an `enforce` agent ignores `guard=report` and `guard=off`. The trace's `start` event
  says the mode in force, and Run Trace shows the agent's mod as *read-only on the code* among its connections. Read-only
  is best effort: a script that writes files itself isn't caught, so pair it with a token that can't push.
- **Redact.** A tool's result is kept with every token or key it shows masked (`[redacted GitHub token]`): private
  keys, GitHub, Anthropic, OpenAI, AWS, Slack, Google and npm tokens, Landflow's `lfk_` and `lf_` keys,
  `Authorization` headers and passwords in URLs. A secret that reached a file or a command's output doesn't reach the
  model or the transcript.

**Deploying.** The host ships the mod (the host image copies `apps/web/claude-plugins` next to `server.js`;
`LANDFLOW_CLAUDE_PLUGINS_DIR` points elsewhere). When the credential names a **Plugin Registry**, a deploy to a Claude
Code Harness packs it like any other plugin, pinned to a hash of its files (`landflow-harness@landflow`, source
`landflow:builtin`), adds it to the template's plugins, opens Landflow's origin to the sandbox (the `<name>-landflow` EgressPolicy in
"Network for Claude Code"), and keeps `trace: { url: <Landflow URL>/api/agent-trace, a2aUrl }` in the deployment.
Without that policy an agent with no Landflow tools couldn't reach the URL: the first live run on 2026-11-01 lost every
report that way, while the same mod in the same image posted them when run with kagent's arguments by hand. Without a registry kagent can't fetch it, so the agent runs without it. A changed mod is a
new digest: deploy the agent again to take it.

**Calling.** When the Run a Team node, an agent's A2A tool or the A2A Agent node sends a new request to an A2A URL that
is a Landflow agent deployed with the mod (its `a2aUrl`, else the kagent name the URL ends with when only one agent has
it), Landflow opens a trace for that call (`apps/web/src/lib/server/a2a/agent-trace.ts`): a random 18-byte id is the
URL's only credential, so the route is public. The trace lives in the host's memory while the call runs. When the
answer comes, Landflow waits up to 2 s for the mod's last batch, closes it (the route then answers 410, and the mod
stops posting there), and uses what it reported:

- the call's usage: tokens, cache reads, requests and the model, priced per request at the agent's provider (Settings
  → AI prices; Ollama's are free unless priced there). A team member's usage counts against its budget as real usage,
  not an estimate;
- the Team tab's card and the actor sheet show each member's model calls, tokens in (and cached), out, cost and model;
  the Report tab has **What each agent used** and the run's cost next to its tokens;
- each model request is a `model` span under the member's request in Run Trace ([run-trace.md](run-trace.md#who-writes-it)),
  with its tokens, cost, model and time; the request keeps the totals;
- each tool call the guardrails stopped is a **Guardrail** check on the request (warn: "Stopped Bash: git push origin
  main (git-push: …)"), and masked secrets a **Secrets masked** check;
- the Run a Team node's `members` carry `inputTokens`, `outputTokens`, `cacheReadTokens`, `costUsd`, `model`,
  `requests` and `ms`; the A2A Agent node's item carries `usage` (with `costUsd`) and `trace`.

**Claude Code's version.** kagent 1.0 (alpha17, and rc1 of 2026-10-30) compiles in Claude Code 2.1.285 with a strict
check: the harness runs `claude --version` and refuses anything else (`claude version mismatch`), and the golden actor
crashes. Mods need 2.1.287 or later. `deploy/docker/claude-harness-dev.Dockerfile` installs the latest Claude Code
(`CLAUDE_CODE_VERSION`, 2.1.316 on 2026-10-31) and puts a wrapper at `/usr/local/bin/claude` that answers
`--version` alone with `<version> (kagent pin 2.1.285)` and runs the real binary for everything else; the build checks
it. Newer versions also bring what the mod reports: `serverToolUses` on each request (2.1.290), Haiku 5.5 (2.1.293),
blocking hooks (2.1.295), cache writes by TTL (2.1.300) and `isReadOnly` on tool checks (2.1.304).

Checked live on 2026-11-01: the Reviewer on `landflow-claude-dev` (image `c0f96c18`, Claude Code 2.1.316 behind the
wrapper) became Ready and the read-only Tech Review flow succeeded (`ex_go8NtdO4Yzqv`), its session restored from the new
snapshot. Locally, Claude Code 2.1.316 with the mod (`--plugin-dir`) against qwen3-coder on Ollama, in kagent's mode
(`-p --input-format stream-json`), took the marker off, posted each request's real usage (with Ollama's cache reads),
each tool's time and the turn's total before the result, refused `cat .env` and `git push origin main`, and a token in
a file reached the model as `[redacted GitHub token]`.

## Tests

`apps/web/test/a2a.test.ts` runs against `apps/web/test/fake-a2a.ts`, a fake A2A 1.0 agent shaped like kagent's (card,
SendMessage, SendStreamingMessage, GetTask, CancelTask, tool call parts, the usage and HITL extensions). It covers the
client (reading the card and refusing an A2A 0.3 one, following a working task with GetTask, merging streamed chunks,
marking the call a pause waits on); the node (a send in a client span with `traceparent` and the `landflow.*` tags on
the wire, a pause returned and answered, a failed task failing the item); and the capability (`ask_<name>` from the
card, remote steps streamed into the timeline, the conversation carrying on, an approval paused and resumed, a
rejection reaching the model with its reason, rejection where no one can approve, a question relayed, an unreachable
agent as a notice).

Checked live on 2026-10-30: the loop above from the test chat in the browser and from a script, with `slugify` and
`changeCase` in parallel, the approval card, approve and reject, and the trace in Grafana Tempo.

`apps/web/test/kagent.test.ts` covers Landflow agents on kagent against a fake Kubernetes API (server-side apply, get,
list, delete): the persona is the runtime's system prompt without the run's time and memory; the five resources and
their tool bindings; deploying needs a published agent and a kagent credential; the token is kept sealed and reused; a
publish writes the new version, and one that can't reach kagent is still a publish that leaves the deployment
`outdated`; an edit made in kagent is named as drift and kagent's own defaults aren't; another writer's agent is
refused; renaming, removing and deleting the agent remove only Landflow's resources; a loopback Ollama URL is refused;
and the MCP endpoint serves the deployed version's tools to the Secret's token only. On Claude Code (the same file):
the Harnesses are listed with their runtimes; the model is Anthropic's API on Ollama; there is a server per approval
setting and the endpoint serves each its own tools; plugins are written at their pinned commits, or as the images
Landflow packed when the credential names a registry, and a plugin changed in kagent is drift; moving back to kagent's
runtime drops the approval server and the plugins; a Codex Harness, an OpenAI model and an unknown plugin are refused.
`apps/web/test/kagent-oci.test.ts` covers the images: a tar that `tar` extracts (folders, scripts executable, long
paths split), the same digest on every pack, only the plugin's folder in the layer, the registry's version check and
headers, no tags or unknown digests, and an image packed again from its deployment; Landflow's own mod packed from the
host's files without its tests or editor types, its pin changing with a file. The registry deploy test checks that the
mod is added and the deployment keeps where it reports.

`apps/web/test/claude-harness-mod.test.ts` runs the mod's rules and redaction (`hooks/rules.ts`): what each rule stops
and lets through, and what is masked. `apps/web/test/agent-trace.test.ts` covers a trace (usage priced per request,
per model and per subagent, tools, guardrails, masks, the limits, closing), the route (public, 204, 400, 404, 410),
which calls get a trace, the A2A Agent node's item, and the journal's checks. `apps/web/test/run-team.test.ts` runs a
team whose remote member reports through the fake agent as the mod would. The hooks themselves are tested with Claude
Code's kit: `claude plugin test apps/web/claude-plugins/landflow-harness` (a marked request traced with the marker
gone, a push to main refused and reported, enforcing without a marker and report mode, a token masked), and
`claude plugin validate` checks the module.

## Not built

- GitHub MCP tools hold no per-repository scope of their own (the token's is the limit), cannot be narrowed to single tools
  beyond the read / review levels, and a review comment is written when it is called: there is no draft of it for a person to
  read first except the tool's approval switch. The bundled server is not deployed by the compose files.
- Remote agents' tokens are recorded (timeline, span, `landflow.a2a.tokens`) but don't count toward an agent's daily or
  monthly AI limits, which count Landflow's own model calls.
- The landflow-harness mod's trace lives in the memory of the host that made the call. In queue mode its id starts with
  that process (`<instance>.<random>`, base64url), and the main the mod posts to passes a batch it doesn't hold on to
  that process's inbox over Valkey (`202`), so a worker's call gets its real usage; a batch for a worker that has gone is
  lost, and the run keeps its estimate for it. Its guard is set per agent
  at deploy time (read-only, normal, report only); its rules are patterns over the command line (a script that does the
  same thing gets past them), and a continuation of a paused task (an answer, an approval) carries no marker, so that
  part is estimated. It needs a Plugin Registry and the Claude Code version wrapper while kagent pins 2.1.285.
- The dialog doesn't preview the agent card before saving; a wrong URL shows as a notice when a run starts.
- Landflow doesn't serve A2A itself: other agents can't call a Landflow agent over A2A yet (they can call its tools over
  MCP).
- Push notifications (A2A webhooks) and the gRPC and REST bindings aren't used; long tasks are streamed or polled.
- An agent on kagent doesn't get cross-session memory, guardrails or usage limits, and its skills are in its system
  prompt and `load_skill` rather than kagent skills. Its Claude Code plugins come from GitHub marketplaces only (a
  marketplace on the host or behind a URL has no commit to pin). Landflow
  doesn't watch kagent: drift shows when the status is read, and a redeploy is a click, not automatic.
- kagent's own Claude Code image (`landflow-claude`) is Alpine with bash and git only. `landflow-claude-dev` has the
  common toolchains and Go's standard library already built. Project dependencies are still installed on every session
  (from the package cache, so they stay local after the first fetch, but they aren't baked into the image), and a
  project's own packages are compiled on every session.
- The package EgressPolicy grants the package cache to every agent that references it. There is no per-agent allowlist
  beyond choosing policies, and no code host is granted yet. The cache has no authentication (anything that reaches
  `landflow-cache` can read it), and caches only what the four upstreams serve: a private registry or another mirror
  needs its own origin in a policy.
- Watching a Tech Lead that calls remote agents: a Run an Agent node's session shows live in the execution view's Agent
  session panel, with each A2A tool entry's `remote.steps` ([agents.md](agents.md#from-workflows)).
- Sessions on kagent aren't Landflow sessions: their tool calls are traced (`execute_tool`) but don't show in the
  agent's Sessions tab.
