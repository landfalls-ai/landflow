# Lowering cognitive load: a screen-by-screen review (plan)

Status: **plan**, written 2026-10-27 at commit 493177a, from a walk through the running app (dev host and the seven
plugins, Chrome at 1440×900) and a survey of other workflow tools. Nothing here is built yet. It goes with
[spotlight.md](spotlight.md), which covers the new Home, the ⌘K Spotlight bar and the action layer. The earlier
[ui-review.md](ui-review.md) compares each screen with n8n feature by feature; this page is about how much each screen
asks of the user.

The summary: Landflow does a lot and shows all of it at once. Most fixes hide, merge or rename things; few need new
features. Size: S is about a day, M a few days.

## Principles

1. **Problems before numbers.** A screen opens with what needs a decision; statistics come after, and each one links to
   the list behind it.
2. **One primary action per screen.** One dark button says what the screen is for; the rest goes in ⋯ or on hover.
3. **A field appears when it matters.** Options show once the settings above them make them relevant; rare ones sit under
   "More options".
4. **The user's words.** Apps, not plugins; Live / Draft / Off, not versions. Type ids, languages, transports and ids are
   hidden unless a per-user **Show developer details** switch is on (off by default).
5. **One way to do a thing.** One AI surface (Spotlight), one place to add capabilities (Connections), one way to start a
   workflow (New, then a chooser).
6. **Safe by default.** Destructive actions sit in menus and confirm by name; every AI change can be reviewed and undone.

## Navigation

**Built (shell, wave 1):** the rail has nine items (Home, Workflows, Runs, Agents, Brain, Data tables, Credentials,
Plugins, Settings) with section tabs inside Workflows, Runs (with a Search tab until B20) and Plugins
(`components/shell/section-nav.tsx`); the theme and Build a plugin moved into the user menu; the Live dot shows only as
"Reconnecting…" with an amber dot (the dot alone on a folded rail); the Preview pill and the plugin count are gone (a red dot marks an offline plugin); the project
switcher has Manage projects. The six-item proposal below is the older plan.

Today: the project switcher, 11 sidebar items (Build: Home, Workflows, Templates, Agents, Executions, Insights, Data
tables, Credentials; Extend: Plugins, Marketplace, Build a plugin), then Settings, a Live dot, a theme switch and the
user. Three places add capabilities: Plugins, Marketplace and Templates.

Proposed, six items:

| Item | Absorbs |
|---|---|
| Home | Insights, opened from the KPIs |
| Workflows | Templates, inside "New workflow" |
| Agents | Marketplace agents and skills (Agents › Skills) |
| Runs | renamed from Executions |
| Data | data tables and variables |
| Connections | credentials by app, and Integrations (plugins) for admins |

