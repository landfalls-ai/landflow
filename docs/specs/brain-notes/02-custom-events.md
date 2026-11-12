# Brain item 2: custom event kinds and Record Event

## What was built

- **Custom kinds.** `<namespace>.<name>` (`work.ticket_moved`), lowercase letters, digits and underscores, 3 to 64
  characters; the namespace can't be a built-in one (run, node, ai, workflow, credential, assistant, spotlight, search,
  agent, feedback, template, plugin, proposal, tool). the type `UsageKind` is the built-in kinds or any `<string>.<string>`, plus
  `customKindProblem`, `isCustomKind`, `isUsageKind` in `lib/shared/brain.ts`.
- **Registry.** Table `usage_kinds` (migration 2062, also in `TABLES`): kind, description, `fields` JSON (name, type
  string/number/boolean, required, description; at most 20), project, creator, timestamps. Code in
  `lib/server/usage/kinds.ts`. Routes `GET/POST /api/usage/kinds`, `GET/DELETE /api/usage/kinds/:kind` (reads
  `executions:read`, writes `workflows:write`; OpenAPI entries added).
- **Record Event** (`core.recordEvent`, a tool too). Picks a declared kind, checks attributes against it, writes through
  `recordUsage` (redaction and caps kept), about this workflow by default (the agent for a tool call) or a chosen
  workflow or agent the creator can see. Declare Kind If New infers fields from the attributes.
- **On Usage Event** lists declared kinds and has an Attribute Filter (any kind). Loop protection extended: events carry
  `attrs.recordedBy` (the recording workflow) and a workflow with the trigger never starts anything through events it records.
- **Reports.** `kinds` filters accept custom kinds in Landflow Usage, `/api/usage` and `/api/usage/events`; new
  `groupBy=attr` with `groupAttr=<name>` and `attr.<name>=<value>` filters (node: *Attribute* and *Attribute Filter*).
  The daily rollups already group by kind text, so custom kinds roll up without changes; attribute grouping and
  filtering read raw events only.
- Tests: `apps/web/test/brain-events.test.ts` (16). Docs: `docs/second-brain.md` ("Your own event kinds"), `docs/reference/api.md`.

## Decisions

- Unknown attributes are dropped and listed in the node's `dropped` output, not rejected. Wrong type or missing required
  field fails. Strings that plainly read as the declared number or boolean are coerced.
- The Record Event node defaults the event's subject to its own workflow, so scope (what a member sees) applies to custom events.
- Attribute filters compare as text; booleans match SQLite's 1/0 too.
- Insights lists no kinds anywhere today, so it needed no change.
- Registry reads are open to any `executions:read` caller (kind names and shapes aren't scoped by project; `project_id` is stored for later).

## History row

`Custom event kinds: namespaced kinds declared in usage_kinds (POST /api/usage/kinds), a Record Event node that writes them into the ledger, On Usage Event on them with an attribute filter, and reports grouped by an attribute (groupBy=attr)`

## Roadmap paragraph

Second brain, item 2, custom events: flows can now write their own events into the usage ledger. A kind such as
`work.ticket_moved` is declared once with its fields (`usage_kinds`, `/api/usage/kinds`); the Record Event node
checks each event against that shape and records it about the workflow or agent it concerns. On Usage Event fires on
custom kinds and filters on attributes, and Landflow Usage and `/api/usage` filter and group by an attribute ("tickets
moved per team"). A flow that starts from On Usage Event can't start another through the events it records.

## Limitations to record

- Grouping and filtering by attribute read the raw events, so they reach back `USAGE_RETENTION_DAYS` (90), not the 400 days of rollups.
- A declared kind has at most 20 fields; string values keep 200 characters; a kind's declaration is shared by the
  instance (no per-project kinds, no edit rights beyond `workflows:write`).
- Deleting a kind keeps its events; Record Event refuses it until redeclared. Changing a field's type doesn't rewrite old events.
- Custom events carry no `nodeType`, so node-type reports don't count them.
- No UI to declare or browse kinds yet (API and Declare Kind If New only).
