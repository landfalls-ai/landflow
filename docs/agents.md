# Agents (Preview)

Agents are standalone assistants that use your connected tools and data: you give one a model,
instructions, skills and capabilities, test it in a chat, publish it, and it then answers on a
schedule, in Telegram or Slack, or from a workflow. They are modelled on n8n's **Agents (Preview)** (see
[research/03-n8n-ai-agents.md](research/03-n8n-ai-agents.md) §8 for the n8n walkthrough). They are
separate from the **AI Agent** node, which runs inside a workflow.

| | AI Agent node | Agent |
|---|---|---|
| Lives in | a workflow (model, memory, tools wired as sub-nodes) | its own page under **Agents** |
| Runs when | the workflow runs | test chat, schedules, Telegram, Slack, the **Message an Agent** node |
| Tools | `usableAsTool` nodes on the canvas, MCP Client Tool | any action node, workflows, other agents, MCP servers, skills |
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
  - **Workflows:** workflows that start with **When Called by a Workflow or Agent**
    (`core.workflowTrigger`). The trigger's *Arguments* become the tool's JSON schema and are
    coerced to the declared types; with *Accept All Data* the tool takes any arguments. The
    output of the last node that runs is the tool result, and the timeline links to the
    execution. A workflow that starts waiting (a Wait node, a form page) goes on in the
    background and the tool returns `{ status: "waiting", executionId }`.
  - **Sub-agents:** other agents, offered as `ask_<name>({ task })`. A sub-agent runs in its
    own child session (published version if it has one, else its draft) and doesn't see the
    conversation. Delegation stops at the calling agent's *max delegation depth*.
  - **MCP servers** (**Add MCP server**): a name plus the MCP Client Tool's settings (endpoint
    URL, Streamable HTTP or SSE, none / Bearer Auth / Header Auth credential, and all tools, the
    selected ones or all except some). Each run lists the server's tools (all servers in
    parallel) and offers each one with its own name, description and JSON schema; the timeline
    shows calls as "<server> · <tool>" with the MCP Client Tool's icon. A server that can't be
    reached is left out with a notice, like an offline plugin. Approval applies to all of a
    server's tools.
  - **Knowledge bases** (**Add knowledge base**): a vector store collection the agent searches
    with one tool (`search_knowledge_base({ query })` by default, renameable), returning the best
    passages with their metadata and scores. Settings: the store (SQLite in the data folder,
    Postgres PGVector with a `core.postgres` credential and table, or in-memory), the
    collection, the embeddings model (Ollama with an optional query prefix, or OpenAI-compatible
    with a credential), passages per search and vector or hybrid search. The agent only reads:
    fill the collection with a workflow, a vector store node in **Insert Documents** mode with
    the same store, collection and embeddings model (Default Data Loader in **Load Binary Files**
    mode for PDFs, DOCX and the like, optional text splitter), triggered by hand, on a schedule
    or by a webhook. A saved knowledge base also takes uploads directly: the tool's dialog has a
    **Documents** list where a PDF, DOCX, text, Markdown, HTML, CSV or JSON file (up to 25 MB) is
    read, split, embedded and added to the collection (metadata `documentId`, `fileName`, `page`,
    `chunk`), and a document can be deleted again (`GET/POST/DELETE
    /api/agents/:id/knowledge/:toolId/documents`). The store must be one that supports deletion
    by metadata (all three do). The timeline shows searches with
    the vector store's icon. In the workflow editor the same collection is reachable from an AI
    Agent with the vector store in **Retrieve Documents (As Tool)** mode.
  - **Require approval** on any capability pauses the run before that tool executes (below).
