# Desktop agent: an agent that sees and uses a desktop, in a disposable sandbox

Status: proposed (2026-11-07). Part of the [specs](README.md). Research and a plan; no code yet.

## Problem

Landflow agents act through tools that have an API: HTTP, MCP, plugin nodes, and the [Browser plugin](../../plugins/browser/README.md), which drives
one web page through selectors and snapshots. Plenty of work has no API and is not a web page: a desktop application, a legacy admin tool, a
document in an editor, a site that fights selectors, a "click through this wizard and tell me what it said" task. For those, the model has to **look
at the screen and use the mouse and keyboard**, as a person would. Anthropic's computer-use tool is that pattern; Landflow has no node for it, and
its agent runtime cannot yet return a screenshot to the model (see section 3).

Two framings are in play and this spec keeps them apart:

1. **A Desktop agent node** inside Landflow, usable by agents and flows, with every step visible in Run Trace.
2. **A standalone product** ("a sell project") that Landflow consumes as a node. Section 2 of the design weighs it honestly; it is a decision for the
   user, not an assumption of the build.

## Decisions needed (not made yet)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Build the node at all, or wait | Build the first slice (small, local, reuses the Browser plugin's patterns). It also closes a real gap: image tool results. |
| D2 | Tool surface for the model | **Both, behind one setting.** The Anthropic computer toolset for Claude models; a plain function-tool set (`screenshot`, `click`, `type`, ...) for every other provider. See design 1.3. |
| D3 | Where the loop lives | The existing agent loop (`nodes/ai.ts`) drives the Desktop tools. A "Desktop Agent" node is a preconfigured AI Agent plus the sandbox, not a second loop. |
| D4 | Product or feature | **Feature first, product later, if ever.** Keep the sandbox a separate, versioned service with an HTTP API so the split stays possible. See design 2. |
| D5 | Which model runs it | Claude Sonnet 5.5 by default (best cost per task of the models that support the toolset); Opus 5.5 for hard tasks; local `qwen3.8` as an experiment only. |
| D6 | Is any real-world action allowed unattended | No: consequential actions (payments, sending, deleting, accepting terms) require approval, reusing the agent approval cards. |

## Design

### 1. The node

#### 1.1 Shape

Three parts, each small:

- **`services/desktop-sandbox`** (new): a container image and a tiny HTTP server inside it. One container is one session. API: `POST /session`
  (start, with a size and an optional start app), `GET /screenshot`, `POST /action` (one member action, below), `GET /info` (size, open windows,
  the current app), `DELETE /session`. The host never runs X11 itself.
- **`plugins/desktop`** (new, TypeScript SDK like `plugins/browser`): the **Desktop** node with operations **Start Session**, **Act** (one or more
  actions, returns the screenshot after), **Screenshot** and **End Session**. Usable in a flow as is, and as an agent tool. It owns the container's
  lifecycle (talks to the local Docker engine through the sandbox manager, below) and enforces the limits.
- **Desktop Agent** (a core node, `core.desktopAgent`, or a built-in template at first): the AI Agent with the Desktop tools, the system
  prompt below, the limits as node settings, and approval on for risky actions. No second agent loop.

The sandbox is created per run (or per item) and removed when the run ends, fails, is cancelled or exceeds a limit. A janitor removes any
`landflow-desktop-*` container older than its run's ceiling.

#### 1.2 Anthropic's computer use: what the API is today

Checked 2026-11-07 against the bundled Claude API references and the live computer-use tool page (`platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool`):

- **Current tool: `computer_toolset_20260801`**, one `tools` entry (`{ "type": "computer_toolset_20260801" }`), **GA, no beta header**, for Claude 5.5
  and later (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, and the Fable 5.x line support it). It takes **no `name` and no display size**,
  and an optional `configs` map to switch members off (`{"zoom": {"enabled": false}}`). It cannot share a request with a `computer_20251124` entry
  or another tool called `computer`.
- **Earlier tool: `computer_20251124`**, beta header `computer-use-2025-11-24`, for Opus 4.5/4.6/4.7 and Sonnet 4.6, with `display_width_px` and
  `display_height_px`. A Claude 5.5 model answers it with a 400 on the Claude API. (`computer_20250124` is older still.)
