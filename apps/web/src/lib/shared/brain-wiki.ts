/**
 * The Brain page (/brain, docs/second-brain.md#the-brain-page): the second brain read as a wiki. A page per entity
 * (initiative, person, customer, system) with a summary the model writes, the work that names it, the people on it and
 * the pages it shares work with; a home with what is shared across teams, the open suggestions and the latest work; and
 * Ask, which answers from all of it with the pages it used. Shapes shared by the routes and the pages. No runtime imports
 * besides the brain's own constants.
 */
import type { BrainEntity, BrainFact, BrainStatus, EntityKnowledge, EntityType, Proposal } from './brain';

/** One work event (a `work.*` kind the activity integrations record), as the wiki shows it. */
export interface WorkItem {
  id: string;
  at: string;
  kind: string;
  source?: string;
  title?: string;
  summary?: string;
  url?: string;
  /** Who did it: an email. */
  actor?: string;
  /** The team: the event's own, else the department of the person who did it. */
  team?: string;
  customer?: string;
  initiative?: string;
  /** The pages it names (`<type>/<id>`). */
  refs: string[];
}

/** One page in the directory, with how much work named it lately. */
export interface WikiEntry {
  type: EntityType;
  id: string;
  name: string;
  description?: string;
  owner?: string;
  /** A person's department (their `department` attribute): the folder the workbench files them under. */
  department?: string;
  /** Work naming it in the last 7 and 30 days. */
  week: number;
  month: number;
  lastAt?: string;
  teams: string[];
}

/** A customer or initiative more than one team worked on in the window: the overlap the brain is for. */
export interface SharedWork {
  ref: string;
  type: EntityType;
  id: string;
  name: string;
  teams: Array<{ team: string; events: number; people: string[] }>;
  events: number;
  lastAt: string;
  /** The latest few items, newest first. */
  latest: WorkItem[];
}

export interface TeamActivity {
  team: string;
  events: number;
  people: number;
  /** The pages it worked on most, with counts. */
  top: Array<{ ref: string; name: string; events: number }>;
}

/** GET /api/brain/wiki. */
export interface WikiHome {
  status: BrainStatus;
  /** Days the shared-work and team views cover. */
  days: number;
  entries: WikiEntry[];
  shared: SharedWork[];
  teams: TeamActivity[];
  kinds: Array<{ kind: string; events: number }>;
  recent: WorkItem[];
  proposals: Proposal[];
  /** Pages that need a person: no owner, no work in 30 days, or a summary older than their work. */
  health: WikiHealth;
  /** Whether a model writes summaries and answers (LANDFLOW_BRAIN_MODEL not off). */
  model?: string;
}

/** The wiki's lint pass: what to fix, as page lists. */
export interface WikiHealth {
  noOwner: Array<{ ref: string; name: string }>;
  quiet: Array<{ ref: string; name: string }>;
  staleSummaries: Array<{ ref: string; name: string }>;
}

/** A summary the model wrote for a page. `stale` when the page's facts or work changed after it was written. */
export interface WikiSummary {
  text: string;
  model: string;
  generatedAt: string;
  stale: boolean;
  /** The pages the text links to (`[[type/id]]`) that the reader can open, with their names. */
  links: WikiLink[];
}

export interface WikiLink {
  ref: string;
  name: string;
}

export interface WikiPerson {
  /** The person's page, when there is one. */
  ref?: string;
  name: string;
  email?: string;
  team?: string;
  events: number;
}

export interface WikiRelated {
  ref: string;
  type: EntityType;
  id: string;
  name: string;
  /** Work items both pages are named in. */
  shared: number;
}

/** GET /api/brain/wiki/:type/:id. */
export interface WikiPage extends EntityKnowledge {
  summary?: WikiSummary;
  work: WorkItem[];
  people: WikiPerson[];
  related: WikiRelated[];
  teams: Array<{ team: string; events: number }>;
  /** Other pages whose description, facts or summary name this one. */
  mentionedIn: Array<{ ref: string; name: string }>;
  model?: string;
  /** Whether the caller can change it (edit, add a fact). */
  canEdit: boolean;
}

/** POST /api/brain/ask. */
export interface WikiAnswer {
  question: string;
  /** The model's answer with `[[type/id]]` links and `[n]` work references; absent without a model. */
  answer?: string;
  model?: string;
  pages: Array<Pick<BrainEntity, 'type' | 'id' | 'name'>>;
  facts: BrainFact[];
  work: WorkItem[];
  /** Why there is no answer when there is a model (it failed). */
  note?: string;
  /** The page it was asked from, when the question was about one. */
  about?: string;
  /** The pages the answer links to, with their names. */
  links?: WikiLink[];
  /** The numbers of the work items the answer cites, in order. Empty or absent: no source is numbered. */
  cited?: number[];
}

/** An earlier turn of the conversation, sent with a follow-up question. At most 2, each part 1,500 characters. */
export interface AskTurn {
  question: string;
  answer: string;
}
export const ASK_HISTORY_TURNS = 2;
export const ASK_HISTORY_CHARS = 1_500;

/** Why a streamed ask ended in an error. */
export type AskErrorKind = 'invalid' | 'model' | 'cap' | 'internal';

/** The events of the streamed form of POST /api/brain/ask (`Accept: text/event-stream`), in the order they come. */
export type AskEvent =
  /** What it found, before any word: the page refs (`type/id`) with names, and how many facts and work items. */
  | { type: 'found'; pages: Array<{ id: string; name: string }>; facts: number; work: number }
  | { type: 'step.start'; step: number; label: string }
  | { type: 'tool'; name: 'read_pages' | 'search_facts' | 'read_work'; label: string; ok: boolean; id: string; step: number; durationMs: number; detail?: string }
  /** Words as they come: provisional, replaced by the checked `text`. */
  | { type: 'text.delta'; step: number; text: string }
  | { type: 'text'; text: string }
  | {
      type: 'done';
      links: WikiLink[];
      /** The work items the answer was written from, in the order `[n]` counts them. */
      sources: WorkItem[];
      cited: number[];
      model?: string;
      local: boolean;
      durationMs: number;
      steps: number;
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
      note?: string;
    }
  | { type: 'error'; kind: AskErrorKind; message: string };

/**
 * An answer while it is still being written, as plain words: `[[type/id|Name]]` shows as Name, a link not closed yet is
 * left out, so no half a link flashes on screen. The checked text replaces it at the end.
 */
export function streamingPreview(text: string): string {
  return text
    .replace(/\[\[[a-z]+\/[a-z0-9_.-]+\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[[a-z]+\/([a-z0-9_.-]+)\]\]/g, '$1')
    .replace(/\[\[[^\]]*$/, '')
    .replace(/\[\d{0,3}$/, '');
}

/** `[[type/id]]` links in a text, in order, without repeats. */
export function wikiLinks(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\[\[([a-z]+\/[a-z0-9][a-z0-9_.-]{0,63})(?:\|[^\]]*)?\]\]/g)) if (!out.includes(match[1])) out.push(match[1]);
  return out;
}

/**
 * The id a work template gives the entity a hint names (templates/builtin.ts `entityIdOf`): lowercase, every run of other
 * characters one "-", no "-" at the ends, 64 at most. So "Acme" and "#customer-acme" meet as `acme`.
 */
export const hintId = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
