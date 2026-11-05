# Agents (Preview)

Agents are standalone assistants that use your connected tools and data: you give one a persona,
a model, skills and capabilities, test it in a chat, publish it, and it then answers on a
schedule, in Telegram or Slack, or from a workflow. They are modelled on n8n's **Agents (Preview)** (see
[research/03-n8n-ai-agents.md](research/03-n8n-ai-agents.md) §8 for the n8n walkthrough). They are
separate from the **AI Agent** node, which runs inside a workflow.

| | AI Agent node | Agent |
|---|---|---|
| Lives in | a workflow (model, memory, tools wired as sub-nodes) | its own page under **Agents** |
| Runs when | the workflow runs | test chat, schedules, Telegram, Slack, the **Run an Agent** node in a workflow |
| Tools | `usableAsTool` nodes on the canvas, MCP Client Tool | any action node, workflows, other agents, MCP servers, skills |
| Memory | the Simple Memory sub-node | sessions (always) and cross-session facts per user (optional) |
| Versions | the workflow's | draft plus published versions, sessions pinned to a version |

## The roster

**Agents** in the sidebar lists your agents as cards: the avatar, name, role, description, tone words, whether it's
published (and has unpublished changes), where the published version runs (Landflow, kagent, its channels and
schedules), the model, the number of tools and skills, sessions and when it last changed. Cards are grouped by
[team](#teams) (**Group by** → **None** shows one list), and the filters show all agents, published ones, drafts, those
on kagent, or those **From marketplace**: agents a [marketplace plugin](marketplace.md#how-a-plugin-maps-to-an-agent)
installed carry a "From <plugin>" link. Search matches the name, role, description, team and tones. Each card's **⋯**
menu opens it, saves it as a template or exports its JSON.

Above the cards, **Start from a persona** shows the first built-in templates; **All templates** and **New agent** open
the New agent dialog, and **Ask the Agent architect** opens [the architect](#agent-architect).

### Templates

The **New agent** dialog starts an agent from a persona template, grouped by category: the built-in ones (Support lead,
Researcher, Incident responder, Release notes writer, Data analyst, Onboarding guide, Account researcher, and a blank
persona) and **Your templates**. Each card shows the face, description, tone words and how many rules and examples it
has. Below them you set the name, the [team](#teams) and the [avatar](#avatars), then **Create agent**: a draft with the
template's persona, instructions, skills, model (without its credential) and avatar. A template never brings tools; the
footer says which tools it suggests ("HTTP Request, your CRM, a search MCP server").

**⋯ → Save as template…** on the agent's page or its roster card saves the agent's persona, instructions, skills, model
and avatar under a name, category and description. Tools, channels, schedules, the team and the model's credential stay
with the agent; the template remembers the names of the tools (`suggests`). A saved template is shared in the agent's
home project when you may create there (everyone in that project sees it), or on the whole instance otherwise. Whoever
may create in its project (and instance admins, for an instance-wide one) can delete it from the dialog. Built-in templates live
in `apps/web/src/lib/server/agents/templates.ts`; saved ones in the `agent_templates` table, and move with their
project when it's transferred.

### Agent architect

Instead of filling in a template, you can describe the agent to the **Agent architect**: a specialist with its own face
that designs it with you. Open it from **New agent** → **Design it with the Agent architect**, or **Ask the Agent
architect** on the roster. The chat is on the left; the draft it proposes stays on the right, whole: avatar, name, role,
tone words, Always / Never rules, instructions, tools, and what you still have to finish.

The architect knows what this instance has. Its prompt lists every plugin online with the nodes an agent can use as
tools (actions whose only required inputs are main ones: the Abilities tab's own filter), within the node policy for
you. It searches them (`search_nodes`), reads their parameters (`get_node_docs`), and lists the workflows an agent can
call (those starting with **When Called by a Workflow or Agent**), the other agents, your credentials (names and types,
never values) and the persona templates. Then it proposes the whole agent (`propose_agent`); asking for a change sends
the whole agent again, built on the draft so far.

Every draft is checked before you see it:
- node types that aren't online or can't be tools are left out, and so are workflows an agent can't call and agents
  that don't exist; the draft says what was left out;
- a node tool keeps only that node's parameters, over its defaults; what the agent decides per call is a
  `$fromAI('key', 'description', 'type')` placeholder;
- an id nobody gave (a table, a channel) is dropped, as in the editor assistant;
- credentials are never set. A required credential becomes a "pick a … credential" item, naming the ones you have, and
  a required parameter left empty becomes "fill in …";
- proposing the same agent again changes nothing (local models tend to); tones and rules sent as one string, or as a
  list in brackets without quotes (`[Calm, Direct]`), are split.

Tools are actions the agent takes: how it's started (a webhook, a schedule, a chat app, a workflow) is set on the Deploy
tab, and formatting or summarising is the model's own job, so the architect adds no tool for either. What no node
online can do it leaves out and lists under **No plugin here can** ("Read firing Grafana alerts (Grafana)"), and so is a
node type it made up for an app no plugin covers. When the model names no app, or copies the format's placeholder
("App: …"), the app is the first capitalised word after the verb ("Read Grafana alerts" → Grafana). An app that is an
online plugin ("Text Toolkit") or that an online node is named after ("Slack", Messaging's Slack node) isn't missing:
the model missed it, and the architect notes what it dropped. Each is recorded as a `tool.missing` event, and the second brain's
[Missing tool](second-brain.md#4-detectors-and-suggestions) detector turns them into a "Build a tool for …" suggestion
on Home, with a sketch of the plugin to write.

The avatar, colour and team you change in the dialog stay through later drafts. **Create agent** makes a draft agent
from it (`POST /api/agents/import`); finish the open items and pick a model on its page. The architect never creates or
changes an agent itself. It uses the assistant's model (`LANDFLOW_BUILDER_MODEL` on Ollama by default, as the
[editor assistant](assistant.md)), at most 10 model calls a message. Each message is recorded in the
[second brain](second-brain.md) as a `spotlight.asked` event with `architect: true`. Code:
`apps/web/src/lib/server/assistant/architect.ts`, `apps/web/src/components/agents/architect.tsx`.

### Avatars

An agent's avatar shows on its page, the roster, the test chat, the sub-agent list and the New agent dialog, and in
place of the node's icon on the canvases wherever a node stands for the agent: Run an Agent, a Run a Team node whose lead
it is, and an A2A Agent node that calls it on kagent. Team charts and Run Trace show it for the agent too, also when a
team calls it on kagent ([agent-teams.md](agent-teams.md#the-chart)). Click it
on the agent's page to pick one of four kinds:

- **Face**: an illustrated face ([below](#faces)).
- **Icon**: one of 24 icons.
- **Initials**: one or two letters.
- **Image**: a PNG, JPEG or WebP, cropped to a square and scaled to 256 px in the browser (WebP when the browser can
  encode it), at most 200 KB as a data URL in the agent's config.

An agent made without an avatar through `POST /api/agents` (a script, the CLI, another agent) gets a face drawn from its
name, the way the New agent dialog gives one, so it doesn't show as a bare robot in team charts; an avatar sent with the
request, an icon too, is kept.

The tile takes the agent's colour, tinted (**Soft**) or filled (**Solid**). The avatar is presentation only: it never
reaches the system prompt or kagent.

### Faces

A face is put together from parts: skin tone (seven, plus a chrome robot), hair (short, side part, buzz, long, bob,
curly, bun, spiky, none) and its colour, eyes, brows, mouth, beard, glasses, and an extra (headset, earrings, an
antenna). **Shuffle** draws a random one; a new agent starts with a face seeded by a random value, and about one in
twelve shuffled faces is a robot. Faces are SVG (`FaceArt` in `apps/web/src/components/agents/avatar.tsx`); the parts
and `cleanFace()` / `randomFace()` are in `apps/web/src/lib/shared/faces.ts`. Unknown parts fall back to the default
ones when an agent is saved.

### Teams

A team is a label that groups agents on the roster: **Add to a team** under the agent's name (or the Team field of the
New agent dialog) picks an existing team or names a new one; **Remove from <team>** clears it. Teams aren't projects:
they don't change who can see or run an agent. Marketplace installs put their agents in a team named after the plugin.
Agents that work together with a lead, reporting lines and reviewers are [agent teams](agent-teams.md), a separate thing
with its own Teams view on this page.

### Taking an agent elsewhere

The builder's **…** menu has **Export JSON** (the config, for **Import JSON**), **Save as template** (a persona to start
from, never tools) and **Export as Claude Code plugin…**, which downloads the agent as a plugin in Anthropic's format
that Claude Code installs as it is and Landflow installs back whole ([marketplace.md](marketplace.md#export-agents-as-plugins)).
`GET /api/agents/:id/export?format=claude-plugin` is the same zip.

## Building an agent

**Agents** in the sidebar → **New agent** creates a draft from a [template](#templates) or the
[Agent architect](#agent-architect) and opens the builder. Everything autosaves to the
*draft*; the test chat always runs the draft. Under the agent's icon and name, **Runs on** shows where the published
version runs (Landflow, kagent, its channels and schedules) and opens the Deploy tab. The tabs:

- **Persona**: who the agent is and how it talks ([below](#the-persona)), beside the system prompt that makes.
- **Abilities**: the model, skills, capabilities and memory.
- **Deploy**: triggers and kagent.
- **Safety**: guardrails and limits.
- **Sessions** and **Evaluations**.

Older links still work: `?tab=build` opens Persona and `?tab=settings` opens Safety.

### The persona

The Persona tab builds the system prompt from parts, instead of one instructions box:

- **Who it is**: the name, a role, who it helps, what it does, and the description (shown in the agent list and to
  agents that delegate to this one), and **What I do**: up to three short lines (120 characters each) for the agent's
  card on a team page ([member cards](agent-teams.md#member-cards)). Left empty, the card takes the first sentences of
  the mission, then of the instructions (`whatIDoLines()` in `persona.ts`; the roster summary carries them as
  `whatIDo`). They are display only: `personaPrompt()` never reads them, so editing them leaves the prompt, and the
  agent deployed on kagent, as they were. The Agent architect writes them for a new agent.
- **Voice**: tone words (from the list, or your own), the answer length (one sentence, a short paragraph, or as
  detailed as needed), the language it answers in (by default, the one it's written to in), and a sign-off line.
- **Rules**: an **Always** list and a **Never** list, a sentence each.
- **Examples**: a message and the answer you'd want, up to 10. Only examples with both sides go into the prompt.
- **Instructions**: anything the parts don't cover, in your own words.

**What the model reads** shows the system prompt as you type. It comes from `personaPrompt()` in
`apps/web/src/lib/shared/persona.ts`, the function the runtime and kagent's AgentTemplate also use, so the text you see
is the text that runs here and on kagent. Each run adds the date and time and, with cross-session memory, the facts
it remembers. The parts become sections in this order:

```text
## Who you are       Role, Who you help, What you do
## How you talk      tone, length, language, sign-off
## Rules             Always: and Never: lists
## Example(s)        User: … / You: …
## Instructions      the free text
## Skills            the skills index
You are “<name>”: <description>.
```

An agent with no persona parts keeps the prompt it had: the instructions first, then the skills and the closing line
(a note at the top of the tab points to them).
The card says whether the prompt is the same as the published version's (and whether kagent runs that version) or has
changed since, and **Changes since vN** shows the difference line by line. Blank parts aren't stored (`persona` is
absent from an agent without any). Publishing needs a model, and a persona part or instructions.

- **Model** (Abilities). Pick a provider, then a credential or server, then a model:
  - Anthropic: optional `core.anthropicApi` credential, otherwise `ANTHROPIC_API_KEY`.
  - OpenAI-compatible: a `core.openAiApi` credential. Any base URL works, including Ollama's `/v1`.
  - Ollama: a base URL, default `OLLAMA_URL` or `http://127.0.0.1:11434`.

  The model list loads live (`GET /api/agents/models`). For Ollama it shows which models support tools.
- **Skills** (Abilities; [Agent Skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills)
  format). Each skill has a *when to use* line, which is always in the system prompt, and
  instructions, which are loaded on demand. Skills can also carry reference files. The agent
  gets a `load_skill` tool, plus `read_skill_reference` when a skill has references.
- **Capabilities** (Abilities).
  - **Nodes:** any action node from any plugin, configured as in the editor. A parameter set to
    `{{ $fromAI('key', 'description', 'type') }}` ("Let the model decide") becomes a tool argument.
    The model's arguments also override same-named parameters.
  - **Workflows:** workflows that start with **When Called by a Workflow or Agent**
    (`core.workflowTrigger`). The trigger's *Arguments* become the tool's JSON schema and are
    coerced to the declared types; with *Accept All Data* the tool takes any arguments. The
    output of the last node that runs is the tool result, and the timeline links to the
    execution. A workflow that starts waiting (a Wait node, a form page) goes on in the
    background and the tool returns `{ status: "waiting", executionId }`.
  - **Sub-agents:** other agents, offered as `ask_<name>({ task, reason })` (the reason, "why you are asking and what
    done looks like", is recorded in the run trace). A sub-agent runs in its
    own child session (published version if it has one, else its draft) and doesn't see the
    conversation. Delegation stops at the calling agent's *max delegation depth*.
  - **GitHub MCP** (**Add GitHub MCP**): GitHub's MCP server with a Bearer Auth credential holding a GitHub token, at
    *Read* or *Read and review* access; the allow-list is enforced on the server and merging and code writes are never
    offered ([a2a.md](a2a.md#githubs-mcp-tools-for-agents)). The Run Trace lists it as *GitHub MCP* among what the agent
    works with, and the reviews and comments it leaves appear as artifacts.
  - **MCP servers** (**Add MCP server**): a name plus the MCP Client Tool's settings (endpoint
    URL, Streamable HTTP or SSE, none / Bearer Auth / Header Auth credential, and all tools, the
    selected ones or all except some). Each run lists the server's tools (all servers in
    parallel) and offers each one with its own name, description and JSON schema; the timeline
    shows calls as "<server> · <tool>" with the MCP Client Tool's icon. A server that can't be
    reached is left out with a notice, like an offline plugin. Approval applies to all of a
    server's tools.
  - **Remote agents over A2A** (**Add A2A agent**): an agent that runs somewhere else (a kagent agent,
    for example), offered as `ask_<name>({ message, reason })`. The settings are the agent's A2A URL,
    authentication (none, Bearer or Header Auth), a timeout and *Use when* (empty: the agent card's
    description and skills). The call streams when the agent does, the timeline shows the remote
    agent's own tool calls under the tool row, and the A2A conversation carries on through the
    session. When the remote agent pauses for a tool approval, the run pauses with an approval card
    ("*landflow_text* wants to run *changeCase*") answered like any other; its questions go to the
    model. See [a2a.md](a2a.md).
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
- **Claude Code plugins** (Abilities). Plugins from the added marketplaces that the agent loads when it
  runs on kagent's Claude Code runtime (kagent card, **Runtime**: Claude Code). The picker lists
  Explore's plugins that have a `.claude-plugin/plugin.json`; the config keeps them as
  `<plugin>@<marketplace>` (at most 20). Landflow's own runtime and kagent's ADK runtime don't load
  them. Deploying pins each one to a commit and packs it into an image Landflow serves to kagent
  ([a2a.md](a2a.md#on-claude-code)).
- **Memory** (Abilities). Session memory is always on: the session keeps the transcript, and the model
  sees its last 30 user turns. **Cross-session memory** adds a `remember` tool. The saved facts
  (at most 50 per agent and user) are put into the system prompt of that user's later sessions.
  A user is "you" in the test chat, `telegram:<id>` in Telegram, `slack:<member id>` in Slack, `teams:<Entra object id>` in Teams, `workflow:<id>` from a workflow,
  and `schedule:<id>` for a schedule.
- **Triggers** (Deploy; published version only):
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
- **Guardrails** (Safety). The same checks as the Guardrails node (PII, secret keys,
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
- **Limits** (Safety):

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
  any model call until the day or month turns. The Safety tab shows today's and this month's
  usage ([observability.md](observability.md#token-and-cost-tracking)).

**Publish** snapshots the draft as version N. At most 20 versions are kept, and the builder's
"…" menu lists them. A session stays on the version it started with. Telegram conversations move
to the newest version on their next message. **Unpublish** stops schedules and channels.
**Export / Import** writes or reads the config as JSON. Import gives schedules and channels new
ids and leaves them disabled.

**kagent** (Deploy tab): **Deploy to kagent** writes the published version to a
kagent cluster (a *kagent cluster* credential) with this persona: the system prompt the runtime
builds from the persona, instructions, skills, name and description, the model, and the agent's tools,
served to kagent by Landflow. Every publish writes the new version there too. The card shows
whether kagent still holds exactly that (**In sync · vN**, **Changed in kagent** with each field
that differs, or **vN in kagent** after a publish it didn't get), the runtime's Ready condition,
the system prompt kagent holds and the agent's A2A URL, with **Redeploy** and **Remove from
kagent**. **Runtime** picks the cluster's Harness: kagent's own (ADK) or Claude Code (Codex and
own-image Harnesses are listed but can't be picked); a deployed agent can move between them, and
the card shows the runtime and, on Claude Code, the plugins at their commits. See
[a2a.md](a2a.md#landflow-agents-on-kagent).

## How a run works

One run handles one user message, schedule fire or set of approval decisions:

1. Build the system prompt from the persona and instructions, the skills index, the remembered facts, and the agent's name and the current time ([The persona](#the-persona)).
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
- **Run an Agent** (`core.messageAgent`, formerly "Message an Agent"; the type is unchanged) runs
  a published agent as a step of the flow. The agent brings its persona, skills, capabilities,
  guardrails and usage limits. Like the AI Agent, the node has three optional sub-node ports:
  - **Chat Model**: a chat model node (Ollama, Anthropic, OpenAI…) that replaces the agent's own
    model for this run.
  - **Tool**: any `usableAsTool` node, an MCP Client Tool, or a vector store in *Retrieve
    Documents (As Tool)* mode as a knowledge base. These tools join the agent's capabilities for
    the run. They run as the node's sub-nodes, so they light up on the canvas, and the agent's
    timeline shows them as `flow` tools.
  - **Memory**: a memory node that holds the conversation. Each run starts a session from its
    history (under the *Session Key* with *Continue by key*, else `default`) and saves back to
    it. Without one, *Continue by key* keeps one agent session per key (for example
    `{{ $json.sessionId }}`).

  It outputs `{ reply, sessionId, agentId, version, model, endReason, usage, steps }`, where
  `steps` lists each tool call with its kind and status. Answers and tool calls stream to the
  editor's chat panel and to streaming triggers. Tools that require approval are refused,
  because a workflow run has nobody to approve them. Each run is an agent session from the
  workflow. The node is `usableAsTool`, so an AI Agent node can delegate to an agent. It runs
  the agent on Landflow's runtime, also when the agent is deployed to kagent; to call it there,
  use the **A2A Agent** node ([a2a.md](a2a.md)).

  **Watching it run.** Each session a Run an Agent node starts carries `execution`
  (`{ workflowId, executionId, nodeId, nodeName }`), and a running session is saved as its timeline
  grows (at most every 1.5 s, plus the final save), so its tool calls, and the steps of a remote
  A2A agent in each tool entry's `remote`, can be read mid-run. In the execution view
  (`/workflows/<wf>/executions/<ex>`) an **Agent session** panel sits between the canvas and the
  logs: it opens by itself while an agent node runs and polls every 2 s, shows the agent's own
  timeline (the one of the Sessions tab, with each remote agent's commands), and stays after the
  run, with a link to the session on the agent's page. With several Run an Agent nodes, pick the
  node in the panel's header. Executions from before this change have no linked session.

  When the agent's tools are **A2A Agent** (or any) nodes connected to the Run an Agent node, each call
  is a sub-node run: the teammate lights on the canvas, with a line above it for what it does
  ("Developer · Bash: pnpm test"); select it (on the canvas, or its running row in the logs) to see
  the steps live, and under the tool call in the Agent session panel. A page opened mid-run gets the
  latest report from `GET /api/executions/:id` (`progress`) and then the live `node.progress`
  events ([a2a.md](a2a.md#the-a2a-agent-node)).

## Version history and restore

Each publish snapshots the agent as a version (the last 20 are kept). The builder's **Publish** menu lists them
with **Changed:**, the fields that differ from the version before (name, model, persona, instructions, tools,
limits and so on; the look is left out). **Restore** copies a version into the draft and publishes nothing, so you
can read it, test it and publish it as a new version. `POST /api/agents/:id/restore { version }`.

## Layers

The top of **Abilities** is a checklist of the layers around the agent's model, in the order a request passes through
them: **system prompt**, **knowledge**, **tools**, **tool access**, **guardrails**, **model router**, **cache**,
**evals** and **traces**. Each shows what is set (or why it matters), and **Set up** opens the tab and scrolls to the
setting. A layer that cannot apply is greyed out (no tools means nothing to restrict; the response cache skips agents with
tools or memory; the prompt cache is on by default for Anthropic). The score ("6 of 8") counts the layers that apply.
It reads the draft's config and the number of eval test cases, so it needs no component of its own
(`lib/shared/agent-layers.ts`).

## Model router

**Abilities → Model router** sends short, simple requests to a cheaper model and keeps the agent's own model for
everything else. Switch it on, choose the cheap model (any provider the agent could use: a local Ollama model, or an
OpenAI-compatible gateway through an OpenAI credential), and set what "easy" means:

- a message of at most **N characters** (default 400, up to 20,000);
- the agent has **no tools**, unless **Also when the agent has tools** is on (a small model calls tools less reliably);
- a resumed run (after an approval) and a run in a workflow's Run an Agent node that brings its own model always use the
  agent's own model.

The choice is made once per run, from the message, by a plain rule with no model call, so it is predictable. When the
cheap model answers, the session shows a notice (`Routed to <model>: short request (31 characters)`). The router is part
of the agent's config: it is versioned, diffed (**Changed: Router**), exported and restored like the rest. The code is
`lib/shared/agent-router.ts` (the rule) and one line in `lib/server/agents/runtime.ts`.

Because the cheap model is just a model setting, the components behind it are swappable: point it at Ollama today and at
a gateway (agentgateway, LiteLLM, OpenRouter) tomorrow without touching the agent.

**An LLM gateway.** `deploy/llm-gateway/config.yaml` runs agentgateway (the data plane the MCP gateway already uses, and the
one kgateway's own docs recommend now that its Envoy-based AI Gateway is deprecated) as one OpenAI-compatible endpoint in
front of the models: `docker compose -p landflow-infra -f deploy/compose.infra.yml --profile llm-gateway up -d llm-gateway`
serves `http://127.0.0.1:54100/v1` (admin UI on 55100). Make an **OpenAI API** credential with that base URL and no key, and an
agent (or the router's cheap model) with the OpenAI provider and a model name from the config (`ollama/qwen3.8`). Each model
the gateway offers is one entry in its config; the agent never names a provider. On Kubernetes,
`deploy/k8s/examples/llm-gateway/llm-gateway.yaml` is the same gateway as a ConfigMap, Deployment and Service
(`http://llm-gateway:3000/v1`).

## Prompt cache

Agents on an Anthropic model mark their system prompt and last tool as cache breakpoints (`cache_control: ephemeral`),
so an agent loop that resends the same prefix on every iteration pays the cached-read price for it. It is always on for
agents (it changes no answer); a prefix under the model's minimum length is simply not cached. The cached tokens show in
the session's usage, the cost ledger prices them (Settings → AI prices has the cache read and write prices) and Run Trace
shows them. Other chat model nodes are unchanged. OpenAI-compatible providers cache automatically on their side, and an
agent deployed to kagent gets whatever its runtime does: kagent itself only reports `cachedInputTokens`, and has no
response or semantic cache.

## Response cache

**Abilities → Response cache** answers a question asked again, word for word, from a stored answer with no model call.
Switch it on and choose how long an answer is kept (10 seconds to 30 days, default an hour). Case and runs of spaces are
ignored; nothing else is, so "hours?" and "opening hours?" are different questions, unless the semantic cache below is on.
**Similar questions.** Switch on **Also answer questions that mean the same** and a question with no word-for-word match
is embedded (an Ollama embedding model, `nomic-embed-text` by default, on the agent's Ollama server or `OLLAMA_URL`) and
compared with the stored ones; the closest at or above the threshold (0.7 to 0.99, default 0.92, higher is stricter)
answers, and the session says which question it was like and how alike (`similar to "…", 92% alike`). The same
conditions apply as for the exact cache, and an edit to the persona, model or guardrails starts a fresh cache. If the
embedding model can't be reached the run goes on with the agent's own model and a notice says so. The store is a
`SemanticStore` and the embedder a function (`lib/server/agents/semantic-cache.ts`), so a vector database or another
embedding model can replace either without touching the runtime.

The Insights page adds an **Agent layers** card with the same numbers for every agent over the chosen period.

The card, like the Model router's, ends with a line such as "Of the last 40 requests, 12 (30%) were answered from the
cache", counted from the notices in the agent's newest 200 sessions (`GET /api/agents/:id/layer-stats`).

A run is cached only when its answer depends on nothing but the question and the agent's config:

- it is the **first message** of a session (a later turn depends on the conversation);
- the agent has **no tools** (a tool answer may depend on live data);
- **cross-session memory** is off;
- no workflow or team supplies its own model or tools.

The key is a hash of the agent, its answer-shaping config (model, persona, instructions, skills, tools, guardrails,
router, plugins) and the question, so editing any of them starts a fresh cache; a version published earlier keeps its own
answers. A hit shows as a notice in the session (`Answered from the response cache: no model call.`) and uses no tokens.
The answer stored is the one the person got, after the output guardrail. The card shows how many answers are kept and how
often they were served again, with **Clear**; `GET/DELETE /api/agents/:id/cache`. Answers (at most 1,000 per agent) live
in `agent_response_cache` (migration 2043) behind the `ResponseCache` interface in
`lib/server/agents/response-cache.ts`, so the database adapter can be replaced by Valkey or a gateway's cache.

## Tool access

**Abilities → Tool access** decides which callers may use which tools, so one agent can read for everyone and refund
only for admins. Each rule names a **tool** (as the model sees it, or `*`), **who** it is for (a role, one user's id, a
source such as the test chat, a schedule, Telegram, Slack, a workflow or the API; every field given must match) and an
**effect**: *may use it*, *needs approval* or *may not use it*. The first rule that matches decides; a tool no rule
matches is allowed, so an agent without rules behaves exactly as before.

The check runs once at the start of a run, before the model sees any tool. A denied tool is withheld (the session shows
`<tool> is not available to you`), and an *ask* tool is offered behind the approval flow that already exists (so in a
schedule or workflow, where nobody can approve, it is refused). The caller is the session's user; a role is known only for
a person signed in to Landflow (`owner`, `admin` or `member`).

**External policy engines.** The rules are the default adapter of a small port (`lib/server/agents/policy.ts`). Set
`LANDFLOW_TOOL_POLICY` to ask an engine too, and the most restrictive answer of the rules and the engine wins:

| `LANDFLOW_TOOL_POLICY` | Needs | Asks |
|---|---|---|
| `rules` (default) | nothing | only the agent's own rules |
| `opa` | `LANDFLOW_TOOL_POLICY_URL`, the rule's data URL (for example `http://opa:8181/v1/data/landflow/tools/result`; a package URL such as `.../landflow/tools` also works, the nested `result` is read) | `POST { input: { caller, agentId, tool, kind } }`; the `result` may be `allow`, `ask`, `deny` or a boolean |
| `openfga` | `LANDFLOW_TOOL_POLICY_URL` (the server) and `LANDFLOW_OPENFGA_STORE_ID` | `POST /stores/<id>/check` with `user:<id>` `can_use` `tool:<agentId>/<tool>`; no means deny |

**Try a caller.** Under the rules, **What can they do?** takes a user id, a role and a source and shows what that caller
may do with each of the agent's tools (*may use it*, *needs approval* or *may not use it*, with the engine's reason),
using the rules on screen (saved or not) and the engine the environment names. It builds the agent's tools and calls none
(`POST /api/agents/:id/access/test`).

`LANDFLOW_TOOL_POLICY_TOKEN` is sent as a bearer token. An engine that can't be reached within 3 seconds denies the tool
(`LANDFLOW_TOOL_POLICY_FAIL=open` allows it instead). Switching engines changes these variables and nothing else.

## Eval gate

The **Evaluations** tab starts with **Eval gate**: questions the agent must keep answering well, each with an
optional expected answer. **Run on the draft** asks the agent every case (approvals denied, on sessions that are
deleted afterwards, so they never show in Sessions or reach online grading) and an LLM judge scores each reply 1–5:
*correctness* against the expected answer, or *helpfulness* when there is none. The judge is the online-grading judge
model, else the agent's own.

**Publish** runs the same check when the agent has cases. The publish is held (409, with the verdict and the run) when
the draft averages under 3 / 5, or more than 0.5 under the published version's last average. The builder says why and
offers **Publish anyway** (`{ "skipEval": true }`). A publish that passes saves its run as the new version's baseline;
a first publish is held only by the 3 / 5 floor. An agent without cases publishes as before.

Routes: `GET/POST/PUT/DELETE /api/agents/:id/eval-gate` (cases and runs; `PUT { version? }` runs the draft or a
published version). Cases (at most 50 per agent) and the last 30 runs live in `agent_eval_cases` and
`agent_eval_runs` (migration 2042); deleting the agent removes them.

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
Offline evaluations of workflows (test cases from a Data Table or an uploaded CSV/JSON file, scheduled runs and score alerts) are described in
[Evaluations](features/ai.md#evaluations). Scores live in `online_eval_scores` (the last 2,000 per agent).

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
| `GET/POST /api/agents` | list (`AgentSummary[]`, with `marketplace` on agents a marketplace install created), create `{ name?, templateId?, avatar?, color?, icon?, team? }` (an unknown template is 404) |
| `GET/POST /api/agent-templates`, `DELETE /api/agent-templates/:id` | persona [templates](#templates): built in, then saved (`canEdit`, `projectName`); save `{ agentId, name?, description?, category?, projectId? }`; delete a saved one |
| `POST /api/assistant/agent` | the [Agent architect](#agent-architect): `{ messages, draft?, model? }` → SSE of `ArchitectEvent` (`text`, `tool`, `draft`, `done`, `error`; types in `apps/web/src/lib/shared/agent-architect.ts`) |
| `POST /api/agents/import` | `{ config }` or a bare exported config → new agent |
| `GET/PUT/DELETE /api/agents/:id` | the agent; `PUT` replaces the draft (autosave; `persona` parts, blank ones dropped; `model: null` clears the model) |
| `POST/DELETE /api/agents/:id/publish` | publish the draft as a new version / unpublish; a deployed agent's publish answer has `kagent` (its status, or `{ error }`) |
| `GET/PUT/DELETE /api/agents/:id/kagent` | the agent on kagent: status (`KagentStatus`: deployment, drift, Ready, A2A URL) / deploy the published version `{ credentialId?, name?, harness? }` / remove; `GET ?credentialId=` also lists that cluster's Harnesses (`harnesses`, or `harnessError`) ([a2a.md](a2a.md#landflow-agents-on-kagent)) |
| `POST /api/mcp/agents/:id` | the agent's tools over MCP, for kagent (the bearer token in the agent's kagent Secret only); `?tools=free` / `?tools=approval` serve only the tools that run freely / need approval (Claude Code's two servers) |
| `GET /v2/…` | Landflow's OCI registry, pull only: the images of Claude Code plugins packed for kagent, by digest (public) ([a2a.md](a2a.md#on-claude-code)) |
| `POST /api/agents/:id/chat` | `{ message, sessionId? }` → SSE of `AgentStreamEvent` (draft, source `test`) |
| `POST /api/agents/:id/sessions/:sid/approvals` | `{ callId, approved }` → the same SSE stream once the run resumes |
| `POST /api/slack/events/:agentId/:channelId` | Slack Events API of the agent's Slack channel (signed by Slack) |
| `POST /api/slack/commands/:agentId/:channelId` | Slack slash commands of the agent's Slack channel (signed by Slack; answered on the `response_url`) |
| `POST /api/slack/interactions` | Slack interactivity: the Approve / Reject buttons of agents and AI Agent nodes (signed by Slack) |
| `POST /api/teams/messages/:agentId/:channelId` | Bot Framework messaging endpoint of the agent's Teams channel (bearer JWT validated) |
| `GET/POST /api/approvals/email/:token` | the links of approval emails: GET confirms, POST decides once (signed token) |
| `GET /api/insights/ai-usage?agentId=` | the agent's tokens and estimated cost: totals, per model, per day, `today` and `month` |
| `GET /api/agents/:id/sessions`, `GET/DELETE /api/agents/:id/sessions/:sid` | session list / full session (`feedback`: the thumbs up / down per reply) |
| `GET /api/agents/:id/sessions?executionId=&nodeId=` | `{ sessions }`: the full sessions (timeline included, oldest first) that a workflow run started with Run an Agent nodes, optionally of one node; the execution view's Agent session panel polls it |
| `GET /api/agents/:id/sessions/:sid/feedback`, `PUT` `{ entryId, rating: 'up' \| 'down' \| null, comment? }` | read / set the rating of one assistant reply (the Sessions tab's thumbs). A thumbs down on an agent with online grading enabled grades that reply ([Hosted chat and widget](features/ai.md#hosted-chat-and-widget)) |
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
    contains the node's or plugin's spans, a workflow tool's `workflow.execute`, a
    sub-agent's own `invoke_agent`, and a remote agent's `invoke_agent` client span, under which
    the remote agent's spans join the trace ([a2a.md](a2a.md#tracing)).
- **Metrics:**
  - `landflow.agent.runs`, `landflow.agent.run.duration`;
  - `landflow.agent.tool.calls`, `landflow.agent.tool.duration`;
  - `landflow.agent.approvals` (`landflow.agent.approval.decision`);
  - `landflow.agent.tokens` (`gen_ai.token.type`);
  - remote agents: `landflow.a2a.calls`, `landflow.a2a.call.duration`, `landflow.a2a.tokens`,
    `landflow.a2a.tool.calls`.

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
