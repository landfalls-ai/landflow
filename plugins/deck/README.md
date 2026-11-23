# dot-agent-deck

Start a unit of work in your [dot-agent-deck](https://github.com/dot-agent-deck) from a flow, and hear when it finishes. One node,
**dot-agent-deck**, with one operation, **Dispatch**. The deck is **called** through its CLI, never copied or linked; the
plugin changes nothing in it. Built against the deck at commit `720a5f05` (read only).

```sh
# inside a terminal pane of the deck (the deck's CLI refuses anywhere else), with the SAME secret the host runs with:
LANDFLOW_TRANSPORT_SECRET=<the host's> LANDFLOW_REGISTRY_URL=http://localhost:3000 pnpm plugin:deck   # HTTP :7122, gRPC :7222
pnpm --filter @landflow/plugin-deck test                                                              # a fake deck on PATH; no deck needed
```

Opt-in: not in `dev:all`, no compose service, no image, no cluster component. It runs as you, on the machine that runs the deck.

## Who may call it

A plugin that can start a coding agent must not be callable by any web page, so this one guards its HTTP face (the SDK's opt-in
`guardHttp`): every POST route refuses a request carrying an `Origin` header or `Sec-Fetch-Site` other than `none`, a body that is
not `application/json`, and a call without the token the host derives from `LANDFLOW_TRANSPORT_SECRET` (else
`LANDFLOW_REGISTRY_SECRET`) as an HMAC, never the raw secret. The host sends that token on every HTTP call when it holds a secret; the
plugin **refuses to start without one**, so start the host and the plugin with the same value. The MCP face is off. The gRPC
face is not reachable from a browser; any other process of the same user on this machine can still call it, as it could run the deck itself.

## The flow pattern

```
Dispatch (dot-agent-deck)  ->  Wait (Resume "On Webhook Call", HTTP Method POST, Limit Wait Time a little longer than Watch For)  ->  next step
```

- Set the Wait's **HTTP Method to POST** (its default is GET; the plugin POSTs).
- Turn on **Limit Wait Time** and make it **a minute or two longer than Watch For**. When Watch For runs out the plugin POSTs
  `status: "timed_out"` so the Wait resumes with that; the Wait's own limit is only the backstop (it then continues with the Dispatch
  output and no report). The unit keeps running either way.
- The run must reach its Wait before the report can land: the plugin retries a `409` (not waiting yet) until the deadline.
- **One item per run** when Report To is set (a run has one resume URL, one Wait hears one unit); the node refuses more.
- **Unit names must be unique across flows** while a unit runs: the deck's inbox cannot tell two units with one name apart. The
  plugin reserves the name (and one of its 50 open watches, **a limit shared by every flow that uses the plugin**) before it
  dispatches, drops anything the deck still holds under that name, and gives the reservation back if the dispatch fails.

Dispatch runs `dot-agent-deck dispatch <name> --task-file -` (the task on stdin, up to 1 MiB, so backticks, quotes and `$HOME`
arrive verbatim), returns the deck's admission answer, and opens a **watch**. **Report To** defaults to
`{{ $execution.resumeUrl }}`: when the unit's outcome arrives in this pane's deck inbox, the plugin POSTs
`{ unit, report, status, trust }` to it, and the Wait resumes with that as its output. The run pauses; no worker is held.

| Field | Meaning |
|---|---|
| Unit Name | 1-40 lowercase letters, digits, dashes; names the unit's tab and, without Directory, its worktree and branch |
| Task | what the unit does |
| Agent | `claude`, `opencode`, `pi`, `codex` or `devin`; empty uses the pane's own |
| Command | the command the unit starts with; **off** unless `LANDFLOW_DECK_ALLOW_COMMAND=1` is set where the plugin runs |
| Directory | an existing absolute directory to start in. Without it the deck cuts a worktree from the **pane's current directory** (`main.rs:2111-2116`: the daemon answers from the pane's cwd and config), as a sibling `../<repo>-dispatch-<name>` on branch `agent/dispatch-<name>`, so start the pane in the repository |
| Report To | the run's resume URL (`/api/waiting/...`). Only its path and signature are used: the plugin posts to the host it announced to (`LANDFLOW_REGISTRY_URL`), whatever origin the URL names (a container sees the host as `host.docker.internal` while the URL says `localhost`); empty means nothing watches. With `LANDFLOW_REGISTRY_URL=off` it fails with "no host origin configured" |
| Watch For (minutes) | default 120, at most 1440 |

Without an Agent, Command or an orchestration choice the deck starts the repository's **default orchestration** (`dispatch.rs:1359`,
the block with `default = true`, else the first with roles) and the reply says which one; give an Agent to start one agent.

