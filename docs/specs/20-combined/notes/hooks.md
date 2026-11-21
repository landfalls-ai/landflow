# Notes for the integrator: P4a `hooks` (C04 + C15, tasks T-1 to T-9)

## T-1: hook names checked (Claude Code 2.1.330 local; kagent's pin 2.1.285 is not installed here)

Read from the CLI binary's own hook schemas (`strings`-style search of `claude.exe`, nothing run, nothing installed).

| Name | Found | Payload fields seen |
|---|---|---|
| `SessionStart` | yes | `source`, `agent_type?`, `model?` |
| `SessionEnd` | yes | |
| `UserPromptSubmit` | yes | `prompt`, `source?` |
| `PreToolUse` | yes | `tool_name`, `tool_input`, `tool_use_id` |
| `PostToolUse` | yes | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms?` |
| `PostToolUseFailure` | yes | as PostToolUse, with `error` |
| `PermissionRequest` | yes | `tool_name`, `tool_input`, `permission_suggestions?` |
| `Notification` | yes | `message`, `title?`, `notification_type` (`permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog` all present) |
| `Stop` | yes | `stop_hook_active`, `last_assistant_message?` |
| `StopFailure` | yes | `error` (an enum: `rate_limit`, `billing_error`, `overloaded`, `server_error`, `authentication_failed`, ...), `error_details?`, `last_assistant_message?` |
| `PreCompact` / `PostCompact` | yes | `trigger` (`manual`, `auto`); PostCompact `compact_summary` |
| common | yes | `session_id`, `transcript_path`, `cwd`, `permission_mode`, `prompt_id`, `agent_type`, `hook_event_name` |

All twelve names C04 FR-3 uses exist in 2.1.330, so the registry entry is `verified: true`. 2.1.285 could not be checked (not
installed, and nothing was to be installed): P4b's live check should run one `claude` of that version if the kagent image is at
hand. Codex, OpenCode, Cursor, Gemini, VS Code and Claude Desktop stay `verified: false`, `mcp-only` (plan D3).

## Limitations to add to `docs/limitations.md`

- Only Claude Code sends status. Codex (wrapper) and OpenCode (plugin) are registry entries with no event names until verified live; `POST /api/harness/codex/hooks` is 404.
- A session's order kind (seq or time) is fixed by its first event. An event of the other kind never moves the status (it is stored). Without `X-Landflow-Hook-Seq` (an HTTP hook, not the generated command hook) events are ordered by receive time, so two events in flight at once can swap.
- An older event is stored but does not count toward a session's prompt and tool counts.
- Error and Blocked sessions stay Error or Blocked while quiet (only Idle-by-silence is shown stale); both close after 24 hours.
- Own sessions carry no prompt, tool input or output, file path or `cwd`; the repository is only what the sender names in a `repository` field (the server cannot check the brain mod's allow-list).
- Agent sessions follow the instance content setting (`LANDFLOW_TRACE_CONTENT`), not a per-agent one: agents have none.
- An agent session binds only through an `X-Landflow-Agent: <agent id>` header on its first `SessionStart`, and only for an agent the key's owner may run. `agent_type` is never read (any plugin author can reuse a name; P4b review round 2). Binding is fixed by the session's first event.
- The hook route is exempt from the API rate limit; its own limits are per key and per key owner, per second (shared across mains in queue mode). The open-session cap is per key owner and its count is cached 5 seconds per main, so mains can overshoot it by a few sessions.
- A session binds to an agent only on its first event, and only a `SessionStart` that names one the owner may run; the stored row decides, and the event's view (content or status only) is chosen after that write.
- Past 5,000 applied events a session stores only event names (status and counts still move). A late (older) event counts toward the cap too (the stored events are counted); past it only its name is stored.
- The agent mirror keeps the newest 500 timeline entries and rebuilds from the newest 500 events; harness mirrors have their own 200-per-agent cap and never evict other sources' sessions.
- The mirror's read-modify-write is not safe when two mains take events of one session at the same moment: a rare lost entry shows until a late event rebuilds the timeline.
- `X-Landflow-Hook-Time` more than 5 minutes ahead of the server is ignored (receive time is used).

- Own sessions reach Landflow only through the pasted `/connect` hooks block or the brain mod with `/brain status-sharing on` (default off); a person who does neither is invisible, by design.
- The brain mod reports under a session id it makes itself (Claude Code's own id reaches it only at the end), and only in a listed repository.
- The Agents page chip shows only agent sessions; a person's own sessions are on `/connect` only.
- Screens are checked at 1440x900 and 390x844 by a person in a live check; the layout has no unit test.

- The `/connect` hooks block needs Node on the machine (Claude Code ships with it) and Node 18 or later for `fetch`; the hooks run `async`, so a slow Landflow never delays Claude Code, but a hook that cannot reach Landflow in 1.5 seconds drops its event.
- The agent mirror rebuilds a session's timeline at most once a second, and only when a late event falls inside the newest 500; a late event inside the throttle gets one trailing rebuild when the second is over (so it shows even when no event follows), and a closed session is rebuilt at once. The mirrored timeline is also cut to about 2 MB, counted in bytes (oldest entries first), from a running size that is made exact only when it passes the cap.
- To bind a session to an agent you pick the agent on `/connect` and use that setup only in the project where you run it; every session that setup reports binds to it.
- The order number is one clock in microseconds (`performance.timeOrigin + performance.now()`); two hooks in the same microsecond could still tie, and a tie never moves a status backwards.

- The hook key's default expiry is 30 days (every program Claude Code starts can read the variable). The agent picker lists every agent the person can see: whether they may run one is checked by the server, and a session that may not bind stays their own.
- A hook sends only strings (cut to 300 characters) and finite numbers; `error_details` leaves the machine only for a session with an agent picked.

## Roadmap lines

- C04 hook ingest (routes, status machine, mirror, live event, sweep): built (P4a); Agents page chip, `/connect` live-status step, `landflow harness detect`, brain mod `/brain status-sharing` (default off): built (P4b).
- C15 registry, kagent runtime labels, source scan: built (P4a); `/connect` reads the registry and the scan's `PENDING` allowance is empty (P4b). Open: Codex wrapper and OpenCode plugin entries once verified live.
- Blocked from `StopFailure`: built with P5's `classifyText` (over `error_details`, `last_assistant_message`, `error`) and an explicit `quota_blocked: true` field.
- Codex quota path (C05 W2): a Codex `quota_blocked` event can use the same `harness/ingest.ts` path.

## Deviations from the plan

- The refused-key `api.denied` is recorded by `audit/http.ts` (the hook path is in `SKIP` for calls, but a 401/403 on it is recorded through the throttled denied-read branch), not by the route.
- `lib/server/rate-limit/api-limiter.ts` is touched: the hook path is exempt from the per-minute API limit (production's 600 a minute would cut a tool-heavy session; the route has its own per-second limits).
- `journal/content.ts` exports `cutText` and `cutStrings` (reused by privacy.ts); `agents/store.ts` evicts harness sessions (ids `hs_…`) separately.
- `StatusVerdict` adds `keep` (a listed event with no matching rule, e.g. another `Notification` type); `statusFor` returns `undefined` only for an unlisted name.
- `harness/list.ts` (visibility of the list) is a seventh server module beside the plan's six, so the route stays thin.
- A cookie session or MCP token is refused on the hook route (403): only an API key (or the test principal) may send events.
- The registry's `sendsEvents` is true for an entry with `hookEvents` and a strategy other than `mcp-only`.
- `docs/observability.md` has the two harness counters; P5's `landflow.harness.blocked` row (see `blocked.md`) was not added here.
- `docs/harnesses.md` "Live status", `docs/connect-your-harness.md`, `docs/landflow-brain-mod.md`, `docs/features/cli.md`: written in P4b.
- P4b: the key made on `/connect` gets `harness:write` only when **Send live status** is ticked (shown for harnesses that send events), not by default, so the existing brain-key body is unchanged.
- P4b review round 2: the hooks block is a `node -e` filter (no `jq`, no `curl`), with the key in `$LANDFLOW_HOOK_KEY` and a clock-based order number, replacing the first version's `curl` and `$PPID` counter; agents bind through `X-Landflow-Agent`, not `agent_type` (the coordinator offered both options; the header needs no change to exported plugins or their names).
