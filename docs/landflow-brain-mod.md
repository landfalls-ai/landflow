# The landflow-brain Claude Code mod

Your own Claude Code work in the [company brain](second-brain.md): a local journal, a summary held for your review, and
your yesterday back at the next session. Part of the [Landflow docs](README.md). It sends [work events](work-and-briefings.md)
(`work.session`) to `POST /api/brain/work`, and nothing it sends is visible to anyone else: every event is `private`.
This is the first slice. Colleagues, a pane, a band, sharing with a team and `brain_ask` come later.

The code is `apps/web/claude-plugins/landflow-brain/`: `hooks/journal.ts` (the entry and its rules), `hooks/summary.ts`
(the title and the event), `hooks/client.ts` (the calls and the queue) and `hooks/register.ts` (the hooks and the
commands). The first three are plain functions with no engine calls, tested in `apps/web/test/claude-brain-mod.test.ts`;
the hooks are tested with Claude Code's own kit.

## What it records, and never records

A session in an allowed repository leaves one entry: the repository (`owner/name`) and branch, when it started and ended,
the number of turns, a title, the directories you edited in (never a file name or an absolute path, at most 20), the
number of commits, and the pull requests you opened or merged (their URLs).

The title is the first sentence of your first prompt, made on your machine by rules with no model call: secrets masked,
file paths cut down to their directories, URLs and emails dropped, at most 200 characters. If the prompt reads like code
the title is "Coding session".

It never records or sends code, diffs, prompts beyond that title, tool output, file names, absolute paths or the
environment. With no key, no URL or no allowed repository, nothing is recorded and nothing is sent.

## Review before send

At the end of a session the entry is held in the local journal. Nothing leaves until you send it with `/brain review`,
one entry at a time: send it, drop it, skip it, or type a new title. Mode `auto` queues it at the end instead, unless
your admin has forbidden tools sending work on their own (`brain.workAutoSend`, which the briefing reports as
`autoSend`); then it is held as in `review`. It is held too while no briefing has ever answered, because the policy is
unknown. The briefing is read at every session start for this, whatever `sync` says. Mode `off` records nothing.

Every event is private: only you read it, admins included.

## Commands

| Command | What it does |
|---|---|
| `/brain today` | today's entries, held and sent, with their ids |
| `/brain review` | asks about each held entry: send, drop, skip, or a new title |
| `/brain status` | the state, and exactly what was sent, with ids (the event as JSON) |
| `/brain pause`, `/brain resume` | pause closes the running session's entry (held as it stands) and stops recording and sending; resume records the session again, as a new entry |
| `/brain forget <id>` | drops the entry here; if it was sent, deletes it with `DELETE /api/brain/work/:sourceId`. If Landflow cannot be reached the entry stays (as waiting to be deleted) and the delete is retried every minute |

If the server says the brain is off, the mod pauses for that session.

## The status line

`brain: on · N held` (N entries wait for your review), `brain: paused`, or `brain: key rejected` when the server answered
401: sending stops until you change the key (the mod keeps a hash of the rejected key, never the key).

## Yesterday at session start

At the start of a session the mod asks `GET /api/brain/briefing` for your own work from yesterday. It waits 2 seconds; if
Landflow is slower or off, it uses the answer it cached for that day, or goes on without. What it has is added to the
system prompt as "Yesterday, from the company brain": at most 1,200 characters, every line quoted with `>`, and marked as
data, not instructions. The option `sync` turns it off.

`/clear` and an in-process resume end the session id but not the process, and no session start follows: the mod holds the
ending entry and opens a new one for the same repository and branch. A title never shows an absolute, home or drive
path, and a relative file path is cut to its first two directories; a commit counts only when `git commit` printed its
`[branch hash]` line, and `git push` records nothing.

## Offline queue

A sent entry waits in a queue in the mod's own store: at most 500 events and 14 days, the oldest dropped. A failed send
backs off from 30 seconds to 30 minutes, and every minute the mod tries what is due. A session that crashed leaves its
entry open; the next session start holds it. The hooks only observe: none denies a tool call or changes a result.

## Install and set up

```bash
claude plugin install apps/web/claude-plugins/landflow-brain
```

It asks for five options (`userConfig`):

| Option | Meaning |
|---|---|
| `url` | where Landflow runs: `https://`, or `http://localhost`; nothing else is used |
| `key` | an API key with the `brain:write` scope (Settings, API keys); kept as a sensitive value and used only for this URL |
| `repos` | the repositories to record, `owner/name`, separated by commas or spaces; empty means none |
| `mode` | `review` (the default), `auto` or `off` |
| `sync` | `true` (the default): bring yesterday in at session start |

A page that makes the key and the options for you comes later.

## Check it

```bash
claude plugin validate apps/web/claude-plugins/landflow-brain
claude plugin test apps/web/claude-plugins/landflow-brain
(cd apps/web && npx vitest run test/claude-brain-mod.test.ts)
```
