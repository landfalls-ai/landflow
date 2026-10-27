# Harnesses: running Landflow agents in Claude Code and other coding agents (plan)

Status: **plan**. The phase 0 spike is done (results below); nothing is built in the app yet. The
goal is to take an agent built in Landflow (instructions, skills, tools, approvals, memory) and
run it inside a *harness*: an agent runtime with its own loop and tools, such as Claude Code,
where it can read and edit code, run commands and use Landflow's integrations.

There are two directions, and both are needed:

| | A. Open in a harness | B. Run on a harness |
|---|---|---|
| Who drives | a developer, at the terminal or in the IDE | Landflow (test chat, schedule, Telegram, workflow node) |
| Where the agent works | the developer's checkout | a workspace Landflow manages (path or git worktree) |
| How it loads | a generated Claude Code **plugin**, opened with one command | the **Claude Agent SDK** (`claude-code` harness adapter) |
| Landflow's tools | an **MCP server** in Landflow (HTTP, per-agent token) | the same tools, in-process (SDK MCP server) |
| Approvals | Claude Code's own permission prompt | Landflow's approval cards (the SDK's `canUseTool`) |
| Sessions | Claude Code's, mirrored to Landflow through HTTP hooks (phase 2) | Landflow sessions, with the Claude Code session id kept so it can resume |

The reverse direction, Claude Code plugin to Landflow agent, already exists. See [marketplace.md](marketplace.md).

## Spike results (phase 0, Claude Code 2.1.310, Agent SDK 0.3.310, 2026-10-25)

All of these were run on this machine against a throwaway plugin (agent, skill, hooks, `.mcp.json`)
served from localhost, a logging MCP server, Ollama 0.32.5 with `qwen3-coder:30b`, and the OTLP
receiver used for Landflow's own telemetry.

| # | Question | Answer |
|---|---|---|
| 1 | Plugin agent name, `--plugin-url` on localhost | Works. The plugin loads as `<plugin>@inline`. Agents and skills are namespaced `<plugin>:<name>`, so it's `--agent landflow-demo:demo-agent`. With `--agent` the agent's body *is* the system prompt (checked in the request) |
| 2 | `${VAR}` in a plugin's `.mcp.json` headers | Expanded: the server received `Bearer tok-spike-123`. The token can stay in the environment |
| 3 | Claude Code on Ollama | Works with `ANTHROPIC_BASE_URL=http://127.0.0.1:11434 ANTHROPIC_API_KEY=ollama --model qwen3-coder:30b`, tool calls included. See the notes below |
| 4 | Agent SDK names | All present; see block 4. `canUseTool` is async, sessions can use an id the caller picks, and plugins load from a local path |
| 5 | Hooks | A `SessionStart` command hook that prints `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}` is added to the context as a system reminder. Plain stdout is added too. **HTTP hooks** (`"type": "http"`) work in plugins and post the event JSON to Landflow |
| 6 | Claude Code's OpenTelemetry | Traces, metrics and events. `OTEL_RESOURCE_ATTRIBUTES` reaches every span. **`TRACEPARENT` in the environment parents the whole session under a Landflow span** |

**MCP, as Claude Code speaks it:**
- Sequence: `server/discover`, `initialize`, `notifications/initialized`, a `GET` for SSE (405 is fine),
  `tools/list`, then `tools/call`.
- Every request carries the `Authorization` header.
- `tools/call` has `_meta: { "claudecode/toolUseId": "<id>", "progressToken": n }`. There's no `traceparent` header.
- Tool ids are `mcp__plugin_<plugin>_<server>__<tool>`.
- Tools that aren't pre-allowed are refused in `-p` mode ("Permission prompts are not available in this
  context"). Headless runs need `--allowedTools` or a permission mode. Interactive sessions ask the person.

**Hook payloads** (useful for mirroring sessions):
- Every event has `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode` and `agent_type` (`landflow-demo:demo-agent`).
- `PostToolUse` adds `tool_name`, `tool_input`, `tool_response`, `tool_use_id` and `duration_ms`. It doesn't fire for calls that were denied.
- `Stop` adds `last_assistant_message`.
- HTTP hooks interpolate `$VAR` in headers only for names listed in the hook's `allowedEnvVars`.

**Telemetry signals** (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_TRACES_EXPORTER=otlp`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, OTLP http/json):
- Spans:
  - `claude_code.interaction` → `claude_code.llm_request`, and `claude_code.tool` → `claude_code.tool.execution` and `claude_code.tool.blocked_on_user`;
  - attributes `gen_ai.tool.name`, `gen_ai.tool.call.id`, `session.id`;
  - the `tool_use_id` equals the `_meta` id on the MCP call, so the two sides can be joined.
- Metrics: `claude_code.session.count`, `claude_code.token.usage`, `claude_code.cost.usage` and `claude_code.active_time.total`.
- With `TRACEPARENT=00-<trace>-<span>-01`, all 18 spans of the run landed in that trace. The interaction span's parent was the given span, with `parent.source: "env"`.
- Claude Code sets `gen_ai.conversation.id` to its own session id, which overrides a resource attribute of the same name. Use `landflow.session.id` instead.

**Ollama notes:**
- Claude Code warns `[claude-code:unrecognized_model]` and reports a meaningless `total_cost_usd`.
- With `ANTHROPIC_API_KEY` set it also disables claude.ai connectors (printed as a warning).
- Each turn sends about 20k input tokens (Claude Code's prompt and tool definitions). `qwen3-coder:30b` runs with a 256k context, so that fits.
- The model is weaker at following the plugin than a Claude model would be:
  - it misused the `Agent` tool (`--disallowedTools Agent` helped);
  - once it reached for `Bash`/`curl` instead of the Landflow MCP tool sitting in its tool list;
  - it ignored the injected memory when asked the user's name, although the context was there.
- **Recommendation:** default coding sessions to a Claude model. Offer Ollama as "works, less reliable". Generated prompts name the exact Landflow tool ids, and Ollama launches add `--disallowedTools Agent`.

## How a Landflow agent maps onto Claude Code

| Landflow agent | Claude Code |
|---|---|
| name, description | plugin `landflow-<slug>` (`.claude-plugin/plugin.json`, version = published version or `0.0.0-draft`) with one agent `agents/<slug>.md`, launched as `--agent landflow-<slug>:<slug>` |
| instructions | the agent file's body, plus a generated "Your Landflow tools" section naming each tool's full id |
| model: Anthropic | `model:` in the agent file (the id as configured) |
| model: Ollama | no `model:` in the file. The launch adds `ANTHROPIC_BASE_URL=<server> ANTHROPIC_API_KEY=ollama … --model <model> --disallowedTools Agent` |
| model: OpenAI-compatible | not supported. The dialog says Claude Code needs a Claude model or an Anthropic-compatible endpoint (Ollama is one) |
| skills | `skills/<name>/SKILL.md`: `whenToUse` → `description`, `allowedTools` → `allowed-tools`, references copied |
| node, workflow and sub-agent tools | MCP tools served by Landflow: `mcp__plugin_landflow-<slug>_lf__<tool>`. They run in Landflow with Landflow's credentials |
| require approval | left out of the generated `--allowedTools`, so Claude Code asks (interactive) or refuses (`-p`). Annotated `destructiveHint: true` |
| session memory | Claude Code's session (`--resume`) |
| cross-session memory | `remember` / `recall` MCP tools; phase 2 adds a `SessionStart` hook that injects the saved facts as `additionalContext` |
| max iterations | `--max-turns` (CLI, not listed in `--help`) / `maxTurns` (SDK) |
| token budget | `--max-budget-usd` (CLI, `-p` only) / SDK `maxBudgetUsd` or `taskBudget`, for Claude models; for Ollama, Landflow counts the streamed usage |
| schedules, channels | direction B only (Landflow starts the run) |
| telemetry | Landflow spans for every MCP call; Claude Code's own export with `landflow.*` resource attributes, and `TRACEPARENT` when Landflow starts the session |

What Claude Code adds that Landflow's own loop doesn't have: file reading and editing, shell,
search, git, its own subagents and plan mode. That's why a coding agent is worth running there.

## Building blocks

### 1. Landflow MCP server

The bridge every harness can use: Claude Code, the Agent SDK, Codex, Gemini CLI, Cursor and
Claude Desktop.
- **Transport:** Streamable HTTP, stateless JSON responses, written by hand (about 150 lines,
  like the spike server). Claude Code's sequence is known (above) and the protocol surface is
  small, so no new dependency is needed in phase 1. Phase 3 adds `@modelcontextprotocol/sdk`
  anyway (it is a peer dependency of the Agent SDK); the handler can move onto it then.
- **Methods:** `initialize`, `notifications/initialized` (202), `ping`, `tools/list`, `tools/call`.
  Unknown methods, `server/discover` included, get JSON-RPC `-32601`. `GET` answers 405, `DELETE` 200.
- **Scope:** `/api/mcp/agents/:id` serves one agent's capabilities from `buildTools()`, plus
  `remember` / `recall` when cross-session memory is on. Skills don't go through MCP; they ship in
  the plugin. `/api/mcp` (all agents: `list_agents`, `ask_agent`) comes in phase 2.
- **Sessions:** `initialize` returns an `Mcp-Session-Id`. Calls with the same id go into one
  Landflow session (source `harness`, `harness: { type: 'claude-code' }`), so the Sessions tab
  shows what a Claude Code session did with Landflow's tools. Phase 1 checks that Claude Code
  echoes the header. Without it, calls are grouped by token and day.
- **Auth:** per-agent tokens `lf_pat_<id>_<secret>`. They are created in the dialog and shown once,
  stored as SHA-256 hashes, compared in constant time, revocable, and record `lastUsedAt`. A
  missing, revoked or wrong-agent token gets 401 with a JSON-RPC error.
- **Approvals:** see the table above. Landflow can't tell whether the person approved or
  pre-allowed the call, so the timeline entry says *approved in Claude Code*. A server-side
  confirmation through MCP elicitation is a possible phase 2 addition.

### 2. Claude Code bundle (`lib/server/harness/claude-code.ts`)

`AgentConfig` (a published version or the draft) becomes:

```
landflow-<slug>/
  .claude-plugin/plugin.json      { name, version, description, author: { name: "Landflow" } }
  agents/<slug>.md                frontmatter name, description, model?; body = instructions
                                  + "## Your Landflow tools" (full tool ids, what each does, which ask first)
  skills/<skill>/SKILL.md         + references/*
  .mcp.json                       { "mcpServers": { "lf": { "type": "http",
                                    "url": "<host>/api/mcp/agents/<id>",
                                    "headers": { "Authorization": "Bearer ${LANDFLOW_TOKEN}" } } } }
  hooks/hooks.json                phase 2 (block 5)
```

- **Naming:** the MCP server key is `lf`, not the agent name. That keeps the full tool id
  `mcp__plugin_landflow-<slug>_lf__<tool>` short. The slug is cut to 24 characters. A test checks
  every generated id against the 64-character tool-name limit; ids that would be too long are
  shortened with a hash suffix.
- **The token is never in the bundle,** the zip or a URL. It comes from `LANDFLOW_TOKEN` in the
  environment (verified, spike question 2).
- **Download auth:** `--plugin-url` and `marketplace add` can't send headers.
  - A published version's bundle has no secrets and is served without a token. The host binds to localhost.
  - A draft's bundle needs `?ticket=…`: an HMAC of agent, version and expiry (24 h), keyed from
    `LANDFLOW_ENCRYPTION_KEY`. It grants that download and nothing else.

### 3. "Open in Claude Code" (builder → "…" → dialog)

The dialog picks a version (published or draft), creates or reuses a token, and shows commands
with copy buttons. Tool ids and flags are filled in:

```bash
# Try it now, for this session only (nothing installed):
LANDFLOW_TOKEN=lf_pat_… claude \
  --plugin-url http://localhost:3000/api/agents/<id>/harness/claude-code.zip \
  --agent landflow-<slug>:<slug> \
  --allowedTools 'mcp__plugin_landflow-<slug>_lf__<tool>,…'   # every tool without "Require approval"

# Headless (CI, scripts): the same plus -p "…" --output-format stream-json
# Ollama: prefix ANTHROPIC_BASE_URL=http://127.0.0.1:11434 ANTHROPIC_API_KEY=ollama,
#         and add --model <model> --disallowedTools Agent

# Install for every project (phase 2: updates when you publish):
claude plugin marketplace add http://localhost:3000/api/harness/claude-code/marketplace.json
claude plugin install landflow-<slug>@landflow

# Commit it to a repo for the team: download the zip, unpack it into the repo, then
claude mcp add --transport http lf http://localhost:3000/api/mcp/agents/<id> \
  --header "Authorization: Bearer $LANDFLOW_TOKEN"
```

### 4. Harness adapters: Landflow runs the agent on a harness (direction B)

The contract gains a harness choice per agent. The default keeps today's loop:

```ts
type HarnessConfig =
  | { type: 'landflow' }
  | {
      type: 'claude-code';
      workspace: { kind: 'path'; path: string } | { kind: 'git'; repo: string; ref?: string; worktreePerSession: boolean };
      permissionMode: 'default' | 'acceptEdits' | 'plan';
      allowedTools?: string[];        // Claude Code tools pre-approved, e.g. ["Read", "Grep", "Bash(npm test:*)"]
      disallowedTools?: string[];
    };
// later: { type: 'codex' | 'gemini-cli' | 'opencode'; … }
```

`lib/server/harness/` gets one interface, and `runAgent` picks the adapter. Sessions, the
timeline, SSE, triggers and approvals stay as they are:

```ts
interface HarnessAdapter {
  id: HarnessConfig['type'];
  run(request: HarnessRunRequest): AsyncIterable<HarnessEvent>; // text, tool start/end, approval request, usage, done
}
```

The **`claude-code` adapter** calls `query({ prompt, options })` from
`@anthropic-ai/claude-agent-sdk` (0.3.310). The option names below are taken from its `sdk.d.ts`:

| Need | SDK option |
|---|---|
| workspace | `cwd`; extra paths with `additionalDirectories` |
| instructions | `systemPrompt: { type: 'preset', preset: 'claude_code', append: <instructions> }`, or `agent: 'landflow-<slug>:<slug>'` with the plugin below |
| skills, agent file | `plugins: [{ type: 'local', path }]`: local directories only, so the bundle is written to `.data/harness/bundles/<agent>@<version>/` |
| Landflow tools | `mcpServers: { lf: createSdkMcpServer({ name, tools: [tool(name, description, zodShape, handler)] }) }` |
| approvals | `canUseTool(toolName, input, { signal, title, displayName, decisionReason, blockedPath, mcpServer })` → `{ behavior: 'allow', updatedInput? }` or `{ behavior: 'deny', message, interrupt? }` |
| sessions | `sessionId` (Landflow picks the UUID), `resume`, `forkSession`, `persistSession`, or a custom `sessionStore` |
| limits | `maxTurns`, `maxBudgetUsd`, `taskBudget`, `abortController` |
| isolation | `settingSources: []` (ignore the user's `~/.claude`), `env` (scrubbed), `sandbox` |
| streaming | `includePartialMessages`; in-process `hooks` callbacks (`PostToolUse`, `Stop`, …) |
| tracing | `env.TRACEPARENT` = the `invoke_agent` span, plus the OTel variables (block 5) |

- **Dependencies:** peer dependencies are `@anthropic-ai/sdk >=0.93` (the repo has ^1.3.0),
  `zod ^4` (the repo has 4.6.7) and `@modelcontextprotocol/sdk ^1.29` (to add). The Claude Code
  binary comes as per-platform optional packages, or set `pathToClaudeCodeExecutable`.
- **Tool schemas:** `tool()` takes a Zod shape, and Landflow tools carry JSON Schema. Convert
  them, or fall back to the phase 1 HTTP route as an `http` MCP server with a per-run token (this
  loses the in-process span nesting). Decide this in phase 3.
- **Workspaces:** a `git` workspace is cloned once under `.data/workspaces/<agent>/`. Each session
  gets a worktree and a branch (`landflow/<session>`), so runs don't collide and every change can
  be reviewed.
- **Approvals:** `canUseTool` is async. It creates a Landflow pending call, the session shows the
  approval card (with the SDK's `title` as the text), and the callback waits for the decision.
  A timeout denies. Trust is keyed on `mcpServer.source === 'sdk'`, never on the name.
  Unattended runs deny anything not pre-allowed, as today.
- **Timeline:**
  - assistant text → `assistant`;
  - Claude Code tools (`Bash`, `Edit`, `Read`…) → `tool` with a new `kind: 'harness'`, and edits show the diff;
  - `mcp__lf__*` → the existing node, workflow and agent kinds;
  - the result message → usage and end reason;
  - at the end, a `notice` gives the branch and a diff summary.
- **Model:** Anthropic models run directly. Ollama runs through `env` as in block 3.
  OpenAI-compatible models are rejected with a clear error.

**Builder:** a *Harness* card in Settings with three choices: Landflow (built-in), Claude Code
(workspace picker, permission mode, pre-allowed tools) and "more coming". The test chat and
Sessions show harness tool calls and diffs.

### 5. Hooks and observability

- **Hooks (phase 2).** The bundle adds HTTP hooks to `/api/harness/claude-code/hooks`, with the
  token in an `Authorization: Bearer $LANDFLOW_TOKEN` header (`allowedEnvVars: ["LANDFLOW_TOKEN"]`).
  `session_id` keys a Landflow session (source `harness`):
  - `UserPromptSubmit` → a user entry;
  - `PostToolUse` → tool entries for Claude Code's own tools;
  - `Stop` → the assistant entry (`last_assistant_message`);
  - `SessionStart` → the remembered facts as `additionalContext`. Check whether an HTTP hook's JSON
    response is honored. Otherwise use a command hook that runs `curl`.
  - The first `PostToolUse` of an `mcp__plugin_landflow-…` tool carries the same `tool_use_id`
    as the MCP call's `_meta`. That links the MCP session to the Claude Code session.
- **Direction A telemetry:**
  - Each MCP request is an `mcp.request` span (`mcp.method.name`, `mcp.session.id`, `landflow.agent.id`).
  - Each call is the existing `execute_tool {tool}` span, with `gen_ai.tool.call.id` = Claude Code's
    `tool_use_id` and `landflow.agent.harness=claude-code`.
  - The dialog can also add Claude Code's own telemetry env (block 3), with
    `OTEL_RESOURCE_ATTRIBUTES=landflow.agent.id=<id>`, pointed at the collector Landflow exports to.
- **Direction B telemetry:** the run is the existing `invoke_agent` span with `landflow.agent.harness`.
  The child process gets `TRACEPARENT` (that span), the OTel variables and
  `OTEL_RESOURCE_ATTRIBUTES=landflow.agent.id=…,landflow.session.id=…`. Claude Code's interaction,
  LLM and tool spans then nest under the Landflow run, in one trace. This was verified in the spike.
- **Metrics:** the `landflow.agent.*` metrics get a `landflow.agent.harness` attribute. Claude
  Code's `claude_code.token.usage` / `cost.usage` carry the agent id. Cost is only meaningful for
  Claude models.

### 6. Security

- A coding harness can run commands and edit files, and Landflow tools carry real credentials.
- **Defaults:**
  - permission mode `default` (the CLI calls it `manual`), never `bypassPermissions`;
  - approvals stay on;
  - tokens are scoped per agent, stored hashed and revocable;
  - the token is only ever in the environment, never in a URL, zip or hook file;
  - the host binds to localhost.
- **Workspaces:** must sit outside Landflow's data directory and source tree.
- **Child processes:** get a scrubbed environment (no `LANDFLOW_ENCRYPTION_KEY` or plugin
  secrets), like marketplace node plugins, and `settingSources: []`.
- **Runs started from a channel** (Telegram) on a coding harness need an explicit allow-list of
  Telegram users and pre-allowed tools. Nobody is there to approve, and a chat message shouldn't be
  able to run arbitrary shell.
- **Draft bundles** need a download ticket. Published bundles hold no secrets.

## Phase 1 design: Open in Claude Code

| File | What |
|---|---|
| `lib/shared/agents.ts` | `SessionSource` gains `'harness'`; `AgentSession.harness?: { type: 'claude-code'; mcpSessionId?: string; claudeSessionId?: string }`; `HarnessToken` summary type |
| `lib/server/harness/tokens.ts` | token store in `.data/harness-tokens.json`: `create(agentId, label)` returns the token once; `verify(authorization)`, `revoke(id)`, `list(agentId)`. Only hashes are kept |
| `lib/server/harness/mcp.ts` | the JSON-RPC handler (block 1): `handleMcp(request, { agent, config, token })` → `Response`, `Mcp-Session-Id` issue and lookup |
| `lib/server/agents/runtime.ts` | lift `execute()` and `delegate()` out of `runAgent` into module helpers that take the session, and export `runTool({ agent, config, session, name, input, callId, signal })` so MCP calls get the same timeline entries, `execute_tool` spans and sub-agent delegation (approvals `deny`) |
| `lib/server/harness/claude-code.ts` | `bundleFiles(agent, version, host)` → `Record<path, string \| Uint8Array>`; `toolIds(config)`; `launchCommands(agent, { version, model, ticket? })`, shared by the dialog and the docs |
| `lib/server/harness/zip.ts` | `zipSync` from `fflate` (new dependency, ~8 kB, no dependencies of its own) |
| `app/api/mcp/agents/[id]/route.ts` | `POST`/`GET`/`DELETE` → `handleMcp` |
| `app/api/agents/[id]/harness/claude-code.zip/route.ts` | the zip; `?version=published\|draft\|N`, `?ticket=` for drafts |
| `app/api/agents/[id]/harness/route.ts` | `GET` → tokens (summaries), the commands, the bundle file list; `POST { label }` → new token (returned once) |
| `app/api/agents/[id]/harness/tokens/[tokenId]/route.ts` | `DELETE` → revoke |
| `lib/server/telemetry/harness.ts` | the `mcp.request` span helper and the `landflow.agent.harness` attribute |
| `components/agents/harness-dialog.tsx` | "Open in Claude Code": version, model note (Claude: your Claude Code login or `ANTHROPIC_API_KEY`; Ollama: env prefix and the reliability note; OpenAI-compatible: not supported), token create, list and revoke, tabs *Try now / Headless / Commit to a repo* with copy buttons |
| `components/agents/builder.tsx` | "…" menu item *Open in Claude Code* (next to *Export JSON*) |
| `components/agents/sessions-tab.tsx`, `timeline.tsx` | the `harness` source label; tool entries marked *approved in Claude Code* |
| `test/harness.test.ts` | below |
| `docs/harnesses.md`, `docs/agents.md`, `docs/features/ai.md` | usage, API rows |

**Tests:**
- tokens: the file holds hashes only; verify, revoke and the wrong agent;
- the bundle: frontmatter, skills and references, `.mcp.json` with `${LANDFLOW_TOKEN}` and no token, tool ids ≤ 64 characters, the allow list leaves out approval tools;
- the MCP handler: 401, initialize, tools/list matches `buildTools()`, tools/call on a core node returns its output and writes a timeline entry, an unknown tool, a notification gets 202, `-32601`;
- the zip route: unzips to the bundle, a draft without a ticket gets 403.

**Done when:**
- In a temp git repo, `claude -p --plugin-url <zip> --agent landflow-<slug>:<slug> --allowedTools …`
  calls a Landflow node tool over MCP and answers with its result:
  - with a Claude model, when an Anthropic key is available;
  - with `qwen3-coder:30b` on Ollama.
- The call appears in the agent's Sessions tab and as a span in the trace.
- The dialog is checked in Chrome, and a revoked token stops the next call.
- 141+ web tests pass and `tsc` is clean.

## Phases

| Phase | Size | Delivers | Done when |
|---|---|---|---|
| **0. Spike** | done | the answers above | — |
| **1. Open in Claude Code** | M | MCP server and tokens, zip bundle, dialog, tests (design above) | see above |
| **2. Keep it in sync** | M | Landflow marketplace for Claude Code (`marketplace.json`, updates on publish), HTTP hooks (memory, session mirroring), `/api/mcp` with `ask_agent`, telemetry env in the dialog | republishing updates the installed plugin; a Claude Code session shows its prompts, tools and reply in Sessions |
| **3. Run on Claude Code** | L | `claude-code` adapter on the Agent SDK, workspaces and worktrees, `canUseTool` approval bridge, timeline and diff entries, Harness card | from the test chat the agent fixes a failing test in a sample repo on its own branch, with a Landflow approval before `Bash`, all in one trace |
| **4. More harnesses** | S–M each | exporters and adapters for Codex CLI, Gemini CLI and OpenCode, chosen by demand | per harness, the same checks as phases 1 and 3 |

## Other harnesses

The MCP server (block 1) gives every MCP-capable client the agent's Landflow tools on day one.
Each further harness then needs an exporter (instructions, skills and MCP config in its format)
and, for direction B, an adapter (a headless run with a JSON event stream).

| Harness | Instructions, skills | MCP | Headless runs | Notes |
|---|---|---|---|---|
| Claude Code / Agent SDK | plugin: agents, skills, hooks | yes | `-p --output-format stream-json`, SDK | phases 1–3 |
| Claude Desktop, claude.ai | — | yes (local / remote MCP) | — | MCP only: "ask my Landflow agent" from chat |
| Codex CLI | `AGENTS.md` | yes | yes (JSON events) | check its current config and skill support before building |
| Gemini CLI | `GEMINI.md`, extensions | yes | yes | same |
| OpenCode, Cursor | agent/rule files | yes | partly | same |