**The report is untrusted.** `status` is `completed`, `failed`, `timed_out` or `inbox_unreadable`. `report` is the unit's own text:
for `completed` it keeps the deck's `[UNTRUSTED-WORKER-REPORT:` ... `:END-UNTRUSTED-WORKER-REPORT]` wrapper, for `failed` it is the
deck's message, for `timed_out` it is empty, and `trust` is always `"untrusted"`. Treat it as data in a later step (never feed it
to a Code node or an agent as instructions without the fence). A message is classified by the deck's **subject** only
(`dispatch completed` completed; `dispatch failed` and `dispatch ended` failed; `dispatch started` and `dispatch report updated`
ignored), and tied to the unit by the deck's sender label, never by anything in the unit's text.

If the deck refuses to let this pane read its inbox (a respawned pane's token is stale: `DOT_AGENT_DECK_PANE_CAPABILITY` belongs to
one generation of the pane), the plugin logs the deck's reason and, after about a minute of refusals, POSTs
`status: "inbox_unreadable"` with that reason, so a Wait does not hang. Restart the plugin from the current pane shell.

Output of the node: `{ unit, admitted, message, watching }`. `admitted` means the deck's daemon took the request; a unit that
then fails to start arrives as `failed`.

## How it talks to the deck (the first task's findings, read from the source)

Can a plain deck pane read its inbox? **Yes, with a caveat that only a live run can settle.**

- **(a) `inbox fetch --json` from a pane.** It needs the pane id, the agent id and the hook capability token, and the deck puts
  all three in the environment of every process it starts in a pane (`agent_pty.rs` injects `DOT_AGENT_DECK_AGENT_ID` and
  `DOT_AGENT_DECK_PANE_CAPABILITY` at spawn; `inbox_cli.rs:29-46`). A plugin started from that pane's shell inherits them and sits
  inside the pane's process tree, which the daemon requires to hand over mail (`daemon.rs` `mail_taker_admitted`). So a plugin
  started in a deck pane can read the pane's inbox. Outside a pane the CLI prints "should be run from within a dot-agent-deck
  managed pane" and the node fails with "run the deck plugin from a deck pane". What was **not** proven: the deck binary was not installed on the machine where this was built, so it has been checked against a fake only (the tests, and a run on a scratch host with the fake standing in for the binary). Run one real dispatch before relying on it.
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
- Report To only contributes its `/api/waiting/` path and signature; the plugin always posts to the host it announced to
  (`LANDFLOW_REGISTRY_URL`, default `http://127.0.0.1:3000`, redirects refused), so a flow cannot make the plugin call another address. At most 50 watches are open.
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

## Live check (exact steps; run with a real deck, no model tokens)

Verified 2026-11-23 against the deck at `720a5f05` inside Docker (OrbStack), host on the Mac. The unit is a shell command.

1. Host: `LANDFLOW_REGISTRY_SECRET=s LANDFLOW_TRANSPORT_SECRET=t LANDFLOW_REGISTRY_GRPC_PORT=off pnpm --filter web exec next start -H 0.0.0.0 -p 3190`
   (`-H 0.0.0.0` only so a container can reach it; own port only). Sign in as the owner.
2. Deck: build `dot-agent-deck` (rust >= 1.99.1) and run it in a TTY (`tmux new-session -d -s deck dot-agent-deck`), with a
   git repository as the start directory. Press Ctrl+n, pick the repository (Space), Enter twice, type `bash` as the command,
   Enter. Press Ctrl+d until the typing bar says "PaneInput" so keys reach the pane's shell.
3. In that pane's shell, start the plugin (the deck's CLI only works from a pane):
   `LANDFLOW_TRANSPORT_SECRET=t LANDFLOW_REGISTRY_SECRET=s LANDFLOW_REGISTRY_URL=http://host.docker.internal:3190 LANDFLOW_ADVERTISE_HOST=127.0.0.1 LANDFLOW_DECK_ALLOW_COMMAND=1 pnpm --filter @landflow/plugin-deck start`
   (outside Docker use `LANDFLOW_REGISTRY_URL=http://localhost:3190` and publish ports 7122 and 7222). The host lists `deck` under Plugins.
4. Flow: Start -> Dispatch (Unit Name `real-check`, Agent `claude`, Command
   `sh -c 'sleep 8; dot-agent-deck work-done --done --task "hello"'`, Watch For 10) -> Wait (Resume On Webhook Call, HTTP Method
   POST, Limit Wait Time 12 minutes). Execute it.
5. Expect: Dispatch succeeds with `watching: true`, the Wait shows Waiting, and after about 10 s the run succeeds; the Wait
   output body is `{unit, report: "[UNTRUSTED-WORKER-REPORT:\nhello\n:END-UNTRUSTED-WORKER-REPORT]", status: "completed", trust: "untrusted"}`.
   The deck cut `../<repo>-dispatch-real-check` on branch `agent/dispatch-real-check`.
6. Guard: `curl -X POST -H 'content-type: text/plain' -d '{}' http://127.0.0.1:7122/landflow/v1/execute` gives 401 and with
   `-H 'Origin: http://evil.example'` gives 403.

Seen on the first try: a unit whose command exits at once (no `work-done`) arrives as `failed` ("ended without reporting"), so use a command that reports.