- **Memory.** Session memory is always on: the session keeps the transcript, and the model
  sees its last 30 user turns. **Cross-session memory** adds a `remember` tool. The saved facts
  (at most 50 per agent and user) are put into the system prompt of that user's later sessions.
  A user is "you" in the test chat, `telegram:<id>` in Telegram, `slack:<member id>` in Slack, `teams:<Entra object id>` in Teams, `workflow:<id>` from a workflow,
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
  - **Slack channel:** a `messaging.slackApi` credential (bot token) or a `messaging.slackOAuth2Api`
    one (Connect installs the app) with the app's **Signing Secret**, *Private* (allowed member ids
    `U…`) or *Public*, *Reply in thread* (default on) and *Slash commands* (default on). See
    [Slack](#slack) for the app setup.
  - **Microsoft Teams channel:** a `core.microsoftBotApi` credential (the Azure Bot's app id and
    client secret), *Private* (allowed Entra object ids) or *Public*. See
    [Microsoft Teams](#microsoft-teams).
- **Guardrails** (Build tab). The same checks as the Guardrails node (PII, secret keys,
  keywords, URLs, prompt injection, moderation, custom regex), set per stage:
  - **Input**: runs on the user's message before the model sees it.
  - **Output**: runs on the final answer only (not on text between tool calls).

  Each stage has an action. **Block** checks the text (the model-based checks use the agent's
  own model) and, when something is found, answers with the stage's *reply* (a default is used
  if empty); a blocked input never reaches the model and the run ends `completed`. **Sanitize**
  replaces what the pattern checks find (redacted or masked) and goes on; model-based checks
  are skipped. A check that cannot run fails closed: the text is blocked. The transcript keeps
  the cleaned text, and a blocked user message is stored as *[Message withheld by an input
  guardrail]*.
- **Settings:**

  | Setting | Default | Meaning |
  |---|---|---|
  | Max iterations | 12 | model turns per run (1–200) before the run stops with a notice |
  | Tool concurrency | 5 | tool calls of one turn that run at the same time |
  | Session token budget | 0 (off) | stop once a session has used this many input + output tokens |
  | Max delegation depth | 2 | how deep sub-agents may delegate (1–5), for the whole tree |
  | Daily token limit | 0 (off) | stop the agent's runs once it used this many tokens today (all sessions, instance time zone) |
  | Daily cost limit | 0 (off) | the same in estimated US dollars |
  | Monthly cost limit | 0 (off) | estimated US dollars this calendar month |
  | Approver emails | none | addresses that get approve / reject links when a run waits for approval ([below](#approvals-by-email)) |

  The usage limits count every model call the agent makes (sub-agents and tools that call models
  included) at the prices of Settings → AI prices. A run that reaches one stops with the reason
  `budget` and a notice saying which limit and where to change it; later runs are refused before
  any model call until the day or month turns. The Settings tab shows today's and this month's
  usage ([observability.md](observability.md#token-and-cost-tracking)).

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
again, and the model has to reply. In Slack the approval calls are posted in the thread
with **Approve** / **Reject** buttons, in Teams as an Adaptive Card with the same two actions,
and with *Approver emails* set also as email links ([below](#approvals-by-email)). Runs that nobody
watches (schedules, Telegram, workflows, sub-agents) never pause. Approval tools are refused
there with an explanation the model can pass on.

**Sessions** are saved under `.data/agent-sessions/` (agents under `.data/agents/`, memories under `.data/agent-memory/`),
or with `LANDFLOW_CONFIG_STORE=database` (the default in queue mode) in the `agent_definitions`, `agent_sessions` and
`agent_memory` tables (migration 1881; existing files are imported once), so every main and worker sees the same
agents. At most 200 sessions are kept per agent. Each one keeps:
- the model transcript;
- the UI timeline (user, assistant, tool, notice, guardrail and error entries, upserted by id while streaming; a guardrail entry names the stage, whether it blocked or sanitized, and the violations with masked matches, and appears only when something was found);
- token usage;
- one trace id per run (guardrail checks are `landflow.guardrails` spans with a `landflow.guardrails.stage` attribute, for every check).

The **Sessions** tab lists them by source (`test`, `schedule`, `telegram`, `slack`, `teams`, `workflow`, `agent`).
Only one run can be active per session.

## From workflows

- **When Called by a Workflow or Agent** (`core.workflowTrigger`, formerly "When Called by an
  Agent"; the type is unchanged) makes a workflow an agent tool, and lets other workflows run it
  with **Execute Workflow** (`core.executeWorkflow`, which maps the *Arguments* or passes its items
  through and returns the last node's output). *Input Data Mode* is *Define Arguments* or *Accept
  All Data*. **Run** in the editor starts from it too, with empty example values for each argument.
- **Message an Agent** (`core.messageAgent`) sends `message` to a published agent and outputs
  `{ reply, sessionId, agentId, version, endReason, usage }`. *Continue by key* keeps one session
  per key (for example `{{ $json.sessionId }}`). The node is `usableAsTool`, so an AI Agent node
  can delegate to an agent.

## Evaluations

The **Evaluations** tab grades the agent's conversations online, with an LLM judge:

- **Settings**: on/off, the **sample rate** (percent of finished runs that are graded), the
  **rubric** the judge grades against, the **judge model** (default: the agent's own model) and the
  score at or below which a reply is **flagged** (default 2).
- **When**: after each completed run (any source), sampled at the rate; grading runs in the
  background, one at a time, and never slows the reply. Failed and canceled runs aren't graded.
- **What the judge sees**: the conversation so far (shortened), the reply and the tools the agent
  called. It returns a 1–5 score with its reasoning.
- **What the tab shows**: graded count, mean score, flagged count, the change between the last 10
  scores and the 10 before, a 30-day trend of the daily mean (days with flagged replies in red),
  and the latest scores with a link to their session. **Grade a session** scores one now, whatever
  the sample rate.

The **AI Agent** node gets the same grading per node, under **AI Agent grading** on the workflow's
Evaluations tab (judge default: the node's chat model; evaluation and debug runs are skipped).
Offline evaluations of workflows (test cases from a Data Table or an uploaded CSV/JSON file, scheduled runs and score alerts) are described in the README's
Evaluations section. Scores live in `online_eval_scores` (the last 2,000 per agent).

## Slack

An agent answers in Slack through a Slack app of your own:

1. Create an app at <https://api.slack.com/apps>, add the bot scopes `app_mentions:read`,
   `chat:write` and `im:history`, and install it in the workspace.
2. Save a **Slack API** credential with the **Bot User OAuth Token** (`xoxb-…`) and the app's
   **Signing Secret** (Basic Information), or a **Slack OAuth2 API** credential: add the
   redirect URL its dialog shows under *OAuth & Permissions*, **Connect** installs the app and the
   host stores and renews the bot token (fill in the Signing Secret there too). Either type works
   for channels, slash commands, approval buttons and the AI Agent node's Slack approvals.
   Landflow refuses Slack requests it can't verify.
3. Add a Slack channel to the agent, pick the credential and publish. The channel shows two URLs:
   - **Event Subscriptions** → Request URL `<LANDFLOW_PUBLIC_URL>/api/slack/events/<agentId>/<channelId>`,
     bot events `app_mention` and `message.im`;
   - **Interactivity & Shortcuts** → Request URL `<LANDFLOW_PUBLIC_URL>/api/slack/interactions`;
   - **Slash Commands** (optional) → create a command such as `/ask` with Request URL
     `<LANDFLOW_PUBLIC_URL>/api/slack/commands/<agentId>/<channelId>`.

How it behaves:
- Every request is checked against the signing secret (HMAC-SHA256 of `v0:<timestamp>:<body>`,
  timestamps more than five minutes off are refused). `url_verification` answers the challenge.
- A mention or a DM runs the published agent; the reply goes into the message's thread (or the
  channel with *Reply in thread* off). Each thread is one session, so follow-ups in the thread
  keep the context. Slack retries and repeated event ids are ignored; the event is acknowledged
  at once and the answer follows.
- Tools that need approval are posted in the thread with **Approve** / **Reject** buttons. Only
  members the channel allows may click them; the message is updated with who decided, and the
  run continues in the thread. A click is accepted only when it is signed by the same Slack app
  that asked.
- **AI Agent nodes** in workflows use the same buttons: *Tools Requiring Approval* plus *Ask In:
  Slack*, a channel, optional *Approvers* (member ids) and a timeout. The execution waits (status
  *Waiting*) until every call is decided, in Slack or in the editor's chat panel / execution view
  (`POST /api/executions/:id/approvals`).

**Slash commands.** `/ask what changed today?` runs the agent with the text:
- The request is signed like events (signing secret, timestamp skew) and is acknowledged at once
  with an empty `200`: Slack allows 3 seconds. The agent's answer is posted to the command's
  `response_url` (`in_channel`, headed "`@you` ran `/ask …`"; no bot token or channel membership is
  needed). Long answers go out as several messages.
- There is **one session per user and Slack channel** (`slack:<member id>`; follow-ups keep the
  context, *Start a new session after* applies); `/ask new` (or `reset`) starts over.
- Private channels refuse people who aren't allowed (a private reply); an empty command answers
  with usage; *Slash commands* off answers "turned off"; a repeated `trigger_id` is ignored.
- Tools that need approval are posted with the same Approve / Reject buttons, also on the
  response URL: the click's own `response_url` replaces the message and carries on the answer.

The routes are public (no Landflow session); the signing secret is what authenticates Slack.
Tested against a fake Slack Web API (`apps/web/test/slack.test.ts`, `agent-channels.test.ts`).

## Microsoft Teams

An agent answers in Teams as a Bot Framework bot of your own:

1. In Azure create an **Azure Bot** (single or multi tenant; or a Teams Developer Portal bot),
   note its **Microsoft App ID** and create a **client secret**; add the *Microsoft Teams*
   channel to the bot.
2. Save a **Microsoft Bot (Teams)** credential (`core.microsoftBotApi`) with the app id and the
   secret (*Tenant ID* for single-tenant bots; *Test connection* asks the Microsoft identity
   platform for a bot token).
3. Add a Teams channel to the agent, pick the credential and publish. The channel shows the
   endpoint to set as the bot's **Messaging endpoint**:
   `<LANDFLOW_PUBLIC_URL>/api/teams/messages/<agentId>/<channelId>` (HTTPS, reachable from the internet).
4. Install the bot in Teams (a personal chat, a team or a group chat) and talk to it.

How it behaves:
- Every request carries a bearer JWT. Landflow loads the registration's OpenID metadata
  (`https://login.botframework.com/v1/.well-known/openidconfiguration`) and its JWKS, and accepts
  an RS256 token of a published key whose issuer is the metadata's, whose audience is the bot's app
  id, that is within its `nbf`/`exp` (five minutes of leeway) and whose `serviceurl` claim equals the
  activity's `serviceUrl`. Anything else is a `401`. The metadata URL is a credential field, so a
  test double can stand in; keys are cached for a day and fetched again when a new `kid` shows up.
- Messages are acknowledged at once and answered through the activity's `serviceUrl`
  (`POST /v3/conversations/<id>/activities/<activityId>`) with a bot token (client credentials,
  scope `https://api.botframework.com/.default`, cached until a minute before it expires). The
  `@mention` is stripped; `/new` starts a new conversation. Each Teams conversation (a chat, or a
  thread in a channel) is one session; repeated activity ids are ignored.
- Tools that need approval are posted as an **Adaptive Card** (1.4) with two `Action.Execute`
  buttons (Universal Actions), **Approve** and **Reject**. A click arrives as an `adaptiveCard/action`
  invoke: Landflow checks the channel's allow list and that the call still waits, answers the invoke
  at once with the card that replaces the clicked one (who decided what, no buttons), and continues
  the run in the conversation in the background. Someone the channel doesn't allow, or a second
  click, gets a message back instead and decides nothing. Each button falls back to an
  `Action.Submit` with the same data for hosts without Universal Actions; that click comes back as a
  message whose `value` is the data, and the card is replaced through the Bot Connector.
- Private channels list Entra object ids (`aadObjectId`) or Teams user ids.

The endpoint is public (no Landflow session); the JWT is what authenticates Teams. Tested against a
fake OpenID metadata, JWKS, token endpoint and Bot Connector (`apps/web/test/agent-channels.test.ts`).
Files and proactive messages are not handled.

## Approvals by email

Tools that need approval can reach people as an email with **Approve** and **Reject** links, sent
over the host's SMTP (`LANDFLOW_SMTP_*`, the same settings as invites and alerts):
- **Agents:** Settings → *Approver emails*. Whenever a run stops for approvals (the test chat,
  Slack, Teams), each address gets one email per waiting call.
- **AI Agent node:** *Ask In: Email* with *Approver Emails*; the execution waits (status *Waiting*)
  and resumes on the first decision, which can also still come from the chat panel or the
  execution view. A node without SMTP or addresses fails with a message that says so.

The links are `<LANDFLOW_PUBLIC_URL>/api/approvals/email/<token>`: a token is `<payload>.<HMAC>`
(HMAC-SHA256 under a key derived from the vault key; payload: the call, the decision, the address it
was sent to, the expiry, 24 hours or `LANDFLOW_APPROVAL_EMAIL_TTL_HOURS`). They are **single use**:
the approve and reject links of one call and address share a group, and whoever uses one first
spends the group (`approval_email_used`, migration 1830, a primary-key insert, so it holds across
processes); a decision that fails (the call was decided meanwhile) frees the link. Opening a link only
shows a confirmation page, because mail scanners fetch links; its button POSTs and decides. A tampered
or expired link is refused (`400`, `410`), a spent one answers `409`. The decider is recorded as
`email:<address>`, and when the run belonged to a Slack or Teams conversation the answer is
delivered there. The Slack message or Teams card keeps its buttons (a later click is answered
"already decided"). Tested with a captured transport (`apps/web/test/agent-channels.test.ts`) and
through the infra Mailpit (`apps/web/test/approval-email-mailpit.test.ts`, skipped when it isn't up).

## API

| Route | |
|---|---|
| `GET/POST /api/agents` | list (`AgentSummary[]`), create `{ name? }` |
| `POST /api/agents/import` | `{ config }` or a bare exported config → new agent |
| `GET/PUT/DELETE /api/agents/:id` | the agent; `PUT` replaces the draft (autosave) |
| `POST/DELETE /api/agents/:id/publish` | publish the draft as a new version / unpublish |
| `POST /api/agents/:id/chat` | `{ message, sessionId? }` → SSE of `AgentStreamEvent` (draft, source `test`) |
| `POST /api/agents/:id/sessions/:sid/approvals` | `{ callId, approved }` → the same SSE stream once the run resumes |
| `POST /api/slack/events/:agentId/:channelId` | Slack Events API of the agent's Slack channel (signed by Slack) |
| `POST /api/slack/commands/:agentId/:channelId` | Slack slash commands of the agent's Slack channel (signed by Slack; answered on the `response_url`) |
| `POST /api/slack/interactions` | Slack interactivity: the Approve / Reject buttons of agents and AI Agent nodes (signed by Slack) |
| `POST /api/teams/messages/:agentId/:channelId` | Bot Framework messaging endpoint of the agent's Teams channel (bearer JWT validated) |
| `GET/POST /api/approvals/email/:token` | the links of approval emails: GET confirms, POST decides once (signed token) |
| `GET /api/insights/ai-usage?agentId=` | the agent's tokens and estimated cost: totals, per model, per day, `today` and `month` |
| `GET /api/agents/:id/sessions`, `GET/DELETE /api/agents/:id/sessions/:sid` | session list / full session (`feedback`: the thumbs up / down per reply) |
| `GET /api/agents/:id/sessions/:sid/feedback`, `PUT` `{ entryId, rating: 'up' \| 'down' \| null, comment? }` | read / set the rating of one assistant reply (the Sessions tab's thumbs). A thumbs down on an agent with online grading enabled grades that reply (README, "Hosted chat and widget") |
| `GET /api/agents/models?provider&credentialId&baseUrl` | `{ options: ModelOption[], error? }` |
| `GET /api/agents/workflow-tools` | workflows with `eligible` and the `reason` when they aren't |
| `GET/PUT /api/agents/:id/evaluations` | online grading: `{ report: OnlineEvalReport }` (settings, scores, trend); `PUT` changes the settings |
| `POST /api/agents/:id/evaluations` | `{ sessionId }` → `{ score }`: grade that session's latest turn now |

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
  - A test-chat run is a child of the HTTP span. Schedule, Telegram and Slack runs are root spans.
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

- **Channels.** Telegram, Slack (events, slash commands) and Microsoft Teams, text messages only (no
  files from chat apps yet). Discord and Linear channels would follow the same pattern; Slack modals
  aren't handled, and a Teams bot only answers (no proactive messages).
- **Knowledge.** Knowledge bases take uploads in the builder or are filled by workflows (the data
  loader reads files too). No web search capability; an HTTP Request node can stand in. The test
  chat takes no file uploads (the hosted chat of a workflow does).
- **Cost and limits.** Daily token and cost limits and a monthly cost limit per agent, plus the
  session token budget; no per-model routing yet. Schedules and channel pollers run on the
  leader in queue mode; a run happens in the process that took the message (no worker hand-off).
