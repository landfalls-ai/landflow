# UI review: Landflow vs n8n

A screen-by-screen pass over the Landflow web UI next to n8n (the version running locally in Docker, explored in Chrome on 2026-10-25). The visual language is Landfall's: a monochrome shell (near-white or near-black surfaces, hairline borders, pill buttons, Inter plus a mono face). The colour comes from the content: node categories, plugin brand colours and run states.

Legend: ✅ on par with n8n · ➕ beyond n8n · ◐ partial · ✗ missing

## Shell and navigation

| | n8n | Landflow | |
|---|---|---|---|
| Left sidebar | Overview, Templates, Variables, Insights, Help | Home, Workflows, Executions, Credentials, Plugins, Build a plugin; live dot; theme switch | ✅ |
| Credentials | Credentials tab: list, create from a type picker, form per type, "Connection tested successfully" | Credentials page: list with type icon, plugin and "used by N workflows"; create from a searchable type picker (types come from plugin manifests); form rendered from the type's properties; **Test connection** runs the plugin's test; stored AES-256-GCM encrypted, secrets never sent back to the browser | ✅ |
| Overview | Workflows / Credentials / Executions tabs, insight KPIs | Home: four KPI cards with coloured top bars, count-up numbers, recent executions, plugin list with brand icons | ✅ |
| Workflows list | Cards with name, last updated, owner; folders, search, tag filter, sort, import | Rows with node icons tinted by node colour, description, tags, active badge, node count; nested folders with a breadcrumb (drag a workflow onto a folder or a breadcrumb step, or Move to folder), search across folders, tag filter, sort by updated / name / created, Import from a Landflow or n8n file with a report | ✅ |
| Theme | Light, dark, system | Light, dark, system (Landfall tokens) | ✅ |
| Look | — | **New** or **Classic** under the theme switch ([the look](#the-look)) | ➕ |

### The look

A second switch under the theme switch picks the look: **New** (the default) draws the run cards and timelines from the
design review against blocks.diy (a run as a timeline, what a run did in one line, an approval with its evidence, team
members as cards, the analyst answering with a chart, building step by step); **Classic** draws the screens as they were
before them. Only the drawing changes: every feature, route and button works the same in both. The choice is kept per
browser in `localStorage` (`landflow-look`), set on `<html data-look>` before paint so a classic page never flashes the
new look, and read in components with `useLook()` / `useNewLook()` from `components/shell/look-toggle.tsx`. The git
branch `design-before-blocks` keeps the code as it was before these designs.

What the new look draws so far:

- a run as a timeline above the Run Trace's tabs, under Running now on Home and the Executions page, and on the team page
  while the team works ([run-trace.md](run-trace.md#a-run-as-a-timeline));
- what a run did, in one line (in → who → out): Home's recent runs, a finished run's Run Trace, the team's last run and
  the agent's last runs ([run-trace.md](run-trace.md#what-a-run-did-in-one-line));
- team members as cards above the team chart ([agent-teams.md](agent-teams.md#member-cards));
- the analyst answering with a chart: source chips, one "Looking across N sources…" line, and an answer card whose chart
  comes from the tool results ([second-brain.md](second-brain.md#the-analyst-agent));
- building step by step: while Spotlight builds a change, a side card ticks off its steps, the nodes it adds appear on the
  canvas as dashed ghosts (the one being made shimmers), new connections draw dashed, and a thin bar on top of the canvas
  shows how far the plan is; nothing changes until Apply ([assistant.md](assistant.md#building-step-by-step)).

## Canvas

| | n8n | Landflow | |
|---|---|---|---|
| Node shape | Square tiles, label underneath; D-shaped triggers with a bolt; wide AI Agent with diamond sub-ports | Same: 88px tiles, D-shaped triggers with a bolt, wide AI root with round sub-node ports, round sub-nodes | ✅ |
| Icons | Brand icons for apps | Plugin-published SVG icons (data URLs from the SDKs), otherwise lucide glyphs on a tint of the node colour | ✅ |
| Add from an output | "+" stub on unconnected outputs | "+" stub; also "+" on AI sub-ports and in the middle of an edge (insert a node into the connection) | ✅ |
| Run state on nodes | Green border and check, red with an x, spinner | Same, plus a rotating conic border while running, a pin mark, a breakpoint dot and the plugin transport under the label | ➕ |
| Edges after a run | Green, "N items" label | Green with an "N items" pill that pops in, dots travelling along the edge while items flow; AI edges violet with "N calls" | ➕ |
| Toolbar | Zoom, fit, tidy up, add | "+", AI builder, Tidy up (⇧⌥T), Fit view; zoom controls; minimap | ✅ |
| Execute button | Bottom centre "Execute workflow" | Bottom centre "Execute workflow" plus "Debug" with a breakpoint count, Stop, Open chat | ➕ |
| Sticky notes | Yes | Markdown notes behind the nodes (`⇧S` or the toolbar): double-click to edit, resize from the corners, seven colours that follow the theme; read-only in the Executions tab | ✅ |
| Copy/paste between workflows | JSON on the clipboard | ⌘C / ⌘X / ⌘V / ⌘D through the system clipboard with connections, notes and pinned data; taken names become `Name1`, `$('Name')` between pasted nodes follows the rename; n8n clipboard JSON is converted on paste | ✅ |
| Undo / redo | ⌘Z / ⇧⌘Z | ⌘Z / ⇧⌘Z and canvas buttons; drags, deletes, pastes and parameter typing (coalesced) | ✅ |
| Workflow menu | Settings, download, import, version history | `…` menu: Settings (error workflow, time zone, timeout, callers, saved executions), Version history (diff summary, read-only preview, restore), Download JSON, Import from file or pasted JSON (Landflow or n8n); tags in the top bar | ✅ |

## Node creator (the side menu)

| | n8n | Landflow | |
|---|---|---|---|
| Trigger first | "What triggers this workflow?": manual, app event, schedule, webhook, form, sub-workflow, chat, other | Same list for the triggers Landflow has: manually, on a schedule, on webhook call, on chat message | ◐ no form or sub-workflow trigger |
| Next step | AI, Action in an app, Data transformation, Flow, Core, Human review, Add another trigger | AI, Data transformation, Flow, Core, then **one segment per plugin** (icon, online dot, language and transport), Add another trigger | ✅ |
| App view | Header with the app icon, "Actions (n)" grouped by resource, then Triggers | Plugin view: header with the plugin's icon and colour, nodes grouped by category | ✅ |
| Search and keyboard | Search, arrows, Enter, Tab to open | Same; ←/Backspace goes back a level | ✅ |
| Placement | Chains onto the selected node | Chains onto the selected or last-added node, splits an edge when opened from one, shifts downstream nodes, pans to the new node and opens its details | ✅ |
| Plugin triggers ("On app event") | Polling and webhook triggers | Plugins publish **polling triggers** (Telegram, GitHub, RSS, Gmail, Sheets, Postgres/SQLite new rows): the host polls on the interval, keeps the state, starts a run per batch of new items. Webhook-registering app triggers are not built | ◐ |

## Node details view

| | n8n | Landflow | |
|---|---|---|---|
| Layout | Input, Parameters/Settings, Output; prev/next arrows | Same | ✅ |
| Data modes | Schema, Table, JSON | Schema (typed field tree with sample values), Table, JSON; the mode is shared and remembered | ✅ |
| Drag a field into a parameter | Yes; turns the field into an expression | Field names drag from Schema or Table and drop into any text or number parameter as `{{ $json.path }}`; the field highlights while you drag over it and switches to expression styling (fx) | ✅ |
| Expression result | Result preview under the field | Each expression shows its resolved value for the first input item (green) or the error (red), updated as you type | ✅ |
| Expression editor | Inline editor with highlighting and autocomplete | `{{ }}` highlighted in the field; autocomplete for `$json` fields from the input, `$('Node').item.json`, `$input`, `$now`, `$today`, `$workflow`, `$execution`, `$itemIndex`, `$vars` and methods for the value's type; `{{` closes itself | ✅ |
| Pin data | Pin output; edit output | Pin, Unpin, "Set test data" on triggers, "Edit output" with a JSON editor (⌘↵ saves) | ✅ |
| Run node | "Execute step" | Run node, Run from here, Breakpoint | ➕ |
| Dependent parameters | Switching Resource resets Operation to its default; collection options follow displayOptions | Same: the default comes from the property shown for the current values, dependent values reset, nested displayOptions use n8n's sibling / `/root` scoping | ✅ |
| Fixed / Expression on pickers | Every field can switch to an expression | Live-loaded pickers (channels, spreadsheets) switch to a text field for an id or `{{ expression }}` with the resolved preview; static pickers take expressions only when one is already set | ◐ |
| Credential on the node | Credential picker at the top of the parameters, "Create new credential", edit | Same: one picker per credential the node declares (only the ones its auth method needs), create and edit inline, the only matching credential is picked automatically, warning when a selected credential was deleted | ✅ |
| Poll trigger status | Not shown | A strip on poll triggers: interval, last poll, new items, next poll, link to the last run, errors, **Poll now** | ➕ |

## Running and debugging

| | n8n | Landflow | |
|---|---|---|---|
| Logs panel | Bottom panel: node runs on the left, Input/Output on the right | Same layout, plus a mini waterfall per row, sub-node calls nested under the node that made them, "Re-run task" and "Run from here" on the selected run, a raw **Events** stream, a resizable height | ➕ |
| Partial execution | Execute a step or run to a node using earlier data | Re-run one task with its earlier input, or re-run from a node with upstream results reused | ✅ |
| Breakpoints and stepping | No | Breakpoints (F9), Step (F10), Continue (F8), Stop; pause banner with the input waiting at the node; the paused node glows amber | ➕ |
| Test data for triggers | Pin data on the trigger | Same; the AI builder pins sample items automatically | ✅ |
| Build a flow from a sentence | AI workflow builder (cloud) | AI builder on a local Ollama model, validated against the live node catalogue, test data pinned on the trigger | ✅ |
| Templates | Template library (website) | Four starter flows on the empty canvas (plugins pipeline, branch and merge, webhook, AI agent) | ◐ |

## Executions

| | n8n | Landflow | |
|---|---|---|---|
| Per-workflow tab | Editor \| Executions \| Evaluations | Editor \| Executions in the top bar; the run list stays in place as you move between executions | ◐ no Evaluations |
| Run list | Cards with date, "Error in 126ms", coloured left border, mode icon, auto refresh, filter | Same, plus the error message on failed cards, re-run badges and new runs flashing into the list | ✅ |
| Preview header | Date, status and duration, size, ID; Debug in editor; Retry menu; delete | Date, status and duration, node count, ID, mode; Debug in editor; Retry/Re-run menu (currently saved or original workflow, whole run or from the failed node); delete with an in-app confirm | ✅ |
| Read-only canvas | Hatched background, run states on nodes | Same; nodes that didn't run are dimmed; a banner names the failing node with "Show node" | ✅ |
| Logs | Logs panel under the canvas | The same Logs panel as the editor, with Re-run task and Re-run from here | ➕ |
| Live runs | Shown as running | Running and paused states tick live; Step, Continue and Stop work from this screen too | ➕ |
| Global executions | Table: workflow, status, started, run time, ID, mode, row menu; error rows tinted | Same columns, status filter (All / Failed / Running with counts), workflow filter, auto refresh, row menu | ✅ |

## Plugins (no n8n equivalent)

The registry page shows each plugin with its published icon and colour, language, SDK and endpoints (gRPC and HTTP) with lease bars and latency. You can choose the transport per plugin, scan the network or add an endpoint. Node chips are tinted with each node's colour. n8n's nearest equivalent is community nodes, which are npm packages installed into the n8n process. Landflow's plugins are separate processes in any language, discovered over HTTP or gRPC.

## Remaining gaps, most useful first

1. **Webhook app triggers.** Plugins can publish polling triggers; triggers that register a webhook with the service (n8n's Telegram/GitHub/Slack event triggers) still need a lifecycle in the protocol.
2. ~~**Sticky notes** on the canvas.~~ Done.
3. **Form trigger and Execute Workflow (sub-workflow) trigger.**
4. ~~**Copy and paste nodes as JSON** across workflows.~~ Done, including n8n clipboard JSON.
5. **Evaluations tab** (n8n's test datasets for AI flows); the Editor | Executions switch leaves room for it.
6. **OAuth2 connect buttons.** Credentials take tokens and keys directly; there is no in-app consent flow ("Connect with Google").
7. **Debugger edits.** Parameter edits made while paused don't change the running debug session; they apply to the next run.
8. ~~**Expression editor.**~~ Done: highlighting and autocomplete for `$json` fields, other nodes' output, variables and methods. n8n's full-screen expression editor with a live result pane is still missing; the result shows under the field.
