---
name: landflow-agents
description: "Creates, configures, tests, publishes and calls Landflow agents and agent teams: persona, model (Anthropic, OpenAI-compatible, local Ollama, the LiteLLM gateway), tools, knowledge, the eval gate, kagent and Claude Code runtimes, and the Run an Agent node in a flow, through the UI or the REST API. Use when asked to make or change an agent, give an agent a tool or a model, publish or test it, run an agent from a workflow, deploy it to kagent, or set up a team."
---

# Landflow agents

A Landflow **agent** is a saved persona, model, tools and limits that Landflow runs, with sessions, memory and versions.
It is not the **AI Agent** node, which lives inside one workflow. What agents are and where they run is in
`docs/platform/agents.md`; every setting is in `docs/agents.md`.

## 0. Where am I?

- If `docs/platform/agents.md` exists locally, read it, and `docs/agents.md` for the setting you change.
- If not, read `https://github.com/landfalls-ai/landflow/blob/main/docs/platform/agents.md` and
  `https://github.com/landfalls-ai/landflow/blob/main/docs/agents.md`. You then work against a running Landflow host
  by its REST API (below); there is no agent command in the `landflow` CLI.

You need a host (`pnpm dev` gives `http://localhost:3000`) and a way to sign in. Use the development credentials in
`deploy/.env.example` only; never enter a real vendor token yourself: the person creates real credentials in the UI.

## 1. Pick how to do it

- **The UI** (easiest): Agents in the sidebar, New agent, then Persona and Abilities, then Publish. The Agent architect
  chat designs an agent from a description. Prefer this when a person is watching.
- **The REST API** (below): for scripts and for checking. Needs an API key with `workflows:write` (and `run` to chat).
  Create a key in Settings, API keys, or with a signed-in session: `POST /api/api-keys { label, scopes, expiresInDays? }`
  returns `{ token }` once (`lf_...`). Keys cannot create keys.
- **A flow**: a **Run an Agent** node calls a published agent (section 6).

```bash
export LANDFLOW_URL=http://localhost:3000
export LANDFLOW_API_KEY=lf_...        # from Settings, API keys
H=(-H "Authorization: Bearer $LANDFLOW_API_KEY" -H 'content-type: application/json')
```

## 2. Choose a runtime

| Runtime | Pick it when | Notes |
|---|---|---|
| In-host loop (default) | almost always: tests, schedules, channels, flows | tools run in Landflow with the caller's rights; approvals, guardrails, memory and limits all work |
| kagent, ADK | the agent should be a Kubernetes resource other A2A clients call | needs a **kagent cluster** credential (`core.kagentApi`); `docs/a2a.md#landflow-agents-on-kagent`; kagent runs in a kind cluster, `deploy/scripts/kagent-up.sh` |
| kagent, Claude Code harness | it needs a shell and files, Claude Code's own tools and plugins | the landflow-harness mod reports usage; `docs/a2a.md#on-claude-code` |

Landflow's own flow node `core.messageAgent` always runs the in-host loop, even when the agent is also deployed to kagent.
To call one on kagent from a flow, use the **A2A Agent** node (`core.a2aAgent`).

## 3. Choose a model

The model is `{ provider: 'anthropic' | 'openai' | 'ollama', model, credential?, baseUrl?, temperature? }`.

