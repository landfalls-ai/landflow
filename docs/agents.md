# Agents (Preview)

Agents are standalone assistants that use your connected tools and data: you give one a model,
instructions, skills and capabilities, test it in a chat, publish it, and it then answers on a
schedule, in Telegram, or from a workflow. They are modelled on n8n's **Agents (Preview)** (see
[research/03-n8n-ai-agents.md](research/03-n8n-ai-agents.md) §8 for the n8n walkthrough). They are
separate from the **AI Agent** node, which runs inside a workflow.

| | AI Agent node | Agent |
|---|---|---|
| Lives in | a workflow (model, memory, tools wired as sub-nodes) | its own page under **Agents** |
| Runs when | the workflow runs | test chat, schedules, Telegram, the **Message an Agent** node |
| Tools | `usableAsTool` nodes on the canvas | any action node, workflows, other agents, skills |
| Memory | the Simple Memory sub-node | sessions (always) and cross-session facts per user (optional) |
| Versions | the workflow's | draft plus published versions, sessions pinned to a version |

## Building an agent

**Agents** in the sidebar → **Create agent** opens the builder. Everything autosaves to the
*draft*; the test chat always runs the draft.

- **Model and instructions.** Pick a provider, then a credential or server, then a model:
  - Anthropic: optional `core.anthropicApi` credential, otherwise `ANTHROPIC_API_KEY`.
  - OpenAI-compatible: a `core.openAiApi` credential. Any base URL works, including Ollama's `/v1`.
  - Ollama: a base URL, default `OLLAMA_URL` or `http://127.0.0.1:11434`.

  The model list loads live (`GET /api/agents/models`). For Ollama it shows which models support tools.
- **Skills** ([Agent Skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills)
  format). Each skill has a *when to use* line, which is always in the system prompt, and
  instructions, which are loaded on demand. Skills can also carry reference files. The agent
  gets a `load_skill` tool, plus `read_skill_reference` when a skill has references.
- **Capabilities.**
  - **Nodes:** any action node from any plugin, configured as in the editor. A parameter set to
    `{{ $fromAI('key', 'description', 'type') }}` ("Let the model decide") becomes a tool argument.
    The model's arguments also override same-named parameters.
  - **Workflows:** workflows that start with **When Called by an Agent**
    (`core.workflowTrigger`). The trigger's *Arguments* become the tool's JSON schema and are
    coerced to the declared types. The output of the last node that runs is the tool result,
    and the timeline links to the execution.
  - **Sub-agents:** other agents, offered as `ask_<name>({ task })`. A sub-agent runs in its
    own child session (published version if it has one, else its draft) and doesn't see the
    conversation. Delegation stops at the calling agent's *max delegation depth*.
  - **Require approval** on any capability pauses the run before that tool executes (below).
- **Memory.** Session memory is always on: the session keeps the transcript, and the model
  sees its last 30 user turns. **Cross-session memory** adds a `remember` tool. The saved facts
  (at most 50 per agent and user) are put into the system prompt of that user's later sessions.
  A user is "you" in the test chat, `telegram:<id>` in Telegram, `workflow:<id>` from a workflow,
  and `schedule:<id>` for a schedule.
- **Triggers** (published version only):
  - **Schedules:** hourly, daily, weekly, monthly, or a five-field cron, in a time zone.
    Each fire is a new session whose user message is the schedule's *What to do*.
  - **Telegram channel:** a `messaging.telegramApi` credential, *Private* (allowed user ids or
    @usernames) or *Public*, and *New session after N idle minutes*. `/start` and `/new` start a
    new conversation. The host polls `getUpdates` through the messaging plugin's Telegram
    Trigger and replies with its Telegram node, so the bot token stays in the vault. Like the
    workflow trigger, the first poll only sets a baseline. A bot can have only one poller, so
    don't also use its token in an active Telegram Trigger workflow.
- **Settings:**

  | Setting | Default | Meaning |
  |---|---|---|
  | Max iterations | 12 | model turns per run (1–200) before the run stops with a notice |
  | Tool concurrency | 5 | tool calls of one turn that run at the same time |
  | Session token budget | 0 (off) | stop once a session has used this many input + output tokens |
  | Max delegation depth | 2 | how deep sub-agents may delegate (1–5), for the whole tree |

**Publish** snapshots the draft as version N. At most 20 versions are kept, and the builder's
"…" menu lists them. A session stays on the version it started with. Telegram conversations move
to the newest version on their next message. **Unpublish** stops schedules and channels.
**Export / Import** writes or reads the config as JSON. Import gives schedules and channels new
ids and leaves them disabled.

## How a run works

One run handles one user message, schedule fire or set of approval decisions:

