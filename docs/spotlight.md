# Spotlight, Home 2.0 and the action layer (plan)

Status: **in progress**. Written 2026-10-27 at commit 493177a. **Spotlight in the editor is built** (2026-10-27): the bar at
the bottom of the canvas with suggestion bubbles, `@` mentions and node-type completion, replacing the Assistant panel;
[assistant.md](assistant.md#spotlight) documents it. The new Home, Spotlight on the other pages and the action layer are
still a plan. An interactive version with UI
mockups is the artifact <https://claude.ai/artifact/3FPJ1Ci3Jb8K3oJfjcvV8F> (private to the owner). The screen-by-screen
simplification review that goes with it is [ux-simplification.md](ux-simplification.md).

Three parts:

1. **Home 2.0**: the first screen answers "what needs me?" before "how are we doing?".
2. **Spotlight**: a ⌘K bar docked at the bottom of every screen. It knows the page, lets you tag any resource with `@`,
   runs actions with `/`, and has an agent that can create and change things.
3. **The action layer**: the only way Spotlight (and the instance MCP server) changes anything. The agent proposes;
   the layer validates, checks access and stores a plan; only the user's click applies it.

## 1. Home 2.0

Today `apps/web/src/app/page.tsx` shows four counters (Workflows, Executions 24h, Failed 24h, Plugins online), the last
eight executions and the plugin list. On a real instance the eight rows are often the same workflow, and the plugin
list takes half the screen while every plugin is fine.

The new Home, top to bottom, with a 24h / 7 days / 30 days switch:

| Block | Question it answers | Data |
|---|---|---|
| **Needs you** | What is broken or waiting for me? | Failed runs grouped by workflow and error, credentials whose last test failed, agent and AI Agent approvals, publish requests the user can approve, offline plugins, alert and evaluation-score events. Each row has one or two buttons (Ask, Runs, Review). A row leaves once resolved or marked seen. |
| **KPIs** | Better or worse? | Runs, failure rate, time saved (from `insightsReport`, with the previous period for the delta), p95 duration (new), AI cost (`/api/insights/ai-usage`). Each tile has a sparkline and opens Insights. |
| **Runs chart and live** | When did it go wrong; what is happening now? | Insights series stacked succeeded/failed; running and waiting counts from `/api/events`; plugin health from the registry. |
| **Rankings** | Where to look first? | Insights rows sorted four ways: most failures, slowest p95, time saved, AI spend. |
| **Continue** | What was I doing? | Recently edited workflows and agents by the user, and Spotlight conversations with unapplied plans. |

Served by one new route, `GET /api/home?period=`, scoped to the projects the user can see (`filterVisible`).
"Plugins online" leaves the KPIs; plugins appear on Home only when one is offline. The header's primary action is
"New workflow"; the demo links move to an empty-state card for new instances.

## 2. Spotlight

Opens with ⌘K or a click on the bar; a bottom sheet on phones. It replaces the editor's Assistant panel and builder
chat (⌘I), "Describe a workflow" and most jump-to buttons. Three speeds:

| Mode | Model | What it does |
|---|---|---|
| **Go** | none | Search workflows, nodes inside them, executions, credentials (names only), data tables, agents, plugins, projects. Filtered by access, ranked by recency and the current project. Enter opens. |
| **Do** | none | `/` lists the actions the page allows (`/run`, `/retry`, `/new table`, `/publish`…). A choice opens a form generated from the action's input schema, then the same plan card Ask uses. |
| **Ask** | the builder model | Plain language with tagged resources. The agent reads what the user can read and proposes plan cards. Nothing changes until Apply. |

**Context.** Each page registers chips (`useSpotlightContext()`), shown in the bar and removable:

| Page | Chips | Digest the agent gets (never full data, never secrets) |
|---|---|---|
| Home | Home, period | Needs-you items and KPI numbers |
| Workflows, a folder | project, folder | names, status, failure counts of visible workflows |
| Editor | workflow, selected nodes | outline, selected nodes' parameters, last run digest (today's builder-chat context) |
| A run | run, failed node | status, error, first 3 items per node, clipped (`digestRun`) |
| Credentials | credential | name, type, users, last test result |
| A data table | table | columns and sample rows |
| Agent builder | agent | settings without secrets, recent session summaries |

**Tagging.** `@` searches every resource type; `@Invoice sync ›` steps into a workflow's nodes and runs. A chosen result
becomes a chip and travels as a structured reference (`{ type: "node", workflowId, nodeId }`), not as text. The server
resolves references with the user's permissions; something the user cannot see resolves to "not found".

