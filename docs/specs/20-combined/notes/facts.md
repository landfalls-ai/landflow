# Notes for the integrator from W1 P3 `facts` (C01 + C02)

Apply these after the last merge of the wave; P3 edited no shared doc (`docs/history.md`, `docs/limitations.md`,
`docs/roadmap.md`, `docs/README.md`).

## `docs/limitations.md`

- A brain fact's visibility scope (which workflows, agents and entities a person may read) is still applied in JS after the
  SQL page of facts, so a scoped list reads every live latest fact and filters, as before; only the latest-live rule and the
  limit (for unscoped reads) moved into the query.
- Old versions of a fact are not mirrored to Notion (the copy holds the latest of each fact); a forgotten fact's Notion row is
  trashed, and the team notes' Notion push (`brain/notion/push.ts`) does not yet skip a forgotten project-scope note.
- A new version's vector is written after the commit (the database transaction is synchronous, the vector store is another
  SQLite file); if that write fails it is logged and the next study re-embeds. The study itself writes rows synchronously and
  rebuilds the vectors once at its end, so the all-or-nothing vector write covers people and agents, not each study write.
- A forgotten fact is left out of the vector index only at the next study (its vector is dropped at once on a forget, and the
  search ignores ids it cannot map), and "forget after" has no sweeper by design: reads hide the fact from that time.
- Notebook "forget after" is the note's expiry (a note forgotten with a time is deleted by the sweeper after the grace
  period; one forgotten without a time is kept until a person deletes it).

## `docs/roadmap.md`

- C01 fact versioning and C02 supersede-and-forget: built (2026-11-21, W1 P3): chains with `version`, `is_latest`, `root_id`,
  `parent_id`, `relation`, static facts, History, soft forget and restore for facts and team notes, lazy expiry for notes,
  settling a dispute in one transaction. Migrations 2912, 2913.

## `docs/README.md`

No new page: the feature map entries for [second-brain.md](../../../second-brain.md) and
[team-notebook.md](../../../team-notebook.md) stay.