- **17 member tools.** Each `tool_use` block has `name` set to the member and `"toolset_name": "computer"`; the action is the block's `name`, not
  an `input.action`. Members: `screenshot`, `zoom` (`region: [x0,y0,x1,y1]`), `left_click`, `right_click`, `middle_click`, `double_click`,
  `triple_click` (`coordinate`, optional modifier `text`), `left_click_drag`, `mouse_move`, `left_mouse_down`, `left_mouse_up`,
  `cursor_position`, `scroll` (`scroll_direction`, `scroll_amount`), `type` (`text`), `key` (`text` such as `ctrl+s`, optional `repeat`),
  `hold_key`, `wait` (`duration`, up to 300 s).
- **Several calls per turn.** Claude may return a batch of `tool_use` blocks. The client runs them in order, stops at the first failure,
  answers that one with `is_error: true` and every later one with a "not executed" error. Every `tool_use` needs a `tool_result`; every
  `tool_result` must echo `"toolset_name": "computer"`.
- **Screenshots are image blocks in the tool result**: `content: [{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }]`.
  Other members can answer `"OK"`. Coordinates are in the pixel space of the screenshot returned, also after a zoom.
- **Image limits.** Up to 2,576 px on the long edge and about 3.75 MP for the 5.5 models; **oversized images are rejected, not downscaled**, so the
  client resizes. Anthropic recommends 1280x720 or 1024x768 for general desktops and 1280x800 for web apps; 1080p is the upper end.
- **It is a client-side tool**: Anthropic runs nothing, screenshots stay in our environment, and the toolset is not offered in Managed Agents.
  Anthropic's classifiers scan tool-returned screenshots for injected instructions and steer the model to check with the user; that is not a
  substitute for the controls in design 2.
- Thinking is on by default for the 5.5 line; Landflow's existing `models.ts` Anthropic path already handles the beta client, thinking blocks and
  the `fallback` echo rules, so the toolset is an additional tool type on a path that exists.

This must be re-checked at build time (tool versions have moved twice in a year). Nothing here is guessed from memory: the names above are from
those two sources.

#### 1.3 Two tool surfaces

| Surface | For | Notes |
|---|---|---|
| **Computer toolset** (`computer_toolset_20260801`) | Claude 5.5+ | The model is trained on it; supports batches and zoom. Needs the agent loop to pass a non-function tool type and echo `toolset_name`. |
| **Function tools** `desktop_screenshot`, `desktop_click(x, y, button?, count?)`, `desktop_type`, `desktop_key`, `desktop_scroll`, `desktop_drag`, `desktop_wait`, `desktop_zoom` | every other provider, and Claude as a fallback | Ordinary agent tools, one JSON schema each. Works with Ollama (`qwen3.8`), OpenAI-compatible, and any model with vision and tools. Weaker: no training on the action vocabulary. |

Both map to the same sandbox `POST /action`, so the sandbox, limits and Run Trace do not care which one the model used.

#### 1.4 Using it from agents and flows

- **As an agent tool**: the Desktop node is added like any plugin action node (the Browser node already is). One capability, "Use a desktop",
  adds the tool set for the chosen surface. Approval can be required per action class (section 2.7).
- **In a flow**: Start Session, then a Desktop Agent node whose tools carry the session id, then End Session (a run-end hook ends it anyway).
  A flow can also script fixed steps (Act with a list) with no model, for a desktop task that is deterministic once found.
- **The Web Search node** (built separately in `plugins/web-search`) is just another tool on the same agent; this spec does not design it.
  The two combine as: search finds the page or fact, the desktop does what has no API. The Browser node stays the cheaper choice for any plain
  web page; the system prompt tells the agent to prefer it and to use the desktop only when selectors will not do.

### 2. The sandbox

Landflow's rules apply unchanged: the local OrbStack Docker engine only, never the user's own desktop, no cloud, no pushed images.

#### 2.1 The container