**Plan cards.** A proposal renders as a card: a summary, the diff (the assistant's existing diff rendering for workflow
edits), checks (role, environment protection, four-eyes, draft vs live), outside effects ("Calls Stripe: creates up to 6
invoices"), and buttons (Apply, Open in editor, Dismiss). Applying leaves a receipt with Undo when reversible and the
audit event id. Credential values never pass through the agent: a `secret` action's card opens a secure form that
posts straight to the vault.

In the editor, Ask is the builder chat: the same ops (`lib/shared/assistant-ops.ts`), diff and undo as
[assistant.md](assistant.md) describes. After-run suggestions stay. **Built:** the editor's Spotlight
([assistant.md](assistant.md#spotlight)) is this bar for one page. Its bubbles (`lib/shared/spotlight.ts`) are the
first version of Go and `@`: they complete canvas nodes and the node types the workflow may use, and suggest what to ask,
without a model call. The chat it sends to uses only the node types the workflow allows (`assistant/scope.ts`).
**Also built:** [Test and fix](assistant.md#test-and-fix), which runs the workflow, has failures fixed until a run passes,
and then offers to publish it. While it works, the conversation waits in a card at the side of the canvas.

## 3. The action layer

Spotlight's agent has no network access, no API keys and no route access. Its tools are find, read, describe and
propose. Every change goes through a catalog of typed actions that all callers share:

```
Spotlight Go/Do ─┐
Spotlight Ask ───┤ (propose only)       ┌─ store, governedSave
instance MCP ────┼──► action layer ─────┼─ runner (run, retry, stop)
CLI (later) ─────┤   catalog · gate     ├─ data tables, variables, folders
Home buttons ────┘   plans · apply      ├─ credentials vault (secure form only)
                     audit · undo       └─ audit log, OpenTelemetry
```

### An action

```ts
export const createDataTable = defineAction({
  id: 'dataTable.create',
  title: 'Create data table',
  kind: 'create', // read | create | update | run | publish | delete | secret
  input: z.object({ name: z.string().min(1), projectId: z.string().optional(), columns: z.array(columnSchema).max(100) }),
  permission: ({ input }) => ({ kind: 'dataTable', action: 'create', project: input.projectId }),
  async plan({ input, actor }) {
    const project = creationProject(actor, input.projectId);
    return {
      summary: `Create “${input.name}” in ${project.name}`,
      changes: [{ op: '+', type: 'dataTable', name: input.name, detail: input.columns }],
      warnings: nameTaken(project, input.name) ? ['A table with this name exists'] : [],
    };
  },
  async apply({ input, actor }) {
    const table = dataTables.create(actor, input);
    return { resources: [ref('dataTable', table.id)], undo: { action: 'dataTable.delete', input: { id: table.id } } };
  },
});
```

The catalog turns one definition into the agent's tool schema, the `/` form and the MCP tool, so they cannot drift.
`lib/server/mcp/instance-tools.ts` repeats access and governance checks by hand today; it moves onto the catalog.

### Flow

1. The user asks; the bar sends the message, the page digest and the `@` references to `POST /api/spotlight/chat` (SSE,
   like `/api/assistant/chat`).
2. The agent calls read tools, which run at once and return only what the user may see.
3. The agent calls `propose(actionId, input)`. The layer validates the input, runs the gate, computes the plan and
   stores it. The agent's turn ends; it has no tool that applies.
4. The user clicks Apply. The browser calls `POST /api/actions/plans/:planId/apply` with the user's session.
5. The layer re-checks the plan (stale resources are re-planned), applies it as one step, records the audit event and
   returns a receipt.

### Plans

- Stored in a new `action_plans` table (migration 1890) so any main in queue mode can apply them; receipts in
  `action_receipts`.
- A plan records the versions of the resources it read. If one changed, the plan is **stale**: the card shows the new
  diff before it can be applied.
- Plans expire after 15 minutes; receipts keep their undo for 24 hours.

### Risk tiers

| Kind | Examples | In Spotlight |
|---|---|---|
| read | search, workflow, run digest, insights | runs at once, shown as an activity line |
| create, update | table, workflow draft edit, variable, folder | plan card, one click, Undo |
| run | run workflow, retry runs, stop | plan card naming the outside services it calls; no undo |
| publish | publish, activate, deactivate | plan card; four-eyes turns it into a publish request |
| delete | workflow, rows, runs | typed-name confirmation; not offered to Ask by default |
| secret | credential values | never through the model; a secure form |

### First catalog (about 25 actions)

| Area | Actions | Built on |
|---|---|---|
| Find and read | `search` `workflow.get` `run.get` `run.search` `nodeType.search` `nodeType.get` `insights.query` `credential.list` `table.query` | store, registry, `insightsReport`, assistant research (`assistant/research.ts`) |
| Workflows | `workflow.create` (blank or described) `workflow.edit` (assistant ops) `workflow.move` `workflow.tag` `workflow.publish` `workflow.activate` | `applyOps`, flow builder, `governedSave`, publish requests |
| Runs | `workflow.run` `run.retry` `run.stop` `approval.decide` (user click only) | runner, retries, approvals |
| Data | `table.create` `table.addRows` `variable.set` `folder.create` | data tables, variables, folders |
| Connections, agents | `credential.create` (secure form) `credential.test` `agent.create` `agent.test` `alert.create` | vault, agents store, alerts |

### Guard rails

- **Acts as the user.** Same role, projects (`canResource`, `creationProject`), environment protection and four-eyes as
  the UI; no service account. An MCP token acts as its own user, as today.
- **Untrusted content stays data.** Run output, webhook bodies, emails and table rows are marked untrusted in tool
  results. A run that says "apply this" can at most produce a plan card, and a card does nothing without a click.
- **Secrets never reach the model.** Credential digests carry name, type, usage and last test only.
- **Budgets.** The builder model (`LANDFLOW_BUILDER_MODEL`, local Ollama by default, `anthropic/…` or `openai/…`
  overrides as in `assistant/model.ts`), with per-user daily token and cost caps reusing the agents runtime's budget code.
- **Audit and telemetry.** Each apply records `action.applied` with `source` (`spotlight`, `mcp`, `form`) and the plan
  id. Spans `spotlight.ask`, `action.plan`, `action.apply`; metrics `landflow.actions.proposed|applied|undone`.

### Where the code goes

```
apps/web/src/lib/server/actions/        define · catalog · gate · plans · apply · tools
apps/web/src/lib/server/actions/defs/   workflow · run · table · credential · agent …
apps/web/src/lib/server/spotlight/      search (Go and @) · context digests · chat loop
apps/web/src/components/spotlight/      bar · panel · mention-picker · plan-card · receipt

GET  /api/home
GET  /api/spotlight/search?q=&types=
POST /api/spotlight/chat                 SSE
GET  /api/actions                        the catalog the user may use here
POST /api/actions/:id/plan
POST /api/actions/plans/:planId/apply
POST /api/actions/receipts/:id/undo
```

New routes go into `routePolicy` (`lib/server/auth/policy.ts`) and [reference/api.md](reference/api.md) when built.
The chat loop is the editor assistant's loop (`assistant/chat.ts`, at most 8 model calls) with catalog tools in place
of the editor-only ones.

## Delivery

| Phase | Ships | Checked by |
|---|---|---|
| 0 · Quick fixes (S each) | the fixes marked S in [ux-simplification.md](ux-simplification.md): display rules with defaults, "Stop all" behind ⋯, Insights hides deleted workflows, "Show developer details", grouped settings, editor sidebar collapsed, minimap threshold | node-panel tests for display rules; before and after screenshots |
| 1 · Home (M) | `GET /api/home`, the new Home, Insights opened from the KPIs | route tests with project scoping; deltas and p95 against a seeded rollup |
| 2 · Action layer, Go and Do (L) | `lib/server/actions` with plans, apply, undo, audit; the first catalog; the ⌘K bar with search, `@` and `/` forms; the instance MCP server on the catalog | a contract test (every action has schema, permission, plan, apply; MCP and Spotlight list the same catalog); a permission matrix (a viewer cannot plan writes); stale plans; undo |
| 3 · Ask (L) | the agent loop with find, read, describe, propose; context providers per page; plan cards and receipts; the builder chat becomes Spotlight's Ask | scripted-model tests as in `assistant.test.ts`; an injection test (run output that says "apply" leaves nothing applied); budget stop; no secret in any prompt |
| 4 · Consolidate (M–L) | six-item navigation, Connections by app, node creator by app, New-workflow chooser with a staged review, evaluation wizard, Home's Ask buttons pre-fill Spotlight, delete-tier actions | a walk through every screen in light and dark, desktop and phone; feature pages updated |

## Decisions (recommendations)

1. **Spotlight replaces the editor's Assistant panel.** Decided and built: in the editor, Spotlight is the builder chat
   with the same ops, diff and undo, and the Assistant panel, its header button and the toolbar's AI builder are gone.
2. **No auto-apply by default.** An opt-in per user for create and update kinds only; never for run, publish, delete or
   secret. Test and fix is the one exception so far: starting a session is the opt-in for the fixes it applies to the
   draft (each with Undo). It runs only test runs, and publishing still waits for a click.
3. **Local model by default**, as the assistant; hosted models through the existing overrides.
4. **HTTP routes move onto the catalog later**, one area at a time, after Spotlight and MCP.
5. **The navigation change is phase 4**, after ⌘K makes every page reachable.

## What other platforms do

Summarised in [ux-simplification.md](ux-simplification.md#what-other-workflow-tools-do): Zapier's Alerts page (an
attention inbox), Power Automate's describe-then-review creation, Zapier Copilot, Make's Maia and Windmill approving
AI edits before they land, Windmill's page-aware chat with `@` context, and Linear's ⌘K.