| Provider | Needs | Notes |
|---|---|---|
| `ollama` | a model pulled in Ollama | `baseUrl` defaults to `OLLAMA_URL`, else `http://127.0.0.1:11434`. **Inside a container or pod the host's Ollama is `http://host.docker.internal:11434`**: set it as the agent's `baseUrl` (for the OrbStack cluster and compose it is already `OLLAMA_URL`; an agent's own Server URL is prefilled with `127.0.0.1`, which is the pod itself there). Tool calling needs a model that supports it (for example `qwen3-coder:30b`) |
| `anthropic` | a `core.anthropicApi` credential, or `ANTHROPIC_API_KEY` on the server | |
| `openai` | a `core.openAiApi` credential (any OpenAI-compatible base URL) | the credential is required |
| LiteLLM gateway | set the credential's **Gateway** to LiteLLM, Base URL = the proxy, API key = a virtual key | calls then carry project, agent and person; `docs/llm-gateway.md`; the local proxy is `http://127.0.0.1:54100` (host) and `http://host.docker.internal:54100` (containers) |

List what is available: `curl "${H[@]}" "$LANDFLOW_URL/api/agents/models?provider=ollama&baseUrl=http://127.0.0.1:11434"`.

## 4. Create, configure, publish (REST)

```bash
# 1. a draft (a project is the caller's personal one; add ?projectId= for another)
curl "${H[@]}" -X POST "$LANDFLOW_URL/api/agents" \
  -d '{"name":"Release notes writer","description":"Writes release notes","instructions":"Write short, plain notes."}'
# -> 201 { "agent": { "id": "ag_...", ... } }   (or add "templateId" to start from a persona template)

ID=ag_...

# 2. replace the draft: model, persona, limits (PUT replaces what you send; send the whole piece you change)
curl "${H[@]}" -X PUT "$LANDFLOW_URL/api/agents/$ID" -d '{
  "model": { "provider": "ollama", "model": "qwen3-coder:30b", "baseUrl": "http://host.docker.internal:11434" },
  "persona": { "role": "Writer", "tones": ["Calm"], "length": "paragraph", "always": ["Cite the pull request"], "never": ["Invent features"] },
  "settings": { "maxIterations": 8 }
}'
```

`persona.length` is `sentence`, `paragraph` or `detailed` (anything else is a 400). Other draft fields: `skills`
(`{ id, name, whenToUse, instructions }`), `tools`, `schedules`, `channels`, `memory: { crossSession }`, `guardrails`, `router`,
`cache`, `access`, `projectContext` (`full`, `compact` or `off`), `practices` (`on` or `off`) and `plugins`. The shapes are
`AgentConfig` in `apps/web/src/lib/shared/agents.ts`; the validating schema is `agentConfigSchema` in
`apps/web/src/lib/server/agents/http.ts`. Tools are `{ id, type, ... }`:

```json
{ "id": "slugify", "type": "node", "name": "slugify", "description": "Make a URL slug", "nodeType": "text-toolkit.slugify", "parameters": {} }
{ "id": "tl_2", "type": "workflow", "workflowId": "wf_...", "name": "lookup", "description": "Look something up" }
{ "id": "tl_3", "type": "agent", "agentId": "ag_...", "useWhen": "When the task is about billing" }
```

(`deploy/kind/agents/text-formatter.json` is a working agent with node tools. Read a node's `nodeType` and parameters from
the editor or `GET /api/node-types`. A node that is `usableAsTool` takes the arguments of its `toolInputSchema` from the
model; a parameter set to `{{ $fromAI('key', 'description', 'type') }}` is filled by the model too.) A workflow tool must start with **When Called by a
Workflow or Agent** (`core.workflowTrigger`); `GET /api/agents/workflow-tools` says which workflows qualify.

```bash
# 3. test the DRAFT: SSE of run.started, entry, run.finished (add "sessionId" to continue)
curl -N "${H[@]}" -X POST "$LANDFLOW_URL/api/agents/$ID/chat" -d '{"message":"Summarise: fixed login bug"}'

# 4. add an eval case, run the cases on the draft
curl "${H[@]}" -X POST "$LANDFLOW_URL/api/agents/$ID/eval-gate" -d '{"input":"Summarise PR 12","expected":"One sentence"}'
curl "${H[@]}" -X PUT  "$LANDFLOW_URL/api/agents/$ID/eval-gate" -d '{}'

# 5. publish (the gate runs when there are cases; add {"skipEval":true} only on purpose)
curl "${H[@]}" -X POST "$LANDFLOW_URL/api/agents/$ID/publish" -d '{}'
```

Publish answers: 400 "Choose a model before publishing" or "Describe the persona or add instructions before publishing";
409 `{ gate }` when the draft scored under 3 of 5, or more than 0.5 under the published version's average (fix the agent, or
publish anyway on purpose). `POST /api/agents/$ID/restore { "version": 1 }` copies an old version into the draft. A paused tool
call is answered with `POST /api/agents/$ID/sessions/<sid>/approvals { "callId": "...", "approved": true }`.