1. Build the system prompt from the instructions, the skills index, the remembered facts, and the agent's name and the current time.
2. Call the model with the session's messages and the tools.
3. Run the tool calls, `toolConcurrency` at a time. A tool error is returned to the model as an error result. It does not end the run.
4. Repeat until the model answers without tool calls. The run also stops when a tool needs approval, at *max iterations*, when the token budget is used up, or on a model error. The end reason is `completed`, `awaiting_approval`, `max_iterations`, `budget`, `error` or `canceled`.

**Approvals.** When a tool with *Require approval* is called, the other calls of that turn still
run. The approval calls are saved in `session.pending`, and the session waits
(`awaiting_approval`). A person approves or denies each call. Once every call has a decision,
the run continues: approved calls execute, and denied ones return *"The user rejected the tool
call to X. STOP what you are doing and wait for the user…"* (n8n's wording). Some models
retry anyway, so a call to a just-denied tool in the very next turn is refused without asking
again, and the model has to reply. Runs that nobody
watches (schedules, Telegram, workflows, sub-agents) never pause. Approval tools are refused
there with an explanation the model can pass on.

**Sessions** are saved under `.data/agent-sessions/`, at most 200 per agent. Each one keeps:
- the model transcript;
- the UI timeline (user, assistant, tool, notice and error entries, upserted by id while streaming);
- token usage;
- one trace id per run.

The **Sessions** tab lists them by source (`test`, `schedule`, `telegram`, `workflow`, `agent`).
Only one run can be active per session.

## From workflows

- **When Called by an Agent** (`core.workflowTrigger`) makes a workflow an agent tool. **Run**
  in the editor starts from it too, with empty example values for each argument.
- **Message an Agent** (`core.messageAgent`) sends `message` to a published agent and outputs
  `{ reply, sessionId, agentId, version, endReason, usage }`. *Continue by key* keeps one session
  per key (for example `{{ $json.sessionId }}`). The node is `usableAsTool`, so an AI Agent node
  can delegate to an agent.

## API

| Route | |
|---|---|
| `GET/POST /api/agents` | list (`AgentSummary[]`), create `{ name? }` |
| `POST /api/agents/import` | `{ config }` or a bare exported config → new agent |
| `GET/PUT/DELETE /api/agents/:id` | the agent; `PUT` replaces the draft (autosave) |
| `POST/DELETE /api/agents/:id/publish` | publish the draft as a new version / unpublish |
| `POST /api/agents/:id/chat` | `{ message, sessionId? }` → SSE of `AgentStreamEvent` (draft, source `test`) |
| `POST /api/agents/:id/sessions/:sid/approvals` | `{ callId, approved }` → the same SSE stream once the run resumes |
| `GET /api/agents/:id/sessions`, `GET/DELETE /api/agents/:id/sessions/:sid` | session list / full session |
| `GET /api/agents/models?provider&credentialId&baseUrl` | `{ options: ModelOption[], error? }` |
| `GET /api/agents/workflow-tools` | workflows with `eligible` and the `reason` when they aren't |

The SSE events (`data:` lines) are:
- `run.started { sessionId, traceId }`;
- `entry { sessionId, entry }`;
- `run.finished { sessionId, status, reason, reply?, usage }`.

The same events also go to `GET /api/events` as `{ channel: 'agent', agentId, event }`. The
run keeps going if the client disconnects, and the result shows up under Sessions. Types are
in [`apps/web/src/lib/shared/agents.ts`](../apps/web/src/lib/shared/agents.ts).

## Telemetry

- **Spans** (OTel GenAI agent conventions). Each run is an `invoke_agent {name}` span with
  `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.conversation.id` (the session),
  `landflow.agent.source`, `landflow.agent.version` and `landflow.agent.end_reason`.
  - A test-chat run is a child of the HTTP span. Schedule and Telegram runs are root spans.
  - Children: `gen_ai.chat {model}` per model turn, and `execute_tool {tool}` per tool call
    (`gen_ai.tool.name`, `gen_ai.tool.call.id`, `landflow.agent.tool.kind`). A tool call
    contains the node's or plugin's spans, a workflow tool's `workflow.execute`, and a
    sub-agent's own `invoke_agent`.
- **Metrics:**
  - `landflow.agent.runs`, `landflow.agent.run.duration`;
  - `landflow.agent.tool.calls`, `landflow.agent.tool.duration`;
  - `landflow.agent.approvals` (`landflow.agent.approval.decision`);
  - `landflow.agent.tokens` (`gen_ai.token.type`).

  Model calls also count in `landflow.ai.*`. See [observability.md](observability.md).

## Limits and next steps

- **Channels.** Only Telegram, and text messages only. Slack, Discord and Linear channels
  would follow the same pattern with their plugins' triggers.
- **Knowledge.** There's no knowledge base (vector store) yet, and no web search capability.
  An HTTP Request or database node can stand in.
- **Cost and limits.** No monthly cost cap or per-model routing, both of which n8n has. The
  session token budget is the cost guard. Runs and schedules are single-process, like the
  workflow scheduler.