Settings and the user menu stay at the bottom; the theme switch moves into the user menu; the Live dot shows only when
the connection drops; "Build a plugin" moves to a Developers entry in the user menu. ⌘K reaches every page that left the
sidebar. (M, phase 4 of [spotlight.md](spotlight.md#delivery).)

## Screen by screen

### Home (high impact, M)

- **Seen:** four counters, one of them "Plugins online", an operator's number; eight recent executions that are all the
  same workflow; half the page on healthy plugins with language and transport badges; header buttons "Build a plugin"
  and "Open polyglot demo".
- **Change:** the Home in [spotlight.md](spotlight.md#1-home-20) (Needs you, KPIs with deltas, runs chart, rankings,
  Continue). Group runs by workflow; show plugins only when one is offline; primary action "New workflow"; demo links in
  an empty-state card for new instances.
- **Built (2026-11-14):** the header's primary is "New workflow" (a blank one, opened in the editor); "Open polyglot
  demo" sits in the empty state of an instance with no runs; the Plugins KPI and panel and the header meta line are
  gone, a one-line warning shows above the tiles only when a plugin is offline; "Needs you" is the fourth tile (its
  number in the tile's amber, not red: waiting is not failing; it updates when a run starts to wait, and Home, the
  rail and the runs page share one request); a run of one flow is one line; a suggestion is a compact card, whose
  warnings stay in view when it is folded. When every recent run is still going, Recent executions says so.

### Developer details everywhere (high impact, S)

- **Seen:** type ids and runtimes in the node panel header (`core.aiAgent` · `in-process`); language and transport under
  node labels ("GO · gRPC") and in the node creator; execution ids and a mode icon as table columns; plugin names where
  people think in apps ("Messaging" rather than Slack or Telegram).
- **Change:** the Show developer details switch brings these back; nodes and groups are named by app, the package is a
  detail in the node's info.

### Workflow editor (high impact, M)

- **Seen:** 12 top-bar controls (back, name, tags, "Saved", Editor / Executions / Evaluations, "Not published",
  Publish ▾, Assistant, history, Save, ⋯), with "Saved" next to a Save button and "Not published" next to Publish. On
  the canvas: 5 unlabelled tools top right, 6 zoom controls bottom left, a minimap by default, the run bar and the Logs
  strip. The app sidebar stays open. At fit, a 9-node flow's labels are too small to read. Three AI entry points
  (Assistant, the AI builder icon, the chat panel).
- **Change:** six controls: back, name with "saved 2s ago", Editor / Runs / Tests, one **Publish changes** button that
  states its effect (then "Live · up to date"), ⋯ (tags, history, settings). Drafts autosave; ⌘S still answers "Saved".
  One bottom toolbar (Run ▾ with Debug, Add, zoom); the minimap only above about 25 nodes; the sidebar collapses to
  icons; fit keeps labels at least 12 px. Spotlight is the one AI surface, and "Describe a workflow" on an empty canvas
  becomes its first prompt. Runs where a branch produced 0 items show amber, not green.
- **Done (2026-10-27):** Spotlight is the one AI surface in the editor, a bar beside the run controls at the bottom of the
  canvas ([assistant.md](assistant.md#spotlight)). The Assistant header button, the side panel, the toolbar's AI builder
  button and the empty canvas's prompt box are gone, so the top bar has 11 controls and the canvas toolbar 4.

### Node panel (high impact, S)

- **Seen:** the AI Agent opens with "Credential for OpenAI API · No credential yet" at the top. That credential is
  optional (`{ name: 'openAiApi', required: false }` in `apps/web/src/lib/server/nodes/ai.ts`) and only transcribes
  audio input. "Ask In" and "Approval Timeout" show while "Tools Requiring Approval" reads None: both have
  `displayOptions: { hide: { requireApproval: ['none'] } }`, but `node-panel.tsx` and `param-form.tsx` call
  `isPropertyVisible` with the saved parameters, without defaults, and the demo's AI Agent was saved before
  `requireApproval` existed. Every option is open in one long column.
- **Change:** evaluate display rules against the parameters with defaults filled in. Fold optional credentials into one
  line that says what each is for ("Optional: OpenAI API, to transcribe audio input"). Required fields first, the rest
  under "More options". Error text names the cause and offers the fix as a button ("Reconnect Stripe prod"), not "check
  your credentials".
- **Done (2026-10-27):** the node panel, its credential section, the MCP server dialog and the assistant's node docs
  evaluate display rules with defaults filled in, as the server does, so "Ask In" and "Approval Timeout" hide while
  Tools Requiring Approval is None.

### Node creator (medium, S)

- **Seen:** after AI, Data transformation, Flow and Core comes a "Plugins" list of packages, each with a description, a
  language and a transport.
- **Change:** list apps with their icons (Slack, Telegram, Gmail, Sheets, Notion, Postgres…); search still matches the
  package; recently used nodes at the top.

### Runs, today Executions (medium, S)

- **Seen:** hundreds of rows of the same workflow; "Stop all" next to Auto refresh, top right, one click away; columns
  for the execution id and a mode icon.
- **Change:** group by workflow with counts, expand for runs; filter chips (Failed today, Waiting, Running); "Stop all"
  into ⋯ with a confirm that names the count ("Stop 3 running runs"); ids copy on hover instead of taking a column.

### Insights (medium, S)

- **Seen:** the per-workflow table is led by deleted test workflows ("… (deleted)"); time saved reads "0 min" with a hint
  to set minutes per run elsewhere; it overlaps Home.
- **Change:** hide deleted workflows behind a toggle; ask for minutes saved per run inline on the top three workflows;
  reach it from Home's KPIs.

### Credentials (high impact, M)

- **Seen:** the empty state sits above a wall of 41 credential types grouped by plugin, with several per app: Slack API
  and Slack OAuth2 API; GitHub API, GitHub OAuth2 API and GitHub App; Jira Cloud, Jira OAuth2 and Jira Server PAT;
  Notion API and Notion OAuth2.
- **Change:** "Connect an app" with one tile per app; choosing one offers "Sign in with Slack (recommended)" or "Use a
  token". The list shows connections with health and a Reconnect button; broken ones also appear in Home's Needs you.

### Templates and new workflows (medium, S)

- **Seen:** a good gallery behind four filter controls and nine category chips; Import, New folder and New workflow are
  three separate buttons on Workflows; the Workflows list shows no run state or failures.
- **Change:** "New workflow" opens a chooser: Describe it, Template, Blank, Import. Template cards say what they need
  ("Needs Slack, Gmail") and have one Use button, followed by a staged review (outline, connection check, Create). The
  Workflows list shows last run state and failures today.

### Evaluations (medium, M)

- **Seen:** a clear four-step explanation, but setting one up means placing special trigger and metric nodes by hand.
- **Change:** a "Create test" wizard: pick a table or upload a CSV, map columns to the workflow's input, pick a metric;
  Landflow adds the nodes and shows them. Rename the tab "Tests".

### Plugins and Marketplace (medium, M)

- **Seen:** each plugin card is fully open: endpoints with latency bars, transport policy (Auto / Pinned / Allowed),
  objective, MCP exposure and every node chip. Marketplace (Claude Code plugin marketplaces) is a third place next to
  Plugins and Templates, and the names overlap.
- **Change:** collapsed cards (name, status, apps) with details on expand, under Connections › Integrations for admins;
  Marketplace agents and skills move to Agents › Skills, node plugins join Integrations.

### Settings (medium, S)

- **Seen:** 16 sections in one flat list (General, Variables, Alerts, AI prices, MCP, Users, API keys, API docs, Security,
  Audit log, Governance, Source control, Environments, External secrets, Workers, Transports), each hint cut off.
- **Change:** five groups (Workspace: General, Variables, Alerts · People and access: Users, API keys, Security, Audit
  log · Governance: Governance, Environments, Source control, External secrets · AI: AI prices, MCP · Infrastructure:
  Workers, Transports; API docs moves to the Developers entry), a search box, and links from a deep setting back to
  where it applies.

### Agents and Data tables

Good empty states; no change beyond the navigation and Spotlight's context chips.

## What other workflow tools do

From each product's documentation and community forums, October 2026. Zapier's and Make's post-login home screens and
Gumloop's undo could not be verified, so they are not claimed.

| Pattern | Who | For Landflow |
|---|---|---|
| An attention inbox: errored, halted and held runs, broken connections with Reconnect and the count of Zaps affected, Zaps turned off; 7 days; Enterprise only | [Zapier Alerts](https://help.zapier.com/hc/en-us/articles/34463643736205-View-all-issues-on-the-Alerts-page) | Needs you on Home, for every user. n8n's [Overview](https://docs.n8n.io/insights) has a stats banner and no inbox. |
| Describe, see an outline, check each connection, then Create | [Power Automate Copilot](https://learn.microsoft.com/en-us/power-automate/create-cloud-flow-using-copilot) | "Describe it" in the New chooser with the same staged review |
| AI edits approved before they land: "Ask as you build" and checkpoints; numbered versions with Revert, and no running or activating; accept or reject per change | [Zapier Copilot](https://help.zapier.com/hc/en-us/articles/45327353705997-Best-practices-for-using-Zapier-Copilot), [Make Maia](https://help.make.com/introduction-to-maia-by-make), [Windmill](https://www.windmill.dev/docs/core_concepts/ai_generation) | plan cards, Apply, Undo; no applying without a click |
| Page-aware chat on ⌘L that attaches the page and selection, `@` for schemas, errors and other scripts | [Windmill AI chat](https://www.windmill.dev/blog/ai-chat) | removable context chips and `@` for any resource |
| ⌘K runs any action or jumps anywhere; actions change with the page | [Linear](https://linear.app/enablement/guide/navigating-linear) | Spotlight Go and Do, no model needed |

Complaints worth designing against: in n8n, expressions and raw JSON in the first weeks, vague errors ("perhaps check
your credentials?"), unreadable large canvases
([community](https://community.n8n.io/t/canvas-builders-for-conv-ai-look-amazing-in-the-demo-and-then-you-hit-40-nodes/312048)),
and green runs where a branch did nothing; in Make, no autosave
([community](https://community.make.com/t/if-i-forget-to-save-an-updated-make-scenario-is-it-gone/5286)); in
Activepieces, runs stuck "Running" with no Stop
([community](https://community.activepieces.com/t/flow-stuck-in-running-no-way-to-stop/873)). Landflow's answers:
field pickers before `{{ }}`, errors with a fix button, autosave, amber for empty branches, and a Stop on every running
run.
