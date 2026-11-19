# The Notion brain

A project's second brain can live in Notion: the pages, facts, practices and notes the project already has are copied to a
Notion page a person owns, and what people change there is read back. This page is built in parts by the Notion brain
program (wave nb1 and later); this part, **Setting it up**, is what exists after NB03: the link and its routes. Nothing
syncs yet (wave nb2 copies, pushes and pulls).

## Setting it up

One project links to one Notion page, with a Notion API credential the project may use. The credential is the existing
`productivity.notionApi` one (a `productivity.notionOAuth2Api` credential works too); no key leaves the vault, and no
response, audit row or log line holds it. The Notion integration must be added to the page first (in Notion: ••• → Add
connections → the integration), which gives it access to the page and everything under it.

| Route | Who | What |
|---|---|---|
| `GET /api/projects/:id/brain/notion` | project members (an API key needs `brain:read`) | `{ linked: false, canManage }`, or the link: status, credential (id and name), the page, the copy's progress, what waits, open problems |
| `POST …/check` `{ credentialId, page }` | project admins | reads the page and writes nothing: its title, whether a "Landflow brain" page is already under it, what a copy of this project would send (pages, facts, practices, project-scope notes) and about how many minutes it takes |
| `POST /api/projects/:id/brain/notion` `{ credentialId, page, knowledgeScope?, rps? }` | project admins | checks again, then makes the link in `setting_up` and answers 202 |
| `PATCH` the same | project admins | `paused`, `rps` (1 to 8 requests a second, 2 by default), `knowledgeScope` (`brain`, the default: company pages under "Landflow brain" only, or `root`) |
| `DELETE` the same | project admins | disconnects: the link is kept as `unlinked` for the history, nothing is sent to Notion, which keeps what is there, and the local brain is unchanged. The project can be linked again |
| `POST …/sync` | project admins | makes the next sync due at once (202) |
| `GET …/problems` | project members | the open sync problems: kind, Landflow's words about it, the actions it offers |
| `POST …/problems/:problemId` `{ action }` | project editors; `repair` and `deleteLocal` need an admin | `dismiss` records who and when; `putBack`, `deleteLocal`, `keepAsFact` and `repair` answer 409 "Not available yet" until the pull (wave nb2) performs them; an action the problem's kind does not offer is 400 |

`page` is a Notion link, a 32-hex id or a dashed UUID. The check answers 400 for a link to another host, a credential of
another type or a key Notion refuses, 403 for a credential the project may not use (share it with the project first), 404
"Landflow can't see this page" (with the connection to add) for a page not shared with the key, and 409 when another
project holds that page. One project has one active link and one page belongs to one project; disconnecting frees both.

A link whose project is deleted stays in the table and reads as unlinked: nothing is sent to Notion, which keeps what is there.

`LANDFLOW_NOTION_BRAIN=off` switches the whole feature off: every project's brain stays local, links read as *paused*, the
check, link, change and sync routes answer 409 "The Notion brain is switched off on this instance" and nothing calls Notion
(disconnecting still works). The tables are `notion_brain_links`, `notion_brain_items`, `notion_brain_outbox`,
`notion_brain_problems` and `notion_knowledge_docs` (migrations 2908 to 2911). A project with a link that is not `unlinked`
resolves to the `notion` backend in `brainStoreFor`; until the Notion store ships it reads and writes exactly like the local one.
