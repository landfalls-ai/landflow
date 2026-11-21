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
- An agent session binds only when `agent_type` is `<slug>:<slug>` of exactly one agent the key's owner may run (editor access); a slug shared by two agents is an own session. Binding is fixed by the session's first event.
- The hook route is exempt from the API rate limit; its own limits are per key and per key owner, per second (shared across mains in queue mode). The open-session cap is per key owner and its count is cached 5 seconds per main, so mains can overshoot it by a few sessions.
- A session binds to an agent only on its first event, and only a `SessionStart` that names one the owner may run; the stored row decides, and the event's view (content or status only) is chosen after that write.
- Past 5,000 applied events a session stores only event names (status and counts still move). Late (older) events are not counted toward that cap, only bounded by the rate limits.
- The agent mirror keeps the newest 500 timeline entries and rebuilds from the newest 500 events; harness mirrors have their own 200-per-agent cap and never evict other sources' sessions.
- The mirror's read-modify-write is not safe when two mains take events of one session at the same moment: a rare lost entry shows until a late event rebuilds the timeline.
- `X-Landflow-Hook-Time` more than 5 minutes ahead of the server is ignored (receive time is used).

## Roadmap lines

- C04 hook ingest (routes, status machine, mirror, live event, sweep): built (P4a). Open: Agents page chip, `/connect` live-status step, `landflow harness detect`, brain mod `/brain status-sharing` (P4b).
- C15 registry, kagent runtime labels, source scan: built (P4a). Open: `/connect` reads the registry (P4b, empties the scan's `PENDING` allowance); Codex wrapper and OpenCode plugin entries once verified live.
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
- `docs/harnesses.md` "Live status", `docs/connect-your-harness.md`, `docs/landflow-brain-mod.md`, `docs/features/cli.md` are P4b's T-14.
