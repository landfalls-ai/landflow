/**
 * The Notion brain (docs/features/notion-brain.md): what a project's link to a Notion page looks like, the layout Landflow
 * builds under that page (one "Landflow brain" page, a Log page, four databases), the property names and who owns each,
 * the markers around the part of a page Landflow writes, and the words the UI shows. Shared by the server (links, routes,
 * push, pull, knowledge) and the browser (the project's Brain card, Spotlight's card): no runtime import from lib/server and
 * no zod.
 *
 * Written by the plan for the Notion brain program, wave nb1: NB03 owns it (backbone/contracts/nb/notion-brain.ts); NB04–NB08
 * copy it byte for byte. Change it in the contract first, then every copy.
 */
import { ENTITY_TYPES, FACT_KINDS } from './brain';
import { NOTE_KINDS, NOTE_STATUSES } from './notebook';
import { PRACTICE_LEVELS, PRACTICE_STATUSES, PRACTICE_STRENGTHS } from './practices';

// ---------------------------------------------------------------------------------------------------- the link

/**
 * `setting_up`: made, the copy not started; `copying`: the initial copy is running; `active`: in sync; `paused`: by an admin
 * or by Notion blocking the key (`public_api_request_blocked`); `unauthorized`: Notion refused the key (401); `unshared`:
 * the page or the brain page is gone or no longer shared (404); `needs_repair`: a required property was removed;
 * `unlinked`: disconnected (kept for history; Notion keeps what is there).
 */
export const LINK_STATUSES = ['setting_up', 'copying', 'active', 'paused', 'unauthorized', 'unshared', 'needs_repair', 'unlinked'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

/** Statuses in which nothing is pushed or pulled (the outbox keeps filling). */
export const STOPPED_STATUSES: readonly LinkStatus[] = ['paused', 'unauthorized', 'unshared', 'needs_repair', 'unlinked'];

/** Which company pages are read as knowledge: those under "Landflow brain" (the person's choice, D4) or every page under the root. */
export const KNOWLEDGE_SCOPES = ['brain', 'root'] as const;
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];

/** Requests a second per Notion key: 2 by default (about 3 is Notion's average), 8 for Business and Enterprise plans. */
export const RPS_DEFAULT = 2;
export const RPS_MAX = 8;

export interface CopyProgress {
  phase: 'pages' | 'databases' | 'rows' | 'bodies' | 'facts' | 'practices' | 'notes' | 'home' | 'done';
  done: number;
  total: number;
}

export interface BrainCounts {
  pages: number;
  facts: number;
  practices: number;
  notes: number;
}

/** GET /api/projects/:id/brain/notion for a linked project. Never a secret: the key by credential id and name only. */
export interface LinkView {
  linked: true;
  id: string;
  projectId: string;
  status: LinkStatus;
  /** Why it stopped, in words (`paused` by Notion, the last error), when there is one. */
  reason?: string;
  credential: { id: string; name: string };
  /** Notion ids and URLs: only for the project's members (the route checks). */
  rootPageId: string;
  rootUrl?: string;
  rootTitle?: string;
  brainPageId?: string;
  brainUrl?: string;
  workspaceName?: string;
  botName?: string;
  knowledgeScope: KnowledgeScope;
  rps: number;
  copy?: CopyProgress;
  lastPushAt?: string;
  lastPullAt?: string;
  /** Outbox rows waiting. */
  waiting: number;
  /** Open problems. */
  problems: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  /** The viewer may change, sync, pause or disconnect it (the project's admins, instance owners and admins). */
  canManage: boolean;
}

export type LinkStatusView = LinkView | { linked: false; canManage: boolean };

/** POST /api/projects/:id/brain/notion/check: what the page is and what a copy would do. Writes nothing. */
export interface CheckResult {
  title: string;
  url: string;
  workspaceName?: string;
  botName?: string;
  /** A "Landflow brain" page with a `Landflow ID` database already under the page: it is reused, never duplicated. */
  existingBrain: { found: boolean; pageId?: string };
  counts: BrainCounts;
  estimateMinutes: number;
}

/** POST /api/projects/:id/brain/notion (the route validates with zod on the server). */
export interface LinkCreateInput {
  credentialId: string;
  /** A Notion link, a 32-hex id or a dashed UUID. */
  page: string;
  knowledgeScope?: KnowledgeScope;
  rps?: number;
}

/** PATCH /api/projects/:id/brain/notion */
export interface LinkPatchInput {
  /** `true` pauses. `false` resumes a paused link, and tries a refused (`unauthorized`) or `unshared` one again: the page is checked with the key first (wave nb3). */
  paused?: boolean;
  rps?: number;
  knowledgeScope?: KnowledgeScope;
  /** Wave nb3: another Notion key for the same page (an admin's; checked like a new link before it is kept). */
  credentialId?: string;
}

