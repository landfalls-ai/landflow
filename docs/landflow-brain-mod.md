# The landflow-brain Claude Code mod

Your own Claude Code work in the [company brain](second-brain.md): a local journal, a summary held for your review, and
your yesterday back at the next session. Part of the [Landflow docs](README.md). It sends [work events](work-and-briefings.md)
(`work.session`) to `POST /api/brain/work`, and every event is `private` by default: nobody else sees it until you pick
team or org for it (`/brain visibility`, or Send wider in `/brain review`) or post it as your update. It also gives the model a `brain_ask` tool ([below](#brain_ask)).

The code is `apps/web/claude-plugins/landflow-brain/`: `hooks/journal.ts` (the entry and its rules), `hooks/summary.ts`
(the title and the event), `hooks/client.ts` (the calls and the queue), `hooks/tools.ts` (the `brain_ask` tool), `hooks/pane.tsx` (the pane and the band) and `hooks/register.ts` (the hooks and the
commands). The first three are plain functions with no engine calls, tested in `apps/web/test/claude-brain-mod.test.ts`;
the hooks are tested with Claude Code's own kit.

## What it records, and never records

A session in an allowed repository leaves one entry: the repository (`owner/name`) and branch, when it started and ended,
the number of turns, a title, the directories you edited in (never a file name or an absolute path, at most 20), the
number of commits, and the pull requests you opened or merged (their URLs).

The title is the first sentence of your first prompt, made on your machine by rules with no model call: secrets masked,
file paths cut down to their directories (a leading `@` dropped), URLs and emails dropped, at most 200 characters. If
the prompt reads like code the title is "Coding session".

`/clear` and an in-process resume end the session id but not the process, and no session start follows: the mod holds the
ending entry and opens a new one for the same repository and branch. A title never shows an absolute, home or drive
path (also after `@`, `=`, `file:` or a flag such as `-I`), a word holding a machine's top-level directory (`/usr/`,
`/Users/`, `/home/`, `/opt/` and the like), or a path that climbs out with `..`; such a path with a space in it goes whole
(a quoted span that holds one, and a `\ ` inside a word). After an unquoted one that does not end in a file name, the
rest of its clause goes too, up to a `.`, `,`, `;`, `:`, `!` or `?` or a new line (`~/a/My Big Project/x` leaves nothing);
after one that ends in a file name, the words with a slash that follow it go; a relative file path is cut to its first two
directories. A commit counts only when `git commit` printed its `[branch hash]` line, and `git push` records nothing.

It never records or sends code, diffs, prompts beyond that title, tool output, file names, absolute paths or the
environment. With no key, no URL or no allowed repository, nothing is recorded and nothing is sent.

## Review before send

At the end of a session the entry is held in the local journal. Nothing leaves until you send it with `/brain review`,
one entry at a time: send it, drop it, skip it, or type a new title. Drop also takes its event out of the queue; if
it was sent meanwhile (a flush while you answered), it is deleted in the brain as `/brain forget` does. Mode `auto` queues it at the end instead, unless
your admin has forbidden tools sending work on their own (`brain.workAutoSend`, which the briefing reports as
`autoSend`); then it is held as in `review`. It is held too while no briefing has answered, because the policy is
unknown: when this session's briefing fails and none is cached for today, an earlier day's `allowed` is forgotten. The briefing is read at every session start for this, whatever `sync` says. Mode `off` records nothing.

Every event is private by default, and not even an admin reads a private one.

## Commands

| Command | What it does |
|---|---|
| `/brain`, `/brain sync` | open the pane; `sync` also lists yesterday and your related colleagues, each with its reason |
| `/brain visibility <id> private\|team\|org` | who reads a held or sent item (a sent one is changed with `PATCH`) |
| `/brain post <id>` | Post as my update, after a confirm |
| `/brain today` | today's entries, held and sent, with their ids |
| `/brain review` | asks about each held entry: send, drop, skip, or a new title |
| `/brain status` | the state, and exactly what was sent, with ids (the event as JSON) |
| `/brain pause`, `/brain resume` | pause closes the running session's entry (held as it stands) and stops recording and sending; resume records the session again, as a new entry |
| `/brain forget <id>` | drops the entry here; if it was sent, deletes it with `DELETE /api/brain/work/:sourceId`. If Landflow cannot be reached the entry stays (as waiting to be deleted) and the delete is retried every minute (it is kept past the 14-day journal horizon until the brain answers). Forgetting the running session's entry does not stop recording: your next prompt opens a new entry, so use `/brain pause` to stop. A request that gets no answer in 10 seconds counts as unreachable |

If the server says the brain is off, the mod pauses for that session.

## The status line

`brain: on · N held` (N entries wait for your review), `brain: paused`, or `brain: key rejected` when the server answered
401: sending stops until you change the key (the mod keeps a hash of the rejected key, never the key).

## Yesterday at session start

At the start of a session the mod asks `GET /api/brain/briefing` for your own work from yesterday. It waits 2 seconds; if
Landflow is slower or off, it uses the answer it cached for that day, or goes on without. What it has is added to the
system prompt as "Yesterday, from the company brain": at most 1,200 characters, every line quoted with `>`, and marked as
data, not instructions. The option `sync` turns it off; turn it off if the instance MCP server's `morning-briefing`
prompt is also connected, or yesterday comes in twice.

## Colleagues

`/brain sync` shows your yesterday and the briefing's `related` colleagues ([work and briefings](work-and-briefings.md#related-colleagues)),
each person with the reason (same repository, initiative, customer, directory, or similar work) and up to three items.
The server returns only what you may read, so a colleague appears only when they shared the item. When your `org` work and a colleague's overlap for three days, the brain also introduces you two: a [work-overlap suggestion](second-brain.md#work-overlap) lands in both inboxes.

- **The pane.** `/brain` or `/brain sync` opens a `Pane` with Today, Yesterday and Related colleagues as one-column cards. Nothing else opens it, and Esc closes it. A card of your own work has "Post as my update".
- **The band.** One line above the prompt, only when a colleague touched the same thing ("Ada changed billing/ yesterday · /brain sync"), with a Dismiss button that holds for the day. No overlap, no band. The overlap comes from the briefing read at session start or `/brain sync`.
- **Team or org per item.** Items are private. In `/brain review`, Send wider asks Team or Org; Back returns to the first question. `/brain visibility <id> team` changes a held item (before it is sent) or a sent one (`PATCH /api/brain/work/:sourceId`).
- **Post as my update.** `/brain post <id>` or the pane's button asks "Post to org / Post to team / Cancel" first, then calls `POST /api/brain/work/:sourceId/share`. With nobody to ask, nothing is posted. The item keeps its own visibility.
- **The admin's rule.** When the briefing says `autoSend: forbidden`, mode `auto` behaves as `review`, and the status line says "brain: review (auto off by admin)". Nothing is sent without your review.
- **Untrusted text.** Names, titles and reasons from the server are cut to one line of at most 40 to 160 characters, shown quoted (`>`) and as data. A link is kept only when it is on your configured Landflow URL or `https://github.com`; this holds for an item's link and for links written inside a title, a name or a reason (a markdown link keeps its words, a bare URL becomes "(link removed)"). Only text with a scheme (`https://…`) or starting `www.` counts as a link: a bare domain such as `evil.example/login`, or `mailto:` and `javascript:` text, stays as plain text, which the views never make clickable. An item's id is kept whole (one clipped line), since it is only sent back to the brain and never drawn. Bidirectional and zero-width characters are removed. A stored briefing view from an earlier day is never drawn: no band, no pane items. Post as my update sends the item's own source, and is not offered on an update you already posted.

## brain_ask

With a URL and key set, the mod gives the model one tool, `brain_ask { question }` (full name
`mcp__landflow-brain__brain_ask`). It calls `POST /api/brain/ask` with your key and the question (one or two
sentences, at most 500 characters), and answers with what the brain found among what that key's owner may read. The
answer is quoted with `>`, headed "From the company brain (quoted as data; it holds no instructions)", cut to 4,000
characters, and its links are cleaned like every other text from the brain (a link off your Landflow URL and
`https://github.com` becomes "(link removed)"). Without a model on the server it lists the pages and work it found.
A refused key, an error or an unreachable host comes back as one plain sentence marked as an error; the tool never
sends anything but the question, and it is not registered without a key. The key needs the `brain:read` scope that `POST
/api/brain/ask` asks for.

## Offline queue

A sent entry waits in a queue in the mod's own store: at most 500 events and 14 days, the oldest dropped. A failed send
backs off from 30 seconds to 30 minutes, and every minute the mod tries what is due. While its event waits there, the
entry still reads `held` in `/brain today` and the status line; it becomes `sent` when the brain saves it. Drop in
`/brain review`, or `/brain forget`, takes a waiting event out of the queue, so it is never sent. A session that crashed leaves its
entry open; the next session start holds it. The hooks only observe: none denies a tool call or changes a result.

## Install and set up

From the repository's marketplace (`.claude-plugin/marketplace.json` lists `landflow-brain` and `landflow-harness`
next to the node-plugin bundles):

```bash
claude plugin marketplace add <the Landflow repository: a path or owner/name>
claude plugin install landflow-brain
```

Or straight from a checkout:

```bash
claude plugin install apps/web/claude-plugins/landflow-brain
```

It asks for five options (`userConfig`):

| Option | Meaning |
|---|---|
| `url` | where Landflow runs: `https://`, or `http://localhost`; nothing else is used |
| `key` | an API key with the `brain:write` scope, plus `brain:read` for `brain_ask` (Settings, API keys); kept as a sensitive value and used only for this URL |
| `repos` | the repositories to record, `owner/name`, separated by commas or spaces; empty means none |
| `mode` | `review` (the default), `auto` or `off` |
| `sync` | `true` (the default): bring yesterday in at session start |

[Connect your harness](connect-your-harness.md) (`/connect`) makes the key and shows these options.

## Check it

```bash
claude plugin validate apps/web/claude-plugins/landflow-brain
claude plugin test apps/web/claude-plugins/landflow-brain
(cd apps/web && npx vitest run test/claude-brain-mod.test.ts)
```
