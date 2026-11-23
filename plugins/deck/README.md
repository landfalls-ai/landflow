# dot-agent-deck

Start a unit of work in your [dot-agent-deck](https://github.com/dot-agent-deck) from a flow, and hear when it finishes. One node,
**dot-agent-deck**, with one operation, **Dispatch**. The deck is **called** through its CLI, never copied or linked; the
plugin changes nothing in it. Built against the deck at commit `720a5f05` (read only).

```sh
# inside a terminal pane of the deck (the deck's CLI refuses anywhere else):
LANDFLOW_REGISTRY_URL=http://localhost:3000 pnpm plugin:deck     # HTTP :7122 (MCP at /mcp), gRPC :7222
pnpm --filter @landflow/plugin-deck test                           # a fake deck on PATH; no deck needed
```

Opt-in: not in `dev:all`, no compose service, no image, no cluster component. It runs as you, on the machine that runs the deck.

## The flow pattern

```
Dispatch (dot-agent-deck)  ->  Wait (Resume "On Webhook Call", HTTP Method POST)  ->  next step
```

Set the Wait's **HTTP Method to POST** (its default is GET; the plugin POSTs) and, if you want a ceiling, turn on **Limit Wait Time**
with the same length as Watch For. When that time runs out the Wait continues with the Dispatch node's output (no report), and the
unit keeps running.

Dispatch runs `dot-agent-deck dispatch <name> --task-file -` (the task on stdin, up to 1 MiB, so backticks, quotes and `$HOME`
arrive verbatim), returns the deck's admission answer, and opens a **watch**. **Report To** defaults to
`{{ $execution.resumeUrl }}`: when the unit's completion arrives in this pane's deck inbox, the plugin POSTs
`{ unit, report, status }` to it, and the Wait resumes with that as its output. The run pauses; no worker is held.

| Field | Meaning |
|---|---|
| Unit Name | 1-40 lowercase letters, digits, dashes; names the unit's tab, worktree and branch; unique while it runs |
| Task | what the unit does |
| Agent | `claude`, `opencode`, `pi`, `codex` or `devin`; empty uses the pane's own |
| Command | the command the unit starts with; **off** unless `LANDFLOW_DECK_ALLOW_COMMAND=1` is set where the plugin runs |
| Directory | an existing absolute directory to start in instead of a new worktree |
| Report To | the host's resume URL; only this host's own addresses are accepted; empty means nothing watches |
| Watch For (minutes) | default 120, at most 1440; the unit keeps running afterwards |

Output: `{ unit, admitted, message, watching }`. `admitted` means the deck's daemon took the request; the deck says a unit may
still fail to start, and then the deck's refusal arrives as the report with `status: "failed"`.

## How it talks to the deck (the first task's findings, read from the source)

Can a plain deck pane read its inbox? **Yes, with a caveat that only a live run can settle.**

- **(a) `inbox fetch --json` from a pane.** It needs the pane id, the agent id and the hook capability token, and the deck puts
  all three in the environment of every process it starts in a pane (`agent_pty.rs` injects `DOT_AGENT_DECK_AGENT_ID` and
  `DOT_AGENT_DECK_PANE_CAPABILITY` at spawn; `inbox_cli.rs:29-46`). A plugin started from that pane's shell inherits them and sits
  inside the pane's process tree, which the daemon requires to hand over mail (`daemon.rs` `mail_taker_admitted`). So a plugin
  started in a deck pane can read the pane's inbox. Outside a pane the CLI prints "should be run from within a dot-agent-deck
  managed pane" and the node fails with "run the deck plugin from a deck pane". What was **not** proven: the source was read, the
  real deck was not available to run it against (see the history row's live check).
- **(b) The JSON of `inbox fetch --json`.** One line, `{"messages":[{"id","subject","from","text"}]}`, each message handed over once.
- **(c) The words.** Dispatch's reply opens `dispatch: spawned isolated` (a refusal opens `dispatch:` with anything else); the
  completion opens `dispatch: a unit you dispatched has completed`, its sender label is `the dispatch of "<unit>"`, and the report
  sits between `[UNTRUSTED-WORKER-REPORT:` and `:END-UNTRUSTED-WORKER-REPORT]` (cut at 4000 characters; the deck names a file for
  the rest). An update opens `dispatch: a unit you dispatched sent an update` and is ignored. The fake deck in `test/` pins these.
- **(d) A command that reports at once, no model.** `dispatch --agent claude --command "sh -c 'dot-agent-deck work-done --task-file - <<< done'"`:
  the deck requires an agent name when the command does not name one directly (`resolve_chosen_launch`), and `work-done` inside the unit
  is what produces the completion. It needs `LANDFLOW_DECK_ALLOW_COMMAND=1`.
- **Traces.** The deck honours no `TRACEPARENT` (`telemetry/propagation.rs` only sets `OTEL_RESOURCE_ATTRIBUTES` and Claude Code's
  switches, in the daemon's spawn, which the plugin's environment never reaches). The plugin exports its own spans with the usual
  `OTEL_EXPORTER_OTLP_*` variables and puts `landflow.execution.id` and `deck.unit.name` on its `deck.dispatch` span: the deck's spans
  and the run's meet in the collector by that name, not as parent and child.

## Safety

- No shell anywhere: argument arrays, the task on stdin.
- The plugin never runs `trust approve`. An orchestration the deck does not trust fails the node with the deck's own message and
  the `approve` command it names; a person runs it.
- Report To is pinned to the host the plugin announced to (`LANDFLOW_REGISTRY_URL`, default `http://127.0.0.1:3000`; `localhost` and
  `127.0.0.1` count as one), so a flow cannot make the plugin call another address. At most 50 watches are open.
- A dispatched unit runs code on your machine as you. Anyone who can run a flow with this node can start one, so keep the plugin off
  shared hosts and leave `LANDFLOW_DECK_ALLOW_COMMAND` unset unless you need a command.
- Watches live in the plugin's memory: restart it and a running unit's Wait times out (the unit keeps running).

## Asks for the deck project (for the person to raise; nothing in the deck was changed)

1. **A token-authenticated way to dispatch and read the inbox from outside a pane** (for example a per-user socket token), so a
   plugin need not be started inside a pane and survives the deck's panes closing.
2. **Honour `TRACEPARENT` (or a `--trace-parent` option) on dispatch**, so a unit's spans parent under the run's span instead of
   being joined by attribute.

## Environment

`LANDFLOW_DECK_BIN` (the binary, default `dot-agent-deck` on PATH), `LANDFLOW_DECK_ALLOW_COMMAND` (see above),
`LANDFLOW_REGISTRY_URL`, `LANDFLOW_HOST`, `LANDFLOW_ADVERTISE_HOST`, `LANDFLOW_MCP_TOKEN` and `OTEL_*` as for every plugin
([transports.md](../../docs/transports.md)).