## 5. Test and smoke

1. Chat with the draft (step 3) with a question the agent must get right and one it must refuse. Read the SSE: each
   `entry` is a timeline item (tool calls included); `run.finished.reason` is `completed`, `awaiting_approval`,
   `max_iterations`, `budget`, `error` or `canceled`.
2. Add the same questions as eval cases (step 4). The judge scores 1 to 5: correctness against `expected`, helpfulness
   without one. A local model judging itself is weak; set the online-grading judge model for a real signal.
3. Read the sessions: `GET /api/agents/$ID/sessions?audience=people&limit=10`, and the cost and tokens in the AI page.
4. Publish, then run it from a flow or a channel (below).

## 6. Call it from a flow

Add a **Run an Agent** node (type `core.messageAgent`) after a trigger. Parameters: `agentId`, `message` (default
`{{ $json.chatInput ?? $json.text }}`), `conversation` (`new` or `key`, with `sessionKey`). Optional ports: Chat Model, Memory,
Tool. The agent must be **published**, and available in the workflow's project. Tools that need approval are refused in
a flow (nobody can approve). Output: `{ reply, sessionId, agentId, version, model, endReason, usage, steps }`.

```json
{ "id": "n2", "name": "Run an Agent", "type": "core.messageAgent", "position": [260, 0],
  "parameters": { "agentId": "ag_...", "message": "{{ $json.text }}", "conversation": "new" } }
```

Prefer building the flow through the editor's Spotlight; a flow can also be saved through `POST /api/workflows` (nodes plus
a `connections` array of `{ id, type: 'main', source, sourceIndex, target, targetIndex }`). A flow can also call an agent
team with **Run a Team** (`core.runTeam`).

## 7. Teams

`POST /api/agent-teams { name, goal, members: [{ id, kind: 'agent', agentId, title, reportsTo?, reviews?, consults? }] }`
creates a draft; exactly one member leads (reports to nobody); `POST /api/agent-teams/<id>/publish` is refused with the list of
issues until the chart is valid. Details: `docs/agent-teams.md`.

## 8. On kagent

Publish first, then `PUT /api/agents/$ID/kagent { "credentialId": "<a core.kagentApi credential>", "harness": "<optional>" }`;
`GET` reads the status and any drift; `DELETE` removes it. Every later publish is written there too. Landflow never takes
over a kagent agent it did not write (409). Needs the kagent cluster to be up: ask the person to run it, or use the
`landflow-kubernetes` skill; do not touch other clusters.

## 9. Traps

- `POST /api/agents/:id/chat` runs the **draft**; flows, schedules and channels run the **published** version.
- Persona `length` is `sentence | paragraph | detailed`. A bad enum is a 400, not a silent default.
- A model with no tool-call support (some local ones) cannot use tools: pick a tool-capable Ollama model.
- The Ollama URL inside the cluster is `http://host.docker.internal:11434`, never `127.0.0.1`.
- Export an agent as a Claude Code plugin with `GET /api/agents/$ID/export?format=claude-plugin`; credentials are dropped.
- An agent in a project is invisible to other projects until shared (`PUT /api/agents/$ID/shares { projectIds, all }`).
- Do not run a paid model in a loop, and do not enter real tokens: a person adds credentials in the UI.
- Spotlight and the Agent architect are changing; read `docs/assistant.md` before describing them.
- Never hand-edit `apps/web/.data`; agents are saved through the API.
