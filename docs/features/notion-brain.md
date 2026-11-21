# Notion as the brain

Part of the [Landflow docs](../README.md). A project's second brain can live in Notion: the pages, facts, practices and notes the project already has are copied to a Notion page a person owns, and what people change there is read back. This page is built wave by wave; the sections below are added by the package that builds each part. A linked brain syncs: the first copy, the push of every change, the pull of what people edit in Notion and the company pages read as knowledge are built (nb1, nb2). Wave nb3 built the Brain card (a link's status, problems and the button that fixes a stopped one), the Brain page's Notion parts and Spotlight's Notion asks (NB08); the live check with a real Notion is still to come.

## How it is built

The brain's local SQL tables stay the working copy: runs, Ask, MCP and search read them synchronously, and nothing reads Notion. What changes is where a write is heard. Wave nb1's first package (NB01) adds a seam with three parts, and no screen changes.

- **One store per project.** `brainStoreFor(projectId)` (`apps/web/src/lib/server/brain/store/port.ts`; import `@/lib/server/brain/store`, not the port) answers a `BrainStore` (`lib/shared/brain-store.ts`). With no project, no resolver or a project the resolver calls `local`, it is the **local store** (`store/local.ts`): the existing functions (`upsertEntity`, `deleteEntity`, `addEntityFact`, `draftPractice`, `personAdd`), unchanged, with the origin passed through. A project whose resolver says `notion` (the Notion links register one, NB03) gets a store that reports `backend: 'notion'` and writes exactly as the local one: no Notion store is registered, and the sync hears the writes through the change feed instead (NB04's outbox listener, `brain/notion/store.ts`, queues each one for the push). A resolver that throws is logged and the project is local. The slot is a `singleton('brain-store')`.
- **A change feed every write goes through.** After a write is stored, the writer calls `emitBrainChange({ kind, key, projectId?, op, origin, by?, version?, at })`. `onBrainChange(listener)` hears it; listeners run in a microtask, one after the other, and one that throws is logged (kind and key, never text) without failing the write or stopping the next. A write that threw emits nothing, and nothing is emitted inside a transaction that may still throw. The writers, each marked `// NB01:`: `upsertEntity` and `deleteEntity` (`entity`; a delete also emits `fact` deletes and a `summary` delete), `upsertFact` (`fact`; `addEntityFact` calls it, so one change), `deleteFact` and `staleFactsBefore` (one per fact), `writeSummary` (`summary`), `draftPractice`, `markApproved`, `markRejected` and `markRetired` (`practice`, with the `version`), and the notebook **store**'s `insert`, `patch`, `delete`, `expire` and `deleteTeam` (`note`), which catches every notebook writer.
- **Who made it.** `changeOrigin(explicit?)` (`store/origin.ts`): an explicit `notion` (the puller, NB05) wins; else `person`, with the user's id, for a signed-in session (`via: 'session'` or `'test'`); else `landflow` (an API key, MCP, a flow, the study, the loop). It never trusts a name a caller sends.

### What comes from Notion is untrusted

- A practice drafted with `source: 'notion'` is **tainted** (like `learned` and `agent`) and may be drafted **at project level only**; an org practice is refused with 403, and approving it needs `reviewedSources: true` (409 `PracticeNeedsReview`). No route accepts `notion` from a caller: `routeOrigin` never returns it.
- A note added with origin `notion` is `unverified` and `tainted`, with `source: { tool: 'notion', url }`; it cannot be promoted until a person verifies it.
- A fact pulled from Notion carries an evidence item labelled `Notion` (`NOTION_EVIDENCE_LABEL`) whose `href` is the page's URL; a fact has no `source` field.

Tests: `apps/web/test/brain-store-nb01.test.ts`.

### The sync that writes into Notion (NB04)

- **The leader service `notion brain`** (`brain/notion/service.ts`, in `runtime.ts`'s table with the other leader services) ticks every 5 seconds. A tick takes each link that is not paused or stopped: `setting_up` and `copying` links run the copy, an `active` link drains its outbox (at most 200 rows a tick), and the once-an-hour and once-every-10-minutes jobs below run. With `LANDFLOW_NOTION_BRAIN=off` a tick sends nothing; the outbox still fills, and switching it on pushes what changed.
- **The outbox** (`brain/notion/store.ts`) hears the change feed. Every change of a linked project, except one whose origin is `notion` (the puller's own), becomes one row in `notion_brain_outbox`, coalesced per (link, kind, key): ten changes of one page in a second are one row and one push. A fact about a page also queues that page, because the fact is a line on its body. Home is re-rendered at most every 10 minutes and the Log every hour; every 30 minutes each page is looked at again, because new work changes a page's Work section without a brain change. A push renders the object, hashes its properties and its region, and writes only what changed: a new description is one `PATCH` of the row and no body write.
- **The initial copy** (`copy.ts`) makes the brain page, the Log page, the four databases, then the rows and their bodies, and is resumable: the link's `copy` progress and the saved ids say where it stopped; a database is adopted by title under the brain page and a row by its `Landflow ID` (one query per database), so a restart, a lost answer (`mayHaveLanded`) or a `createDatabase` whose follow-up read failed never makes a second one. Rows are made without a body and each body is written once, whole. A request budget of `copyRequests(counts)` plus 15 per restart is tested.
- **One writer.** Everything goes through the scoped writer (`linkClient`): an item whose `notion_id` is not under the root gets no request, logs `[notion-brain] refused write <id>`, ends its outbox row with a `last_error`, and the next object's push still lands. A refused key (401, or a deleted credential: status 0, "The Notion key was deleted") sets the link `unauthorized` and files one notice for the project's admins; Notion blocking the key pauses it; a page that is no longer shared sets `unshared`. The outbox is kept, and a resume continues.
- **Words and ids only in logs.** No key and no page text reaches a log line; `LANDFLOW_NOTION_WRITE_LOG` holds one line per write with no text.
- **`contracts/nb/sync.ts`** (`brain/notion/sync.ts`, never edited here) holds the pure parts: the region markers, `pageBody`, `wholeBody`, `splitBody`, the items and outbox tables' helpers, `setRegionConflict` (NB05 hears a person's edit of the Landflow part; with no hook a `landflow_part_edited` problem is filed) and `forgetLink`. `render.ts` renders to the fixtures in `apps/web/test/fixtures/notion-render/` byte for byte.

Tests: `apps/web/test/notion-push-nb04.test.ts`, `apps/web/test/notion-copy-nb04.test.ts`.

## How Landflow talks to Notion

One client in the host (`apps/web/src/lib/server/notion/client.ts`) makes every Notion call the brain's sync needs. It is
reached through `notionClientFor({ credentialId })` (the slot and the shapes are in `notion/port.ts`); `runtime.ts` loads
it. It never calls `api.notion.com` from a test: the only Notion a test talks to is the local fake
(`apps/web/test/fake-notion.ts`, [development.md](../development.md#the-notion-fake)).

- **The key.** The credential is of type `productivity.notionApi` (field `apiKey`) or `productivity.notionOAuth2Api`
  (`accessToken`); `baseUrl` on it is honoured (default `https://api.notion.com`; a test points it at the fake). The key is read
  from the vault right before each request and is kept nowhere else. No message, span attribute, log line or write-log line holds
  it, and none holds page text. Requests go through the guarded fetch, so `LANDFLOW_OUTBOUND_ALLOW` and the production profile's
  private-address block apply.
- **Version and Markdown.** Every request carries `Notion-Version: 2026-03-11`. Every Markdown call sends
  `markdown_version: "v2"` (a query parameter on a read, a body field on an update and on a page create with `markdown`). A page
  read follows `unknown_block_ids` (up to 20 more reads) and keeps `truncated` when Notion cut the text or the cap was reached.
  A database is created with `initial_data_source.properties`, then its data source is read, because the create answer carries no
  property ids. Lists are followed by `next_cursor` while `has_more`, never by counting; a data source query's `request_status` is
  returned as it came (`incomplete` past 10,000 results).
- **Limits.** One token bucket per credential id, shared by every link that uses the key: the rate is the highest `rps` any of
  them asked for (2 by default, at most 8), burst 3, and data source queries also take from their own bucket (at most 2.5 a
  second). Five 429s in a row halve the rate for ten minutes. Rich text is split at 2,000 characters a run, counted in UTF-16
  units as Notion counts them (an emoji is two) and never inside one, at most 100 runs (beyond that cut with "…"); a page body is cut at a heading before about 4,500 blocks or 450 KB and ends with "Cut here: the
  rest is in Landflow".
- **Errors and retries.** 429 and 529 wait `Retry-After` (or `additional_data.retry_after`, at most 120 s) and go again;
  429 `public_api_request_blocked` is `blocked` and is never retried. 500 backs off with jitter from 1 s to 5 min, at most 6
  tries in one call, then the caller's outbox reschedules; a read that gets 503 or 504 is treated alike. A 503 (or 504) on a
  write is not retried, because it may have landed: the error says `mayHaveLanded`, and the caller re-reads first. 409 is
  `conflict` (the caller re-reads, then retries once). 400, 401, 403 and 404 are `invalid`, `unauthorized`, `forbidden` and
  `notFound`, and are not retried; no answer is `network`. Every error is a `NotionError` with its kind, status and Notion's `code`.
- **The write scope.** `scopedWriter(client, { rootId, ownIds, ownDataSources })` wraps a client: a page may be created only under
  the root, an own page or an own data source, a database only under the root or an own page, and an update or a move to trash
  only of an own page or data source. Anything else throws a `NotionError` of kind `outsideRoot` before a request is sent and logs
  `[notion-brain] refused write <id>` (the id only). Reads are not limited by it.
- **The write log.** With `LANDFLOW_NOTION_WRITE_LOG=<file>` set, every write appends one JSON line
  `{ at, method, pathTemplate, targetId, parentId }`: ids only, never a body or a header. It is a test and live-check aid
  ([configuration.md](../reference/configuration.md)).

## Setting it up

**In the product (NB07).** A project admin moves the brain to Notion from the project's **Settings** tab, in the **Brain** card
after Governance ("Where this project's brain lives": **Landflow** or **Notion**). Step by step:

1. **In Notion** (someone who owns the workspace): make an internal connection (Settings → Connections → Develop or manage
   integrations → New integration) with the capabilities **Read content**, **Update content** and **Insert content**, and copy
   its secret. Then open the one page the brain should live under and share it with the connection (••• → Add connections). The
   page and everything under it become visible to Landflow; nothing else in the workspace does. "User information with email"
   is optional (it lets a pulled change name who made it).
2. **In Landflow**, choose **Notion**. The **Notion key** list shows the keys this project may use, by name (the project's
   own and those shared with it); with exactly one it is already picked. **New Notion key** opens the credential dialog for
   `productivity.notionApi`: paste the secret, **Test connection** says "Authenticated as <the connection>", **Create**. The card
   keeps only the credential's id and name and never shows, logs or stores the secret. If the productivity plugin is not
   running the button says "Start the productivity plugin to add a Notion key" and existing keys are still listed.
3. Paste the page's link (or id) and press **Check**. It shows the page's title, the workspace and the connection, and "A
   Landflow brain is already here: it will be reused" when one is; a page that is not shared answers "Landflow can't see this
   page: open it in Notion → ••• → Add connections → <connection>" and offers no Connect.
4. **What will be copied**: the counts (pages, facts, practices, notes), the one line of what never leaves
   (private and team-only work, nightly briefings, usage and AI spend, run data, other projects, secrets), about how many minutes
   it takes, and which pages Landflow reads as knowledge: **Pages you add under Landflow brain** (the default) or **Every page
   under <the page>** (decision D4). **Connect and copy** starts it.
5. **While it copies** the card shows a progress bar ("Copying the pages · 120 of 300") and "You can leave this page"; it asks
   again every 3 seconds while the link is `setting_up` or `copying`, every 30 seconds otherwise, and not at all while the tab is
   hidden.
6. **When it is in sync** the card reads "In sync · synced 2 minutes ago · 0 waiting · 1 problem" with **Open in Notion**,
   **Sync now**, **Pause** (**Resume** when paused), the speed (2 requests a second, or 8 "if your Notion is on Business or
   Enterprise"), the knowledge scope and **Disconnect**, which asks first ("Landflow stops syncing. Your Notion pages stay as
   they are, and the brain stays in Landflow."). Members who are not admins see the status line, Open in Notion and the problems,
   and nothing to change. The Brain page shows the same sentence as a chip ([second-brain.md](../second-brain.md#the-brain-page)).

The words are one file, `lib/client/notion-brain.ts` (`statusSentence`, `STATUS_FIX`, `copyLine`, `actionsFor`), so the card, the
Brain page's chip and Spotlight's card say the same thing.

### A refused key and an unshared page have a way back

A stopped link shows its sentence and its one button: **Notion refused the key** → **Pick another key** (the key list and New
Notion key again, then **Use this key**; updating the same credential in the dialog and pressing **Check again** works too),
**The page is no longer shared** → **Check again** (after sharing it again in Notion), **Paused** → **Resume**, **Needs a repair** →
**Repair**. Behind the first two, `PATCH …/brain/notion` takes `credentialId` (another Notion key the project may use) or `paused:
false`: the page (and the brain page, when the link has one) is checked with that key first, and only then is the key kept and
the link moved back to `active` (or `setting_up` when it never got its databases), with the one notice to the admins
("The brain is in Notion"). A refused key (400), a credential of another type (400), a credential the project may not use (403),
a page the key cannot see (404) and a Notion that does not answer (504, within the same 15 seconds for the page and the brain page together) leave the link as it was. `PATCH { paused: true, credentialId }` on an `unauthorized` or `unshared` link checks the key, keeps it and sets `paused`; a later **Resume** (`paused: false`) then goes to `active`. The audit row
`notion-brain.update` names `credentialId`, never the key.

### The check's deadline, and one check per project

A check answers within 15 seconds (`CHECK_DEADLINE_MS`). When Notion has not said who the key is, or has not returned the page,
by then it is a 504 "Notion took too long to answer. Try Check again in a moment." and nothing was written. Once the page is read,
the search for an existing brain stops starting new reads at the deadline and answers what it has: a brain named
`Landflow brain · <project>` is found by the first pass (the root's children), a brain found only by the deeper probe of up to 20
child pages may be missed (`found: false`), which is safe because the copy finds the brain page by its title again before it
creates one. One check runs per project at a time: a second check of the same page with the same key shares the running one's
answer (Notion is asked once), a different page or key while one runs is a 409 "A check of this project is running; try again
when it ends", and linking (which checks again) follows the same rule.

One project links to one Notion page, with a Notion API credential the project may use. The credential is the existing
`productivity.notionApi` one (a `productivity.notionOAuth2Api` credential works too); no key leaves the vault, and no
response, audit row or log line holds it. The Notion integration must be added to the page first (in Notion: ••• → Add
connections → the integration), which gives it access to the page and everything under it.

| Route | Who | What |
|---|---|---|
| `GET /api/projects/:id/brain/notion` | project members (an API key needs `brain:read`) | `{ linked: false, canManage }`, or the link: status, credential (id and name), the page, the copy's progress, what waits, open problems |
| `POST …/check` `{ credentialId, page }` | project admins | reads the page and writes nothing: its title, whether a "Landflow brain" page is already under it, what a copy of this project would send (pages, facts, practices, project-scope notes) and about how many minutes it takes |
| `POST /api/projects/:id/brain/notion` `{ credentialId, page, knowledgeScope?, rps? }` | project admins | checks again, then makes the link in `setting_up` and answers 202 |
| `PATCH` the same | project admins | `paused`, `rps` (1 to 8 requests a second, 2 by default), `knowledgeScope` (`brain`, the default: company pages under "Landflow brain" only, or `root`), `credentialId` (another key; checked first, see above); `paused: false` also tries an `unauthorized` or `unshared` link again |
| `DELETE` the same | project admins | disconnects: the link is kept as `unlinked` for the history, nothing is sent to Notion, which keeps what is there, and the local brain is unchanged. The project can be linked again |
| `POST …/sync` | project admins | makes the next sync due at once (202) |
| `GET …/problems` | project members (an API key needs `brain:read`, like the link) | the open sync problems: kind, Landflow's words about it, `notionUrl` when it names a Notion page, the actions its kind offers (the client shows the ones the viewer's role may press) |
| `POST …/problems/:problemId` `{ action }` | project editors; `repair` and `deleteLocal` need an admin | `dismiss` records who and when; `putBack`, `deleteLocal`, `keepAsFact` and `repair` do what [Problems and what they offer](#problems-and-their-actions) says; 409 when the problem is resolved already, the object it names is gone, or `LANDFLOW_NOTION_BRAIN=off`; an action the problem's kind does not offer is 400 |

`page` is a Notion link, a 32-hex id or a dashed UUID. The check answers 400 for a link to another host, a credential of
another type or a key Notion refuses, 403 for a credential the project may not use (share it with the project first), 404
"Landflow can't see this page" (with the connection to add) for a page not shared with the key, and 409 when another
project holds that page. One project has one active link and one page belongs to one project; disconnecting frees both.

A link whose project is deleted stays in the table and reads as unlinked: nothing is sent to Notion, which keeps what is there,
and the deleted project's Notion page can be linked to another project again.

`LANDFLOW_NOTION_BRAIN=off` switches the whole feature off: every project's brain stays local, links read as *paused*, the
check, link, change and sync routes answer 409 "The Notion brain is switched off on this instance" and nothing calls Notion
(disconnecting still works). The tables are `notion_brain_links`, `notion_brain_items`, `notion_brain_outbox`,
`notion_brain_problems` and `notion_knowledge_docs` (migrations 2908 to 2911). A project with a link that is not `unlinked`
resolves to the `notion` backend in `brainStoreFor`; it reads and writes exactly like the local one, and the sync hears its writes through the change feed.

## What Landflow writes

Under the page a person shared, one page named for the project, with these children.

- **Home** (the brain page's body): a callout saying how this works, then the counts and the index, written with `update_content` so the child pages and databases are never replaced.
- **Log**: the project's log, from its first heading on.
- **Four databases**: Pages (initiatives, customers, people, systems, one row each, with a body per page), Facts, Practices and Notebook. Every row has a `Landflow ID` property that keys it.
- **The region and "Your notes".** Each page and practice body is `<!-- landflow:start -->`, Landflow's text, `<!-- landflow:end -->`, then `## Your notes`. Landflow rewrites only the region; a person's edit inside it is reported and put back, and what is under "Your notes" is never touched.
- **How the text is rendered.** Starting from the project's own page, Markdown from `## Summary`: `[[type/id|Label]]` links become page mentions where the target is in Notion and the plain label elsewhere, `<` and `>` are escaped, and text over the limit is cut at a heading and never inside a code block. Practices show the approved version, with a callout while a draft from Notion waits.
- **Versions and forgotten facts.** Only a fact's latest version is copied (the Facts database holds one row per fact, keyed by its id; old versions are never mirrored, and a new version rewrites the row). A fact a person forgot in Landflow leaves the copy: the next push trashes its row, and **Restore** writes it back as a new row.
- **What never leaves.** Only org or ownerless work shows on a page (private and team work, and the actors of work, stay in Landflow); run notes, notes of other projects, facts of other projects or none, and org practices are not copied. Suggestions are titles with "Open in Landflow".

## What comes back from Notion

Wave nb2's pull (NB05; `apps/web/src/lib/server/brain/notion/pull.ts`, `conflicts.ts`, `problems.ts`) reads what people edit in the
linked pages. Every two minutes per active link (or at once on **Sync now**), for each of the four data sources it queries the rows
edited since the cursor minus 5 minutes (edit times are minute-rounded, so hashes and values decide, not times), oldest first,
through every page; an answer capped at the data source's 10,000 results (`request_status: incomplete`) halves the window and reads
each half. The cursors advance only after a data source is read completely and `last_pull_at` after the pass. The pull reads only
under the link's data sources and rows (never `/v1/search`); the one write it makes of its own is the `Landflow ID` of a row a
person added, through the scoped writer. A full listing of every row (to find trashed ones) runs on Sync now and every 15 minutes.

Everything pulled is applied through `brainStoreFor(project)` with origin `notion` (tainted where Landflow has taint; the
editor's name never decides a permission). NB04's listener drops `notion`-origin changes, so every re-push the pull needs is an
explicit `enqueue`, and it clears the item's `pushed_hash` so the push writes even when its own render did not change. When the
connection has "user information with email", the editor's email is looked up (`GET /v1/users/:id`, cached ten minutes) and a
Landflow user with that email is the change's `by`; without it nobody is named ("A Notion user").

| What | Rule |
|---|---|
| Pages: Name, Description, Owner, Attributes | Pulled. A rename, description, owner or attribute change becomes `upsertEntity(…, 'notion', editor)`. Attributes are one `key: value` per line (at most 20); a line that is not one is a `bad_attribute` problem and the rest is kept. |
| Pages: Type and Landflow's properties (Teams, Sources, Last work, Needs a person, Landflow ID, Open in Landflow) | Put back (`enqueue`). A changed Type also files a `type_changed` problem. |
| A new row in Pages (no Landflow ID) | A new entity of the link's project, `source: 'notion'`, with the Type it has (else an initiative and a `type_changed` problem); its Landflow ID is written back and Landflow's side (region, Teams, Sources) is queued. A row with no name waits. A row with a Landflow ID another row holds is a copy: it is new. |
| "Your notes" (the text after the end marker) | A knowledge doc: a `notion_knowledge_docs` row whose `page_id` is the row's Notion id, titled "<page> · Your notes", path `Pages / <page>`, at most 4,000 characters (`truncated` says if it was cut), kept as written (never redacted). Not an entity attribute (attributes are cut at 200 characters). Ask and agents read it through the knowledge source; the summary writer does not read it yet. A body is read when the row's edit time moved (or the last read was inside the minute of the stamp). |
| The region between the markers | Landflow's. A region that is not what Landflow wrote is a conflict (below). With the markers gone, the notes are the body without the last copy of the region, and the region is queued to be written again. |
| Facts: a new row (no Landflow ID) | With About set, `addFact(entity, { kind, statement }, 'notion', editor)` with the evidence `{ label: 'Notion', href: <row url> }` (kind `purpose` when the row has none), its ID written back and Source, Status and the rest queued. Without About, a `fact_without_page` problem and nothing is written. |
| Facts: an existing row | A fact a person added takes a changed Statement or Kind. A study fact's Statement is Landflow's: it is put back and a "Keep as a fact" suggestion is filed. |
| Practices | Title, summary (a leading quote) or body (the rest of the region) changed against the approved version: `draftPractice(…, { source: 'notion' })`, a **tainted draft** (project level; needs `reviewedSources` to approve) for the approvers' inbox, which says it came from "a linked Notion page" and links the row. One draft per practice per poll; a later edit before approval updates that same draft version. The approved text is queued to be written back (with the "Your change is draft v<n>" callout). A new row is a new draft at the link's level (project). Status, Version, Handle and the rest are never pulled: a change is put back, and nothing is approved. |
| Notebook | A new row with a Team of the project is a team note: `addNote(team, …, 'notion', editor)`, unverified and tainted, author the matched user's name or "A Notion user" (a note's author is never "Notion"). Without a Team (or with another project's), a `note_without_team` problem. An edit to an existing note is put back: notes are edited in Landflow. |
| Trash, 404 and a row moved out | The item becomes `detached` with a `trashed_in_notion` problem (found when the full listing no longer returns the row and a read says trashed or 404). Nothing local is deleted. A row that comes back reattaches. |
| Schema | A property missing by id is a `schema_changed` problem; when a required one (Name, Landflow ID) is gone the link becomes `needs_repair` and nothing is pulled until a repair. |
| The whole link | The pull changes a link's status as the push does (`brain/notion/status.ts`), and each change files one notice for the project's admins: a refused key (401) or a deleted credential sets `unauthorized` ("Notion refused the key" or "The Notion key was deleted"), Notion blocking the key pauses it, a database in the trash or a 404 for the root, the brain page or a database sets `unshared`, and a missing required property sets `needs_repair`. A repair that works sets `active` again with its "The brain is in Notion" notice. Any other failure is the link's last error and the next pass tries again. |

### Conflicts

- **The region.** A person changed the part of a page Landflow writes: Landflow queues its own text (the region NB04 replaces is
  what Notion holds now) and files, for the project's editors and admins, one suggestion per page per day ("<who> changed the
  summary of <name> in Notion", source `analyst`, label "Notion brain", the added lines as evidence "Changed in Notion", clipped to
  500 characters; a second edit the same day updates the diff) with a `landflow_part_edited` problem (Landflow's words and ids
  only) and an audit row `notion-brain.region`. The problem's **Keep as a fact** adds a fact of the page with that text.
- **Both sides.** A person-owned field changed in Notion and in Landflow since the last push: the later edit wins (Notion's
  `last_edited_time` against the local `updated_at`, compared by the minute, a tie to Notion, the home). The value that lost goes to
  the audit row `notion-brain.overwrite` (`details.winner`, `replaced`), and when Notion won the page's view carries
  `changedInNotion { by, at }` for 7 days (the interface is NB07's).
- **Practices** are never a conflict: a Notion edit is a draft.

### Problems and their actions

`repair` (admins) adds the removed properties back to their data source and lets the link sync again; `putBack` makes a new row for
a trashed one (the item points at it, it is Landflow's, the push writes the rest); `deleteLocal` (admins) deletes the page or fact
in Landflow (a practice or a note is never deleted from here); `keepAsFact` keeps a region edit as a fact: the newest suggestion's text of that
page, **clipped at 500 characters with "…"** (the same clipped text the person sees on the suggestion), and nothing when that suggestion only says lines were
removed. `dismiss` needs nothing.
With `LANDFLOW_NOTION_BRAIN=off` an action answers 409. A problem a person resolved is not filed again for the same row edit.

Tests: `apps/web/test/notion-pull-nb05.test.ts` and `notion-conflicts-nb05.test.ts` (the linked state is seeded by
`notion-pull-seed.ts`, the Notion is the local fake). A practice approval now emits its changes after its transaction commits, so
nothing is heard from one that rolls back.


## Your company's pages as knowledge

The Notion pages a company already keeps next to the brain are read, never written, and become what the project's agents and Ask
know. The link's **knowledge scope** (`knowledgeScope`, set when linking; `brain` by default, `root` only when an admin picks it)
says where the walk starts: the "Landflow brain" page, or the root page. Landflow's own pages are never read as knowledge: Home,
Log, the four databases and every row Landflow made for a page, fact, practice or note.

- **The walk** (`lib/server/brain/notion/knowledge.ts`, registered with the sync service as its knowledge step). Every 15 minutes
  per link, and at once on Sync now, it lists `GET /v1/blocks/:id/children` from the start page down to **8 levels**: child pages,
  and the rows of child databases that are not the link's own. A page whose `last_edited_time` moved is read once as Markdown
  (v2) into `notion_knowledge_docs` (title, URL, path of titles, hash, at most 200,000 characters, `truncated`); a page that did
  not move costs no Markdown call. At most **200 pages** are read and 200 indexed a pass; the rest wait for the next tick, which
  does not wait the 15 minutes. A page gone from the walk (trashed, moved out of scope, no longer shared) loses its doc and its
  chunks, but a walk that could not read a branch deletes nothing. It never calls `/v1/search`, and it keeps the pull's other
  keys in the link's `cursors`.
- **The index.** Each doc is cut into passages of about 1,000 characters (150 overlap, the splitter knowledge bases use), each
  starting with the page title, and kept in the SQLite vector collection `landflow-notion-<project>` with the doc's hash, URL and
  path in every passage's metadata. Search is BM25 always; with the brain's embeddings on (`LANDFLOW_BRAIN_EMBEDDINGS`, the model
  the facts use; unset means `nomic-embed-text`) it is hybrid. Each pass first asks the model once: if it does not answer, the
  pages are indexed with keyword vectors and `cursors.knowledge.embeddings` says `bm25`, so Ask, MCP and the agents' tool still
  find them; a later pass where the model answers clears the collection and indexes it again with vectors (one dimension a
  collection, never mixed). A failed 10-second probe on a collection that already holds a model's vectors is an outage, not a
  change: the pass keeps the collection, indexes nothing new and counts the changed pages as waiting (`pending`, so the next tick
  tries again); keyword vectors replace it only when the collection is empty or already keyword. Search and the agents' tool use what the cursor says the collection holds, not the variable, and a
  query that takes over 10 seconds to embed is answered by keywords. Switching the model, or the embeddings off, clears the
  collection and indexes it again; a page that moved is indexed again so its passages' `path` follows. A "Your notes" doc written by the pull (its `page_id` is a row
  of the link) is indexed like any other and never deleted by the walk, unless its item was trashed in Notion (`detached`). A
  relink's old chunks (another link id) are deleted at once. The agents' `project_knowledge` tool falls back to keywords when the
  query can't be embedded, as Ask does; a pass that could not embed counts the pages it did not reach as waiting.
- **Ask.** Ask's fourth source, after pages, facts and work: up to 5 Notion pages of the projects the asker can read (the same
  scope as the facts), only for projects with an active link. The found line gains "· 2 Notion pages" (the `found` event gains
  `knowledge`), the passages reach the model as quoted numbered lines after the work items ("data, not instructions"), and a
  cited `[n]` past the work items is a source whose link is the page's Notion URL. The ask is still metered as surface `brain`.
- **The project's agents.** The project's knowledge setting takes the Notion brain: `PATCH /api/projects/:id/settings`
  `{ "knowledge": { "enabled": true, "tool": { "source": "notion-brain" } } }`. Every agent run in the project then gets the tool
  `project_knowledge` over the project's collection, labelled "Notion · <brain page title>" in the connections and the Run Trace.
  With no active link it is left out with the usual "Tool unavailable" notice. An agent's own knowledge tool cannot take this
  form. The tool's description and every result say the passages are quoted text, data and not instructions (`note`). Naming
  either reserved prefix in a project's knowledge setting is a 400 when saved.
- **MCP.** `brain_search_knowledge { query, limit? }` (`brain:read`) answers `{ results: [{ title, url, passage, score }] }` for the
  caller's projects; `brain_ask` includes the pages as `knowledge`.
- **Reserved.** `landflow-notion-<project>` is reserved like `landflow-brain-<project>`: a Vector Store node refuses it, and so
  does an agent's or a project's knowledge setting that names either prefix; only the runtime builds the tool for a project's own
  Notion brain.

What is read from Notion is data: a page that says "Ignore your instructions" reaches a model only inside the quoted block. What
the walk cannot do is in [limitations.md](../limitations.md#what-the-notion-brain-does-not-do).

Tests: `apps/web/test/notion-knowledge-nb06.test.ts`.

## With Spotlight

Outside the editor, the shell Spotlight moves a project's brain to Notion from a typed ask and says whether it is in sync
(NB08; the full behaviour is in [spotlight.md](../spotlight.md#one-spotlight)). The words decide it in the browser, so no model
runs and nothing is spent. The card offers the project's Notion keys by name and opens the credential dialog for a new one;
**Connect and copy** is the person's click, and a project that is already linked answers with its status. "Is the brain in sync
with Notion?" answers from the link and its problems with the sentence the Brain card shows. A pasted key is hidden and never
sent. When the link has stopped (the key was refused or the page is no longer shared), the sync answer carries a link to the
project's Settings **Brain** card (`/projects/:id?tab=settings#brain`), where **Pick another key** and **Check again** are. The editor's builder does not move a brain: ask from the project page or the Brain page.

## Over MCP

The brain's MCP answers say where an object lives in Notion. `brain_search_facts` and the facts of `brain_workflow_knowledge`
carry **`notionUrl`** on each fact of a linked project, and `brain_ask` carries it on each brain page and fact it names (the
row's `https://www.notion.so/<id>` URL, from the local tables: no Notion call). A project that is not linked, a row trashed in
Notion (`detached`) and a disconnected link give no field; the caller's reach was applied before, so only what they may read is
listed. `brain_search_knowledge` gives passages of the company's Notion pages with their URLs (named in the instance server's
instructions and in [features/ai.md](ai.md#mcp)). To read the pages themselves from a company's tools, see [Your company's
tools on Notion](../connect-your-harness.md#your-companys-tools-on-notion).