- One image, `landflow-desktop`, built locally with `COMPOSE_BAKE=false`, based on a slim Debian or Ubuntu: **Xvfb** (virtual display, fixed
  1280x800x24), a light **window manager** (openbox or fluxbox) so windows have frames and focus, **xdotool** for input, a screenshot tool
  (`scrot` or `import`), a few fonts, and the **allowed apps** only (Firefox or Chromium, a text editor, a file manager, LibreOffice if wanted;
  an image variant per app set, not "everything").
- Runs as a non-root user, `--cap-drop=ALL`, `--security-opt no-new-privileges`, read-only root filesystem with a tmpfs home, memory and CPU
  limits, a pids limit, no Docker socket, no host mounts (files move through the API, section 2.8).
- Boot is under about ten seconds from a warm image; the first screenshot is returned only after the window manager is up and the start app
  has a window.
- Compose project `landflow-desktop`, container names `landflow-desktop-<run id>`; the janitor touches only those. No prune.

#### 2.2 Watch view (optional)

`x11vnc` (or TigerVNC) on a loopback-only port inside the container's network, with **noVNC** served by the host behind the Landflow session
and a signed, short-lived URL. The Run Trace step cards and the execution page get a "Watch live" button while the sandbox is up. **Read-only by
default**; a "Take over" toggle (the person types, the agent pauses) is a later step. Off by default: the screenshots in the journal are the audit,
the live view is a convenience. Never published beyond the host's own port.

#### 2.3 App allow-list

The sandbox's launcher is the only way to open an app (the agent has no shell). The node setting **Apps** lists what may start (a name
from the image's menu). A window that is not from an allowed process is closed by a watcher (xdotool search by PID/class) and the step is marked
a violation in the journal. The agent has **no terminal and no file-save-anywhere**: if a terminal were installed, the allow-list would be
meaningless. Default list: a browser and a text editor.

#### 2.4 Budgets

Per run, all enforced by the plugin and the host, not by the prompt:

- **Step budget**: default 40 actions, hard ceiling 150 (same shape as `maxIterations`, which the agent caps at 30 today; Desktop needs its own).
- **Wall-clock ceiling**: default 10 minutes; the sandbox is killed at it.
- **Idle detection**: three identical screenshots (a perceptual hash) after three different actions ends the run as "stuck", not "done".
- **Spend cap**: Landflow's AI usage limits already stop a run at a token or dollar cap per execution and per day
  ([features/ai.md](../features/ai.md)); the Desktop Agent sets a **default of $1.00 per run** in those limits and the node shows it.
  Screenshots are the main cost (section 5), so image size is a setting too (default 1280x800).
- **Image retention**: only the last N screenshots (default 3) go back to the model; older ones are replaced by their one-line description from
  the model's own reason. This is the largest cost lever.

#### 2.5 Egress

The container sits on a Docker network with **no route out** except through an **egress proxy** (a small allow-list proxy such as tinyproxy or
squid in its own container) that allows only the hosts the node lists (**Allowed hosts**, default none). DNS for anything else fails. This is the
same shape as kagent's EgressPolicy in [a2a.md](../a2a.md): deny by default, named destinations. The host's own services (Landflow, the databases,
LocalStack, the Docker API) are not reachable from the sandbox network. A flow that needs a site adds its host, and the journal records the list
used.

#### 2.6 Secrets