/** Requests a copy makes: the brain page, Log, four databases and their four reads, then a row and a body per page, one per fact, practice and note, and Home. */
export function copyRequests(counts: BrainCounts): number {
  return 10 + counts.pages * 2 + counts.facts + counts.practices + counts.notes + 1;
}

/** Minutes the initial copy takes at `rps` (rounded up; at least 1). 300 pages, 900 facts, 10 practices, 40 notes at 2/s: 1,561 requests, 14. */
export function estimateMinutes(counts: BrainCounts, rps: number = RPS_DEFAULT): number {
  const rate = Math.min(RPS_MAX, Math.max(1, rps || RPS_DEFAULT));
  return Math.max(1, Math.ceil(copyRequests(counts) / rate / 60));
}

// ---------------------------------------------------------------------------------------------------- the layout

/** The one child Landflow adds to the person's page; nothing is written on that page itself. */
export const brainPageTitle = (projectName: string) => `Landflow brain · ${projectName}`;
export const LOG_PAGE_TITLE = 'Log';

export const DATABASE_KINDS = ['pages', 'facts', 'practices', 'notebook'] as const;
export type DatabaseKind = (typeof DATABASE_KINDS)[number];

/**
 * Who owns a property: `landflow` (pushed; a person's edit is put back), `person` (pulled; Landflow writes it only when the
 * row is created or the value changed in Landflow), `create` (a person sets it on a row they add; afterwards Landflow's).
 */
export type PropertyOwner = 'landflow' | 'person' | 'create';
export type PropertyType = 'title' | 'rich_text' | 'select' | 'multi_select' | 'number' | 'checkbox' | 'date' | 'url' | 'relation';

export interface PropertySpec {
  name: string;
  type: PropertyType;
  owner: PropertyOwner;
  /** Select and multi-select options made at create (multi-selects also grow as values appear). */
  options?: readonly string[];
  /** A relation's target database. */
  relation?: DatabaseKind;
  /** Name and Landflow ID: a link whose data source lost one needs a repair before it syncs. */
  required?: boolean;
}

/** The join key on every row: `<type>/<id>` for a page, the fact id, the practice id, the note id. Never changed. */
export const LANDFLOW_ID = 'Landflow ID';

export const DATABASES: Readonly<Record<DatabaseKind, { title: string; properties: readonly PropertySpec[] }>> = {
  pages: {
    title: 'Pages',
    properties: [
      { name: 'Name', type: 'title', owner: 'person', required: true },
      { name: 'Type', type: 'select', owner: 'create', options: ENTITY_TYPES },
      { name: 'Description', type: 'rich_text', owner: 'person' },
      { name: 'Owner', type: 'rich_text', owner: 'person' },
      { name: 'Attributes', type: 'rich_text', owner: 'person' },
      { name: 'Teams', type: 'multi_select', owner: 'landflow' },
      { name: 'Sources', type: 'multi_select', owner: 'landflow' },
      { name: 'Last work', type: 'date', owner: 'landflow' },
      { name: 'Needs a person', type: 'checkbox', owner: 'landflow' },
      { name: LANDFLOW_ID, type: 'rich_text', owner: 'landflow', required: true },
      { name: 'Open in Landflow', type: 'url', owner: 'landflow' },
    ],
  },
  facts: {
    title: 'Facts',
    properties: [
      // Landflow's for the study's facts, the person's for the facts people add (FACT_SOURCES).
      { name: 'Statement', type: 'title', owner: 'create', required: true },
      { name: 'Kind', type: 'select', owner: 'create', options: FACT_KINDS },
      { name: 'About', type: 'relation', owner: 'create', relation: 'pages' },
      { name: 'Subject', type: 'rich_text', owner: 'landflow' },
      { name: 'Status', type: 'select', owner: 'landflow', options: ['active', 'stale'] },
      { name: 'Confidence', type: 'number', owner: 'landflow' },
      { name: 'Source', type: 'select', owner: 'landflow', options: ['Landflow', 'Person', 'Notion'] },
      { name: 'Last seen', type: 'date', owner: 'landflow' },
      { name: LANDFLOW_ID, type: 'rich_text', owner: 'landflow', required: true },
    ],
  },
  practices: {
    title: 'Practices',
    properties: [
      // A person's edit of the title or body is a new tainted draft, never a change of the approved text.
      { name: 'Title', type: 'title', owner: 'landflow', required: true },
      { name: 'Handle', type: 'rich_text', owner: 'landflow' },
      { name: 'Level', type: 'select', owner: 'landflow', options: PRACTICE_LEVELS },
      { name: 'Strength', type: 'select', owner: 'landflow', options: PRACTICE_STRENGTHS },
      // Never pulled: a practice is approved only in Landflow (decisions D3).
      { name: 'Status', type: 'select', owner: 'landflow', options: PRACTICE_STATUSES },
      { name: 'Version', type: 'number', owner: 'landflow' },
      { name: 'Topics', type: 'multi_select', owner: 'landflow' },
      { name: 'Repos', type: 'rich_text', owner: 'landflow' },
      { name: 'Paths', type: 'rich_text', owner: 'landflow' },
      { name: LANDFLOW_ID, type: 'rich_text', owner: 'landflow', required: true },
    ],
  },
  notebook: {
    title: 'Notebook',
    properties: [
      { name: 'Text', type: 'title', owner: 'create', required: true },
      { name: 'Kind', type: 'select', owner: 'create', options: NOTE_KINDS },
      { name: 'Team', type: 'rich_text', owner: 'create' },
      // Verify, dispute and resolve stay in Landflow.
      { name: 'Status', type: 'select', owner: 'landflow', options: NOTE_STATUSES },
      { name: 'Tainted', type: 'checkbox', owner: 'landflow' },
      { name: 'From', type: 'rich_text', owner: 'landflow' },
      { name: LANDFLOW_ID, type: 'rich_text', owner: 'landflow', required: true },
    ],
  },
};

