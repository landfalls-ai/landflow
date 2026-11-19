/**
 * The brain's storage seam (docs/features/notion-brain.md#how-it-is-built): one `BrainStore` per project. The local SQL
 * tables stay the working copy that runs, Ask, MCP and search read synchronously; a project linked to Notion gets a store
 * whose writes are the local writes plus a change the sync hears (`BrainChange`). Reads never touch Notion.
 *
 * Types only: no value, no zod (the browser may load lib/shared). The server-side half (`brainStoreFor`, the change feed)
 * is lib/server/brain/store/port.ts. Written by the plan for the Notion brain program, wave nb1: NB01 owns it
 * (backbone/contracts/nb/brain-store.ts); NB03 adds this file byte for byte, and NB04–NB06 copy it. Change it in the
 * contract first, then every copy.
 */
import type { addEntityFact, EntityFilter, EntityInput, LinkedEntity } from '../server/brain/entities';
import type { listFacts, searchFacts } from '../server/brain/facts';
import type { PracticeDraftOrigin } from '../server/practices/port';
import type { BrainEntity, BrainFact } from './brain';
import type { NoteKind, TeamNote } from './notebook';
import type { Practice, PracticeDraftInput, PracticeVersion } from './practices';

/** Where a project's brain lives: only in Landflow, or in Notion with Landflow's working copy. */
export type BrainBackend = 'local' | 'notion';

/** What changed. A summary is an entity page's written summary (`brain_pages`). */
export type BrainObjectKind = 'entity' | 'fact' | 'summary' | 'practice' | 'note';

/**
 * Who made the change: `person` a signed-in session (`currentPrincipal().via` is `session` or `test`), `notion` the
 * puller writing a Notion edit back (NB05; such text is tainted where Landflow has taint), `landflow` everything else (the
 * study, the loop, a flow, an API key, MCP).
 */
export type BrainChangeOrigin = 'landflow' | 'person' | 'notion';

/**
 * One write to the brain, emitted after it is stored (never for a write that threw). `key` per kind:
 * - `entity` and `summary`: the entity's ref `<type>/<id>` (`entityRef`);
 * - `fact`: the fact id;
 * - `practice`: the practice id (`version` says which version changed; one Notion row per practice);
 * - `note`: the note id.
 */
export interface BrainChange {
  kind: BrainObjectKind;
  key: string;
  /** The project it lives in; none: org-wide (org practices, facts that span projects), which a project link never pushes. */
  projectId?: string;
  op: 'upsert' | 'delete';
  origin: BrainChangeOrigin;
  /** A user id when a person made it (or the Notion editor matched by email, NB05). */
  by?: string;
  /** A practice change: the version written, approved, rejected or retired. */
  version?: number;
  /** ISO time of the write. */
  at: string;
}

export type BrainChangeListener = (change: BrainChange) => void;

/** `listFacts`'s filter, named for the seam. */
export type FactFilter = NonNullable<Parameters<typeof listFacts>[0]>;
/** `searchFacts`'s options, named for the seam. */
export type FactSearchOptions = NonNullable<Parameters<typeof searchFacts>[1]>;
/** What a person (or a flow, or a Notion row) says about an entity: `addEntityFact`'s input. */
export type PersonFactInput = Parameters<typeof addEntityFact>[1];
/** A note a person adds to a team's notebook (`personAdd`'s input). */
export interface PersonNoteInput {
  kind?: NoteKind;
  text: string;
  /** Where it came from (a Notion page's URL for a row pulled from Notion). */
  url?: string;
}

/**
 * The store a project's brain is read and written through. Reads are synchronous and always the local tables. Writes are
 * the local writes (the same functions as today, the same errors), then one `BrainChange` each. `origin` defaults to what
 * the request says (`person` for a session, else `landflow`); only the puller passes `notion`.
 */
export interface BrainStore {
  readonly backend: BrainBackend;

  entity(type: string, id: string): LinkedEntity | undefined;
  entities(filter: EntityFilter): BrainEntity[];
  facts(filter: FactFilter): BrainFact[];
  searchFacts(query: string, options: FactSearchOptions): BrainFact[];

  upsertEntity(input: EntityInput, origin?: BrainChangeOrigin, by?: string): { entity: BrainEntity; created: boolean };
  deleteEntity(type: string, id: string, origin?: BrainChangeOrigin, by?: string): boolean;
  addFact(entity: BrainEntity, input: PersonFactInput, origin?: BrainChangeOrigin, by?: string): BrainFact;
  /** `origin.source: 'notion'` drafts a tainted version (PracticeSource gains `notion`, NB01). */
  draftPractice(input: PracticeDraftInput, origin: PracticeDraftOrigin): { practice: Practice; version: PracticeVersion };
  /** Async: a note is embedded after it is stored (notebook/service.ts). From Notion it is unverified and tainted. */
  addNote(teamId: string, input: PersonNoteInput, origin?: BrainChangeOrigin, by?: string): Promise<TeamNote>;
}

/**
 * What a project's backend resolver answers (NB03 registers one; NB04 supplies `store`). Undefined or `local`: the local
 * store. `notion` without a store: the local store reporting `backend: 'notion'` (nb1, before NB04 exists).
 */
export type BrainBackendResolution = { backend: 'local' } | { backend: 'notion'; store?: BrainStore };
export type BrainBackendResolver = (projectId: string) => BrainBackendResolution | undefined;