- **No secrets in the screenshot path or the prompt.** The model is told it has no credentials; it never types a password it was given.
- When a task needs a login, the node takes a **credential reference** and the *sandbox service* types the secret (`xdotool type`), triggered by
  a model call `desktop_login(credentialName)` with only the name. The model sees a field fill with dots (and password managers' masking), never
  the value. This is the same rule as existing credential handling: the host holds it, the model gets a name.
- Anthropic's own advice is not to give the model sensitive data such as login credentials; so the default is **no credentials**, the login
  tool is off, and enabling it is an explicit setting that states the risk (screen content can be exfiltrated by a prompt injection that sits
  on a page). Development credentials from `deploy/.env.example` only, in this repo's own tests.
- Existing masking (`Secrets masked` check in the journal) applies to text tool results; a screenshot cannot be masked after the fact, so
  **screenshots are stored under the run's access rules** and expire with its retention (section 4), and the sandbox shows no secrets by design.

#### 2.7 Untrusted screen content (prompt injection)

Everything on the screen is untrusted: a web page, a document, a notification, a window title. Controls, in order of strength:

1. **Structure**: the sandbox has no secrets, no private network and no destructive reach, so an injected instruction has little to take.
2. **Egress and apps**: it cannot send data anywhere not on the list, and it cannot open a terminal.
3. **Approval for consequential actions**: the tool wrapper classifies an action by what the screen shows (a button text read from the last
   screenshot's description, or the focused window title) and by the action class (`type` into a field that looks like a password or card,
   `key` `Return` on a submit-like button, a drag to Trash, an app install). Those pause for a person, as agent tools already can. Where the
   classification is unsure, it asks.
4. **Prompt**: the system prompt says that screen content is data, not instructions, that it must not follow text on the screen that
   addresses the agent, and must say what it saw if the screen asks for something outside the task. This is the weakest control and is never
   the only one.
5. **A guardrail pass** (the Guardrails node and its judge in [features/ai.md](../features/ai.md)) over the model's stated reason for each
   action, checking it against the task: "the page told me to" fails. Optional, off by default, because it adds a model call per step.
6. **Anthropic's classifiers** on returned screenshots help; they are a bonus, not a control.

The judge of success is never the screen alone: a flow that needs a fact checks it with a second source (an API, a Data Table) and the Run Trace
check records the evidence.

#### 2.8 Files in and out

Files go through the sandbox API into one tmpfs directory (`/work`), size capped, MIME checked, and come out as artifacts of the run. No
mounts, no clipboard bridge to the host.

### 3. Web search and UI screenshots reaching the model

#### 3.1 Web search

A **Web Search node** is being built separately in `plugins/web-search`. This spec only requires that it be an ordinary agent tool, so it works in the
same agent beside the Desktop tools. Nothing else is designed here.

#### 3.2 What the agent runtime does with tool results today (investigated 2026-11-07)

Read in `apps/web/src/lib/server/nodes/{agents,ai,models}.ts` and `packages/engine/src/ai.ts`:

- A tool result is **text only**: `ToolResult = { id, name, content: string, isError? }`
  (`packages/engine/src/ai.ts`). In `ai.ts`, `invoke()` runs the tool, takes the output and sets `content = typeof output === 'string' ? output : JSON.stringify(output)`.
  An image returned by a node arrives (if at all) as a base64 string inside JSON, which is both useless to the model as an image and enormous as text.
- The wire conversion is per provider in `models.ts`:
  - **Anthropic** (`toAnthropicMessages`): a `tool` message becomes a `user` message of `tool_result` blocks with `content: result.content` (a string).
    No image block, no `toolset_name`.
  - **Ollama**: `{ role: 'tool', content: result.content, tool_name }`, text only.
  - **OpenAI-compatible**: `{ role: 'tool', tool_call_id, content }`, text only (the OpenAI API accepts only text in tool messages).
- **Images already work for user messages.** A user message may carry `attachments` (`kind: 'image'`, `mimeType`, `data`), and each provider converts them:
  Anthropic `{ type: 'image', source: { type: 'base64', media_type, data } }`, Ollama's `images: [base64]` field on the message,
  OpenAI `image_url` parts with a `data:` URL. Memory keeps **references** to earlier turns' files and re-attaches them on request
  (`reattachRemembered`, size cap). So the conversion code and the storage-by-reference mechanism both exist.
- The agent's own tool surface is function tools only; there is no path to declare a provider-defined tool type such as the computer toolset.
- The streamed `tool` event truncates output to 2,000 characters, which is right for text and would break on base64.

So: **the model can see images the user attaches, but not an image a tool returns.**

#### 3.3 The smallest change that lets a screenshot reach the model

1. **Type**: `ToolResult` gains an optional `images?: { mimeType: string; data: string }[]` (or `attachments?: ModelAttachment[]`, the type that
   user messages already use, so the converters are reused). `content` stays the text description.
2. **Tool contract**: `tool.invoke()` may return `{ text, images }` (a documented shape, for example a node output whose item has `binary` and a flag
   "return as image"); the wrapper in `invoke()` splits it: text goes to `content` and the journal, images go to `images`. The Desktop node does this
   for `screenshot`/`zoom`. Everything that returns a plain value behaves as today.
3. **Anthropic**: in `toAnthropicMessages`, a result with images emits `content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', ... } }]`
   (tool_result content accepts image blocks); with the toolset, add `toolset_name: 'computer'` to the result block.
4. **Ollama and OpenAI-compatible**: tool messages cannot carry images reliably, so emit the tool message as text ("screenshot attached below") and
   follow it with a **synthetic `user` message carrying the images**, reusing `toOllamaUser`/the `image_url` path. One extra message per screenshot
   turn; no change for text-only results.
5. **Storage**: keep images out of node state and memory by reference (the `attachments` mechanism), because the agent's `progress` state is saved
   when an execution waits for an approval and base64 screenshots would bloat it. Rehydrate at wire time. Apply the **last N images** rule
   at wire time (older screenshots dropped, their text kept).
6. **Journal and stream**: send the stream `tool` event a thumbnail reference, not the bytes (the 2,000-character cut stays for text).
7. **For the computer toolset only** (Anthropic): the agent loop passes `{ type: 'computer_toolset_20260801' }` in `tools`, maps a `tool_use`
   whose `toolset_name === 'computer'` to the Desktop node's action named by the block's `name`, runs a batch in order and stops at the first
   failure, answering later ones with the "not executed" error.

Steps 1 to 6 are enough for the function-tool surface on every provider and for a Claude model on plain function tools; step 7 adds the
native toolset. Size: small and local (three files plus tests); it is also the change that any other image-returning tool (a chart node, the
Browser plugin's Screenshot) will want.

#### 3.4 Which local models can see

`ollama list` on this machine (checked 2026-11-07; nothing was pulled):

| Model | Vision | Tools | Use |
|---|---|---|---|
| `qwen3.8:latest` (27.3B, Q4_K_M, 262k context) | **yes** (`ollama show` lists `vision`, `tools`, `thinking`) | yes | the only local candidate for desktop work; slow and unproven on UIs |
| `qwen3-coder:30b` | no | yes | not usable here |
| `nomic-embed-text`, `mxbai-embed-large` | no | no | embeddings |

So a local-only desktop agent is possible in principle with `qwen3.8` and the function-tool surface. Accuracy on screen coordinates is the
open risk: small and mid-sized open models are much weaker than the Claude 5.5 line at pixel-accurate clicking, and a 27B model on this machine is slow
per step. Treat local as an experiment (a benchmark in phase 3), not a promise. A dedicated UI-grounding model (a small model that turns "the Save
button" into coordinates) is a known pattern; not planned here.

### 4. Run Trace

Each step is a journal span (same shape as an `execute_tool` span in [run-trace.md](../run-trace.md)), parented to the agent's span:

| Field | Content |
|---|---|
| actor, caller | the Desktop tool and the agent (existing) |
| action | the member (`left_click`) and its inputs (`coordinate`, `text`), the text of a `type` redacted when the field looked like a password |
| reason | the model's own note before the call (progress-update `thinking` block / text; set `thinking.display: "updates"` so it is not empty on 5.5) |
| screenshot after | an **artifact** (`ctx.artifact({ name, kind: 'screenshot', mimeType, data })` exists in every SDK) stored by reference, a thumbnail (about 320 px) and the full image |
| screen description | one line the model wrote about the screen (also what replaces an old image in the context) |
| result | ok, error, or "not executed", the step's tokens and cost, and the violation flag for an app/host breach |
| waits | an approval is the existing `wait` span with the screenshot the approver should see |

On a phone (the route `/runs/<executionId>` is already built for one): the **Story** tab shows one card per step, newest at the bottom: the
thumbnail full width, a one-line "Clicked Save at (412, 300)", the model's reason under it, a cost chip. Tap opens the existing bottom sheet
with the full screenshot (pinch to zoom; a red ring marks the click point, drawn on the client from `coordinate`, not baked in), the raw action and the
reason. Approval cards show the screenshot first, then "Allow / Reject". A strip of the last steps' thumbnails runs along the top of
the live view while the sandbox is up, next to the optional **Watch live** button. One column, cards, no tables, per the mobile-first rule.

Retention: screenshots are the heaviest data Landflow would store. Default to a run-level retention (7 days, then keep thumbnails only), a size
cap per run, and **Delete screenshots** on the run. The journal's text stays. This is also what makes the product claim of an audit trail honest:
the audit is only as long as the retention.

### 5. Cost per task (assumptions, not measurements)

Prices from the bundled Claude API reference (cached 2026-10-06; re-check): Sonnet 5.5 $2 in / $10 out per MTok, cache reads about $0.20;
Opus 5.5 $4 / $20; Haiku 5.5 $0.10 / $0.50 (prompts under 100K).

Assumptions: a 1280x800 screenshot is on the order of 1,400 image tokens (about width x height / 750, an old rule of thumb to be measured with
`count_tokens`); about 400 output tokens per step (an action plus a reason); a prompt of about 3,000 tokens (system, tools, task) plus a
growing history with the last three screenshots retained; a "task" is a 25-step job such as "find this setting in an app and report it".

| Model | Input per task | Output per task | Estimate with caching | Without |
|---|---|---|---|---|
| Haiku 5.5 | ~250K tokens | ~10K | about $0.03 to $0.10 | about $0.05 |
| **Sonnet 5.5** | ~250K | ~10K | **about $0.20 to $0.60** | about $0.60 |
| Opus 5.5 | ~250K | ~10K | about $0.40 to $1.20 | about $1.20 |
| `qwen3.8` local | same tokens | same | $0 in money; minutes of GPU time per step | n/a |

Hard tasks (60 to 100 steps, retries, bigger screens) are 3 to 5 times that. The default $1.00 cap fits a typical Sonnet task and stops a loop
early. Output-token cost is small; **screenshots dominate**, so image size, image retention, and caching decide the bill. Measure the first 20 real runs
in phase 1 and replace this table with the measurement.

### 6. As a separate product

#### 6.1 What it would be

"Desktop agent sandbox" as a product: the `landflow-desktop` sandbox service, its HTTP API, the audit viewer (a step timeline with screenshots), the
limits and approvals, packaged to run on one machine or one private cluster, and consumed by Landflow through the Desktop node. A buyer without
Landflow gets an API and a viewer; a Landflow user gets the node. Nothing in the sandbox depends on Landflow's database, so this is a packaging
question, which is why the design keeps it a separate service.

#### 6.2 The market, honestly (from general knowledge to the date of this spec; re-check before any decision)

| Category | Examples | What they are | Where a new entrant stands |
|---|---|---|---|
| **Model-vendor computer use** | Anthropic computer use (with a public reference Docker quickstart), OpenAI's computer-using agent, Google's Gemini computer use, Microsoft's computer-use in Copilot Studio | The model plus a reference loop; the vendor sells tokens, and a quickstart replaces a lot of what a thin wrapper offers | Free baseline. A wrapper that only reproduces the quickstart has no moat. |
| **Hosted desktops/browsers for agents** | E2B Desktop, Scrapybara, Orgo, Browserbase, Anchor, Steel | Pay-per-minute cloud sandboxes with an SDK | The strongest direct competitors; they are hosted and cheap, we are local only. Those who want "no data leaves the building" are not their customer. |
| **Browser-use style OSS** | browser-use, Stagehand, Skyvern, Playwright MCP, agent-browser | A DOM or accessibility-tree driven loop, often with a vision fallback | Cheaper and more reliable than pixels *for web pages*; free. Desktop (non-web) apps are what they cannot do. |
| **Consumer agents** | Operator-style products, Manus | A finished assistant for a person | Different buyer. |
| **RPA** | UiPath (now with agentic features and "screen" agents), Automation Anywhere, Blue Prism, Microsoft Power Automate (desktop flows) | Deterministic recorded bots plus orchestration, governance, a large installed base and partners | The money is here and so is the moat (selectors/recorders, orchestrators, auditors, compliance, sales channel). AI computer use is a threat to RPA and these vendors are adding it; a small entrant sells no governance and no support. |

**Who would pay:** a team with a legacy desktop or a locked-down app and no API, a regulated team that must keep screens and data in its own building
(finance back office, public sector, health IT, a QA group), a consultancy automating a client's old tool. They pay for **an auditable, contained
agent they can approve**, not for clicking.

**The differentiator, if there is one:**

1. **Audit of every screenshot and action** in Run Trace, phone-readable and approvable, with who approved. Most computer-use demos have a final
   answer and a log; few have a reviewable per-step record with approvals.
2. **Local only**: a container on the buyer's own engine, egress allow-listed, no screens leaving the machine (with a local model; with a
   Claude model, screenshots still go to the API, which must be said plainly and is a real limit on this claim).
3. **Workflow integration**: it is a node, so a desktop task sits between an API call and a human approval in one flow, with budgets and caps. This is
   Landflow's differentiator rather than the sandbox's.

**Risks to such a business:**

- **Commoditisation by the model vendors.** Each model release improves computer use and the vendors ship the sandbox, a hosted tool or a
  managed agent. The wrapper loses value as the model improves; what remains is governance and integration.
- **Reliability is not product-grade.** Pixel agents fail on odd dialogs, slow apps, captchas and multi-monitor/HiDPI; customers compare with
  RPA's determinism. A 70 to 90 percent success rate is a demo, not an SLA.
- **Security liability.** Prompt injection through screen content is unsolved. A sold product inherits the blame for what the agent did.
- **Terms of service and law.** Automating sites against their terms, scraping, automating logged-in banking: the buyer's risk becomes ours as the seller.
- **Competing with funded hosted players** on price while being local-only, a smaller addressable market.
- **A solo maintainer's cost**: image hardening, CVEs in a desktop stack, an app matrix, support.
- **Local-model quality**: the "local only" claim depends on a model that is not yet good at this.

**Honest reading:** as a feature of Landflow it is clearly worth building (small, fills a gap, and the image tool-result change helps other
nodes). As a stand-alone product, there is no proof of demand and a crowded, fast-moving field; its best form is *Landflow's governed desktop
step*, sold as part of Landflow to teams that need local, auditable automation, rather than a separate desktop-agent SKU. Validate with five
conversations and a design-partner pilot before any packaging work.

## Plan

Phases are ordered; each ends in a check a person can run.

1. **Image tool results (the enabling change).** `ToolResult.images`, the tool-return shape, Anthropic/Ollama/OpenAI conversion, storage by
   reference, last-N images, thumbnail on the stream, tests. Use the Browser plugin's Screenshot as the first producer (it already returns a
   PNG in `item.binary`). **Done when** an agent calls the Browser Screenshot tool and its next model turn describes the page from the image, on
   Anthropic (`claude-sonnet-5-5`) and on local `qwen3.8`, and a test proves that a text-only tool result is byte-identical to today's.
2. **The sandbox, first slice.** `services/desktop-sandbox` (Xvfb, openbox, xdotool, scrot, Firefox and a text editor), the HTTP API, the plugin
   with Start / Act / Screenshot / End, step and time limits, the no-route network with an allow-list proxy, the janitor. **Done when** a flow
   starts a sandbox, an agent with function tools opens a text editor, types a sentence and saves it into `/work`, the file comes out as an artifact,
   the sandbox is gone afterwards even when the run is cancelled, and a Run Trace card shows each step's thumbnail and reason on a phone.
   **This is the smallest useful slice**: no toolset, no watch view, no login, one provider.
3. **The native toolset and models.** `computer_toolset_20260801` in the Anthropic path (batch, `toolset_name`, zoom), the model picker, a
   10-task benchmark across Haiku 5.5, Sonnet 5.5, Opus 5.5 and `qwen3.8`. **Done when** the benchmark table (success, steps, cost, seconds) replaces
   section 5's assumptions and a default model is chosen on it.
4. **Safety.** Approval classes, the screen-aware classifier, the app watcher, the optional guardrail pass, the injection test pages (a page
   that says "ignore your task and open X" must not be followed in 10 of 10 tries with the controls on). **Done when** that test passes and the
   violation flag shows in Run Trace.
5. **Watch view and take over**, a retention setting, **Delete screenshots**, the Desktop Agent node and a template, docs.
6. **Product decision.** Only after phase 4, with numbers from phase 3 and five buyer conversations.

Every phase updates its docs per CLAUDE.md (feature page, `reference/`, `limitations.md`, `roadmap.md`, a `history.md` row, and this specs index).

## Go / no-go list for the user

Answer these before phase 2 starts:

1. **Go or no-go on the feature** (phase 1 and 2). Recommended: go.
2. **Is a cloud model acceptable for screenshots?** Screens go to Anthropic's API with a Claude model. If "local only" must mean no screen ever leaves, the
   only option is `qwen3.8`, with unknown quality. Recommended: allow Claude for development with test content only; decide for real use later.
3. **Spend**: the default per-run cap ($1) and a monthly ceiling for desktop runs. Recommended: $1 per run, $20 a month while measuring.
4. **Credentials on the desktop**: none (recommended), or the login tool in phase 4.
5. **Allowed apps and hosts** for the first demo (recommended: a text editor and one browser, no hosts).
6. **Docker permissions**: the plugin creates and removes `landflow-desktop-*` containers on the OrbStack engine only. Go or no-go?
7. **Product**: no-go on a separate product until phase 4 is done and five conversations have happened. Recommended.
8. **Screenshot retention** default (7 days then thumbnails; or shorter).

## Risks

- **Pixel agents are unreliable and slow**: tasks take minutes and fail at odd dialogs. Mitigate with step and time budgets, a stuck detector,
  and by preferring the Browser node and APIs; report honestly in the node docs.
- **Prompt injection from the screen** (section 2.7): structure first, approval second, prompt last.
- **Cost surprises** from screenshots: image retention, size and caching, the cap, and the benchmark in phase 3.
- **Sandbox escape or abuse**: no Docker socket, dropped capabilities, no host mounts, no route except the proxy, a janitor, never the user's
  desktop. A vulnerable browser is a container risk, so keep the image current and small.
- **Storage growth** from screenshots, and what they contain (private data seen on screen): retention and deletion, access by run rules.
- **API drift**: the tool type changed twice in a year; the toolset is isolated in one adapter with a test that fails on a 400 naming the type.
- **Provider differences**: tool messages carry no images in Ollama or OpenAI; the synthetic user-message route is the workaround and costs a message.
- **Resolution and HiDPI**: coordinates must map to the returned image; the sandbox is fixed at one size so there is no scaling math.

## Open questions

- What does the plugin tool wrapper do with a node's `item.binary` today, exactly (it looks as if the output is JSON-stringified)? Phase 1 starts by reading
  `lib/server/nodes/ai.ts` `invoke()` and the plugin tool path, and chooses between a return convention and an explicit "return as image" parameter.
- Does the Anthropic path in `models.ts` accept a non-function tool type through the current typed beta client, or does it need a cast?
- Can `tool_result` image blocks and `toolset_name` be sent through the beta messages client the host uses, without the SDK version rising?
- Where do screenshots live: the existing file store (as `attachments` do) or the journal's artifact store? Preference: the file store, with the journal
  holding the reference.
- Is a perceptual hash for stuck detection enough, or is the model's own "nothing changed" note needed?
- Which window manager and which Firefox/Chromium build give the most stable screenshots in a container on Apple Silicon (arm64 images, no x86 emulation)?
- Can the allow-list proxy see HTTPS destinations without breaking TLS (CONNECT host only is enough; no interception planned).
- Does a local UI-grounding model beat `qwen3.8` on its own, and is it worth a phase?

## Not planned here

The user's real desktop or any host display, macOS/Windows guest desktops (licensing and VMs), a cloud-hosted fleet, multi-user shared sandboxes, mobile
device farms, recording and replaying a session as a deterministic script (RPA-style; a later idea), CAPTCHA solving, designing the Web Search node,
a UI-grounding model, billing or a licence system for the product framing.