/** The Facts database's Source values. */
export const FACT_SOURCES = { landflow: 'Landflow', person: 'Person', notion: 'Notion' } as const;

/**
 * The part of a page body Landflow writes sits between these markers; "Your notes" below the end marker is the person's and
 * is never written after the page is created. If Notion's Markdown v2 drops HTML comments, the literal paragraphs of
 * `REGION_FALLBACK` are used instead (the live check settles it; the pull reads both forms).
 */
export const REGION_START = '<!-- landflow:start · written by Landflow; edits here are put back (your notes go below) -->';
export const REGION_END = '<!-- landflow:end -->';
export const REGION_FALLBACK = { start: '⟦Landflow · start⟧', end: '⟦Landflow · end⟧' } as const;
export const NOTES_HEADING = '## Your notes';
/** Home (the brain page's body) and Log are wholly Landflow's: an edit there is put back without a suggestion. */
export const HOW_THIS_WORKS =
  'Landflow writes this page and the parts of each page between its markers. Edit names, descriptions, owners, attributes and "Your notes", and add pages, facts and notes: Landflow reads them back within a few minutes. Practices change only by approval in Landflow.';

// ---------------------------------------------------------------------------------------------------- problems

/**
 * A sync problem a person resolves: `landflow_part_edited` (a person changed a part Landflow writes; it was put back),
 * `type_changed`, `bad_attribute` (an Attributes line that isn't `key: value`), `fact_without_page` (a fact row with no
 * About), `note_without_team`, `trashed_in_notion`, `schema_changed` (a property was removed or renamed), `too_large`
 * (Notion refused a text even after it was cut).
 */
export const PROBLEM_KINDS = ['landflow_part_edited', 'type_changed', 'bad_attribute', 'fact_without_page', 'note_without_team', 'trashed_in_notion', 'schema_changed', 'too_large'] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

/** `deleteLocal` and `repair` need a project admin; the others an editor. */
export const PROBLEM_ACTIONS = ['dismiss', 'repair', 'putBack', 'deleteLocal', 'keepAsFact'] as const;
export type ProblemAction = (typeof PROBLEM_ACTIONS)[number];
export const ADMIN_PROBLEM_ACTIONS: readonly ProblemAction[] = ['repair', 'deleteLocal'];

/** Which actions each kind offers (besides `dismiss`, which every kind has). */
export const PROBLEM_KIND_ACTIONS: Readonly<Record<ProblemKind, readonly ProblemAction[]>> = {
  landflow_part_edited: ['keepAsFact'],
  type_changed: [],
  bad_attribute: [],
  fact_without_page: [],
  note_without_team: [],
  trashed_in_notion: ['putBack', 'deleteLocal'],
  schema_changed: ['repair'],
  too_large: [],
};

/** GET /api/projects/:id/brain/notion/problems. `detail` is Landflow's words and ids, never page text. */
export interface LinkProblemView {
  id: string;
  kind: ProblemKind;
  notionId?: string;
  notionUrl?: string;
  localKey?: string;
  detail: string;
  at: string;
  actions: ProblemAction[];
}

// ---------------------------------------------------------------------------------------------------- words

/** What never leaves Landflow, in one line (the Brain card, Spotlight's card, the feature page). */
export const NEVER_PUSHED =
  'Never copied to Notion: private and team-only work, nightly briefings, usage and AI spend, run data, other projects, secrets.';

/** The vector collection a linked project's Notion knowledge is indexed into (reserved like `landflow-brain-*`). */
export const NOTION_KNOWLEDGE_PREFIX = 'landflow-notion';
export const notionKnowledgeCollection = (projectId: string) => `${NOTION_KNOWLEDGE_PREFIX}-${projectId}`;

export const LINK_STATUS_LABELS: Readonly<Record<LinkStatus, string>> = {
  setting_up: 'Setting up',
  copying: 'Copying to Notion',
  active: 'In sync',
  paused: 'Paused',
  unauthorized: 'Notion refused the key',
  unshared: 'The page is no longer shared',
  needs_repair: 'Needs a repair',
  unlinked: 'Disconnected',
};
