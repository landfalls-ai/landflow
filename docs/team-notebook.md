# Team notebook

A team's members work one after another and each starts from what it was handed. The notebook is the memory they share:
short notes that a member writes while it works (a fact it found, a decision it made, a question it could not settle), that
the others search before they start, and that a person can read, check and keep. Open a team and choose **Notebook**
next to **Chart** (`/agents/teams/:id?tab=notebook`).

## The note

One row of `team_notes` (migration 2010; `lib/shared/notebook.ts`):

| Field | Meaning |
|---|---|
| `kind` | `fact`, `decision`, `open_question`, `task_status` or `artifact_ref` |
| `text` | up to 600 characters, whitespace squeezed |
| `scope` | `run`, `team` or `project` (below) |
| `status` | `unverified`, `verified`, `disputed`, `answered` or `expired` |
| source | who wrote it (member, or a person), the execution, the span and the node it came from, an excerpt, and a `url` when it was read from a page |
| `tainted` | it came from outside (below) |
| `disputes` | the id of the note it disagrees with |
| embedding | a vector and the model that made it, for search by meaning |

## Scopes and how long a note lives

- **Run**: what a member writes. Only a run's own members write here, so a model cannot fill the team's memory by itself.
  Kept 14 days, unless promoted.
- **Team**: what the lead or a manager promotes (`note_promote`), or a person adds or promotes in the tab. Expires 30 days
  after it was last read or searched, unless a person **Verifies** it, which keeps it.
- **Project**: the team's notes that the whole project may use. A person approves it: promoting a team note to the project
  files a suggestion in the second brain's inbox ([second-brain.md](second-brain.md)), with the note as the proposal, and
  **Keep it** there writes it. Kept until deleted.

An expired note stays for 14 days (hidden unless asked for with `expired=1`) before it is deleted. A boot and a daily job in
`maintenance.ts` do the expiring.

## What a member can do

Every Landflow agent in a team gets these tools (`lib/server/notebook/tools.ts`), shown in the run's timeline with a
notebook-pen icon:

- `note_add { kind, text, url? }`: a new note, in the run's scope. A note that already stands in the run's notebook is not written twice.
- `note_search { query }`: the notes that fit the query, ranked by meaning (below). The lead is also given the open
  questions, the decisions and the disputed notes in its first message, so it begins with them.
- `note_update { id, text?, answer? }`: change one of its own run notes, or answer an open question.
- `note_dispute { id, text }`: add a note that disagrees with another; both stay, linked, until a person settles it.
- `note_promote { id }`: run to team. Only a manager or the lead.

Every note carries where it came from: the member, the execution and the span. In the tab a note links to that span in the
Run Trace (`/runs/:id?tab=trace&span=:spanId`), which scrolls to it. With `traceContent: off` ([run-trace.md](run-trace.md))
the ids stay and the excerpt is not kept.

### Notes from outside

A note is **tainted** when it gives a `url`, has a URL in its text, or its author used a web or fetch tool in the same
run (a conservative reading: the author may not have used what it read). A tainted note shows a warning, and it cannot be
promoted until a person has **Verified** it. This stops a page's instructions from becoming the team's standing memory.

### Search by meaning

Notes get an embedding from Ollama (`nomic-embed-text` by default) the first time they are written or edited, and a
search ranks by cosine similarity. When Ollama cannot be reached (5 s timeout, then no new attempt for 60 s) or the notes
have no embedding, search falls back to matching words and says so (`via: keywords`). Each note keeps the model that made
its vector; a note is not embedded again when the model setting changes (edit it to refresh).

## Disputes

A disagreement is a pair, not an edit: the Notebook tab shows the two notes side by side under **Disputes**, each with
**Keep this one**. Keeping one verifies it and expires the other.

## The tab

- Tiles for the counts (by scope and by status), a search box that ranks by meaning, scope pills, and a **Live** dot while
  a run is writing (the tab polls every 5 s).
- Groups: **Disputes**, **Open questions**, **Decisions**, **Facts and the rest**. Each card has the author's face, a status
  pill, the Run Trace link, a bar for the time it has left, and (for a note from outside) its host with a warning.
- Actions: Verify, Dispute, Promote (run to team, team to project as a suggestion; the card then shows an inbox chip),
  Answer and Reopen (open questions), Delete, and an **Add a note** form.
- A note that arrives while the tab is open rings once and a deleted one fades out.

## On the canvas and in the Run Trace

When a member writes, searches or disputes a note, the team node and the live strip (`team-live.tsx`) say so in plain words
("Writing a note", "Noting a decision", "Searching the notebook", "Disputing a note") with a notebook-pen icon and an entrance animation, and the run's headlines
include note moments (`shared/run-headlines.ts`, `shared/team-progress.ts`). In the Run Trace each note tool call is a
step of its member.

## Claude Code members: the notebook over MCP

A team member that is a Landflow agent deployed to kagent (a Claude Code or declarative agent called over A2A) runs in
kagent, not in the host, so it cannot be handed host functions. It gets the same notebook over **MCP**:

1. When the team runtime calls such a member, it opens a short-lived **call** for it (`notebook/binding.ts`): the team,
   the run, the member, the span, and a key like `nbk_...`. The call closes when the A2A task ends.
2. Landflow's MCP server for that agent (`kagent/mcp.ts`) lists `note_add`, `note_search`, `note_dispute` and `note_update`
   (not `note_promote`: a remote member is never a manager). `kagentTools` adds them only for an agent that some team calls
   as a remote member.
3. A note tool call arrives as the agent. The server looks for that agent's open calls:
   - **exactly one**: the note lands on that run, as that member, with the request's span;
   - **none**: refused ("no team run is waiting on you");
   - **several** (the same agent is called by two runs at once): refused unless the call names the run with the `run`
     argument. Each request ends with "Notebook run key: nbk_... If a note tool asks which run, pass this as `run`."

   A note never lands on a guess, and a note after the call ended is refused.
4. The agent's resolution is by A2A URL: an endpoint is a deployed Landflow agent when its stored `kagent.trace.a2aUrl`, or
   the `/agents/<namespace>/<name>` tail of the URL, equals the agent's kagent name.

Redeploy an agent after upgrading for kagent's own runtime to list the new tool names. Claude Code reads the tool list from
the MCP server at the start of each session, so it needs nothing.

## The routes

See [reference/api.md](reference/api.md). `GET /api/agent-teams/:id/notes` lists (`scope`, `kind`, `status`, `q`, `run`,
`expired=1`) and returns the counts; `POST` adds a person's note; `POST /api/agent-teams/:id/notes/:noteId { action }` does
`verify`, `answer`, `reopen`, `dispute`, `resolve`, `promote` or `edit`; `DELETE` forgets a note. They follow the team's
access (`agentTeam` resource).

## Settings

| Variable | Default | |
|---|---|---|
| `LANDFLOW_NOTEBOOK_EMBEDDINGS` | on | `off` skips the embedding model and always searches by words |
| `LANDFLOW_NOTEBOOK_EMBED_MODEL` | `nomic-embed-text` | the Ollama model for embeddings (`OLLAMA_URL` says where) |

## Not built

See [limitations.md](limitations.md#team-notebook).
