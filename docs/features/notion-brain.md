# Notion as the brain

Part of the [Landflow docs](../README.md). This page is built wave by wave; the sections below are added by the package that builds each part.

## How it is built

The brain's local SQL tables stay the working copy: runs, Ask, MCP and search read them synchronously, and nothing reads Notion. What changes is where a write is heard. Wave nb1's first package (NB01) adds a seam with three parts, and no screen changes.

- **One store per project.** `brainStoreFor(projectId)` (`apps/web/src/lib/server/brain/store/port.ts`; import `@/lib/server/brain/store`, not the port) answers a `BrainStore` (`lib/shared/brain-store.ts`). With no project, no resolver or a project the resolver calls `local`, it is the **local store** (`store/local.ts`): the existing functions (`upsertEntity`, `deleteEntity`, `addEntityFact`, `draftPractice`, `personAdd`), unchanged, with the origin passed through. A project whose resolver says `notion` (the Notion links register one, NB03) gets a store that reports `backend: 'notion'`; until a Notion store is registered (NB04) its writes are the local writes. A resolver that throws is logged and the project is local. The slot is a `singleton('brain-store')`.
- **A change feed every write goes through.** After a write is stored, the writer calls `emitBrainChange({ kind, key, projectId?, op, origin, by?, version?, at })`. `onBrainChange(listener)` hears it; listeners run in a microtask, one after the other, and one that throws is logged (kind and key, never text) without failing the write or stopping the next. A write that threw emits nothing, and nothing is emitted inside a transaction that may still throw. The writers, each marked `// NB01:`: `upsertEntity` and `deleteEntity` (`entity`; a delete also emits `fact` deletes and a `summary` delete), `upsertFact` (`fact`; `addEntityFact` calls it, so one change), `deleteFact` and `staleFactsBefore` (one per fact), `writeSummary` (`summary`), `draftPractice`, `markApproved`, `markRejected` and `markRetired` (`practice`, with the `version`), and the notebook **store**'s `insert`, `patch`, `delete`, `expire` and `deleteTeam` (`note`), which catches every notebook writer.
- **Who made it.** `changeOrigin(explicit?)` (`store/origin.ts`): an explicit `notion` (the puller, NB05) wins; else `person`, with the user's id, for a signed-in session (`via: 'session'` or `'test'`); else `landflow` (an API key, MCP, a flow, the study, the loop). It never trusts a name a caller sends.

### What comes from Notion is untrusted

- A practice drafted with `source: 'notion'` is **tainted** (like `learned` and `agent`) and may be drafted **at project level only**; an org practice is refused with 403, and approving it needs `reviewedSources: true` (409 `PracticeNeedsReview`). No route accepts `notion` from a caller: `routeOrigin` never returns it.
- A note added with origin `notion` is `unverified` and `tainted`, with `source: { tool: 'notion', url }`; it cannot be promoted until a person verifies it.
- A fact pulled from Notion carries an evidence item labelled `Notion` (`NOTION_EVIDENCE_LABEL`) whose `href` is the page's URL; a fact has no `source` field.

Tests: `apps/web/test/brain-store-nb01.test.ts`.
