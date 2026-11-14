/**
 * Tagging with @ (docs/assistant.md#tagging-with-): the kinds of thing a person can tag, the shapes the search route
 * and the resolver share, and the pure parts of the picker (finding the `@query` at the caret, ranking, grouping,
 * chips, recents). The server side is lib/server/mentions; the UI is components/ui/mention-picker.tsx.
 */

/** The kinds, in the order the picker lists them. */
export const MENTION_TYPES = ['workflow', 'node', 'run', 'agent', 'team', 'dataTable', 'template', 'nodeType', 'plugin', 'brainPage', 'person', 'credential'] as const;
export type MentionType = (typeof MENTION_TYPES)[number];

/** A tag: what it points at. A node and a run also name their workflow. */
export interface MentionRef {
  type: MentionType;
  id: string;
  workflowId?: string;
}

/** A search hit: a tag with the name to show and a short second line. */
export type MentionHit = MentionRef & { name: string; hint?: string };

export const MENTION_LIMITS = { perGroup: 8, refs: 8, perRefBytes: 1536, totalBytes: 6144 } as const;

/** The longest `q` the route takes. */
export const MENTION_QUERY_MAX = 80;

export const MENTION_LABELS: Record<MentionType, string> = {
  workflow: 'Workflows',
  node: 'Nodes',
  run: 'Runs',
  agent: 'Agents',
  team: 'Teams',
  dataTable: 'Data tables',
  template: 'Templates',
  nodeType: 'Node types',
  plugin: 'Plugins',
  brainPage: 'Brain pages',
  person: 'People',
  credential: 'Credentials',
};

/** One type as a person says it: "data table", "node type". */
export const MENTION_NOUNS: Record<MentionType, string> = {
  workflow: 'workflow',
  node: 'node',
  run: 'run',
  agent: 'agent',
  team: 'team',
  dataTable: 'data table',
  template: 'template',
  nodeType: 'node type',
  plugin: 'plugin',
  brainPage: 'brain page',
  person: 'person',
  credential: 'credential',
};

/** What a person is called in the picker and in their digest: their name, or the part of their email before the @. */
export const personName = (user: { name?: string; email: string }): string => user.name?.trim() || user.email.split('@')[0]!;

export const isMentionType = (value: unknown): value is MentionType => typeof value === 'string' && (MENTION_TYPES as readonly string[]).includes(value);

export interface MentionGroup {
  type: MentionType;
  items: MentionHit[];
}

/** `GET /api/mentions`. */
export interface MentionsResponse {
  groups: MentionGroup[];
}

/** The key of a tag: two chips with the same key are one tag. */
export const mentionKey = (ref: Pick<MentionRef, 'type' | 'id' | 'workflowId'>) => `${ref.type}:${ref.workflowId ?? ''}:${ref.id}`;

/** Only what the resolver needs from a chip. */
export const refOf = (hit: MentionHit): MentionRef => ({ type: hit.type, id: hit.id, ...(hit.workflowId && { workflowId: hit.workflowId }) });

// ---- ranking ----------------------------------------------------------------------------------------------------

/** How well `name` matches `query`: 4 exact, 3 prefix, 2 a word starts with it, 1 it is inside, 0 no. An empty query matches all (1). */
export function matchRank(name: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const n = name.toLowerCase();
  if (n === q) return 4;
  if (n.startsWith(q)) return 3;
  if (n.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(q))) return 2;
  return n.includes(q) ? 1 : 0;
}

/** At most `limit` of `items` matching `query`: a prefix match first, then the newest (`at`, an ISO time), then by name. */
export function rankHits<T extends { name: string; at?: string }>(items: T[], query: string, limit: number = MENTION_LIMITS.perGroup): T[] {
  return items
    .map((item) => ({ item, score: matchRank(item.name, query) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || (b.item.at ?? '').localeCompare(a.item.at ?? '') || a.item.name.localeCompare(b.item.name))
    .slice(0, limit)
    .map((m) => m.item);
}

// ---- the picker's pure parts --------------------------------------------------------------------------------------

/** Words a tag's query may hold: names have spaces, so the box stays open for a few of them. */
const QUERY_WORDS = 3;
const QUERY_CHARS = 40;

/**
 * The `@query` being typed at `caret`: an `@` at the start of the box or after whitespace, then up to a few words with
 * no line break. Undefined when the caret is not in one (an email address's `@` does not count).
 */
export function mentionQueryAt(value: string, caret: number): { start: number; query: string } | undefined {
  const start = value.lastIndexOf('@', Math.max(0, caret - 1));
  if (start < 0 || start >= caret) return undefined;
  if (start > 0 && !/\s/.test(value[start - 1])) return undefined;
  const query = value.slice(start + 1, caret);
  if (query.length > QUERY_CHARS || /\n/.test(query) || query.split(/\s+/).filter(Boolean).length > QUERY_WORDS || /\s\s/.test(query)) return undefined;
  return { start, query };
}

/** The box after choosing a hit: the `@query` text is gone (the chip says it), the caret where it was. */
export function removeMentionText(value: string, start: number, caret: number): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(caret);
  // Don't leave two spaces where the tag was.
  const glue = before.endsWith(' ') && after.startsWith(' ') ? after.slice(1) : after;
  return { value: `${before}${glue}`, caret: start };
}

/** Add a chip: the same tag twice is one; at most `MENTION_LIMITS.refs`. */
export function addChip(chips: readonly MentionHit[], hit: MentionHit): MentionHit[] {
  if (chips.some((c) => mentionKey(c) === mentionKey(hit))) return [...chips];
  if (chips.length >= MENTION_LIMITS.refs) return [...chips];
  return [...chips, hit];
}

export const removeChip = (chips: readonly MentionHit[], ref: Pick<MentionRef, 'type' | 'id' | 'workflowId'>): MentionHit[] => chips.filter((c) => mentionKey(c) !== mentionKey(ref));

/** The last tags chosen, newest first, each once, at most `MENTION_LIMITS.refs`. */
export function pushRecent(recents: readonly MentionHit[], hit: MentionHit): MentionHit[] {
  return [hit, ...recents.filter((r) => mentionKey(r) !== mentionKey(hit))].slice(0, MENTION_LIMITS.refs);
}

export interface PickerSection {
  key: string;
  label: string;
  items: MentionHit[];
}

/**
 * What the listbox shows, in order: "On this page" (the hits the host already has), the recents, then the server's
 * groups in `MENTION_TYPES` order. A tag already chosen is left out, and one that appears twice shows once, in the
 * first section that has it.
 */
export function pickerSections(input: { local?: readonly MentionHit[]; recents?: readonly MentionHit[]; groups?: readonly MentionGroup[]; query: string; chosen?: readonly MentionHit[] }): PickerSection[] {
  const seen = new Set((input.chosen ?? []).map(mentionKey));
  const fresh = (items: readonly MentionHit[]) => items.filter((h) => !seen.has(mentionKey(h))).filter((h) => (seen.add(mentionKey(h)), true));
  const sections: PickerSection[] = [];
  const local = fresh(rankHits((input.local ?? []).map((h) => ({ ...h })), input.query));
  if (local.length) sections.push({ key: 'local', label: 'On this page', items: local });
  const recents = fresh((input.recents ?? []).filter((h) => matchRank(h.name, input.query) > 0));
  if (recents.length) sections.push({ key: 'recent', label: 'Recent', items: recents });
  const byType = new Map((input.groups ?? []).map((g) => [g.type, g.items]));
  for (const type of MENTION_TYPES) {
    const items = fresh(byType.get(type) ?? []);
    if (items.length) sections.push({ key: type, label: MENTION_LABELS[type], items });
  }
  return sections;
}

/** The sections' hits as one list, which is what the arrow keys walk. */
export const flatHits = (sections: readonly PickerSection[]): MentionHit[] => sections.flatMap((s) => s.items);

/** The id of the option at `index` (the textarea's `aria-activedescendant` names it). */
export const optionId = (listId: string, index: number) => `${listId}-opt-${index}`;

/** Move the active option by `delta`, wrapping. */
export const stepActive = (active: number, delta: number, count: number) => (count ? (active + delta + count) % count : 0);

/** Which recents to read back from storage: anything malformed is dropped. */
export function parseRecents(raw: string | null): MentionHit[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter((h): h is MentionHit => Boolean(h) && typeof h === 'object' && isMentionType((h as MentionHit).type) && typeof (h as MentionHit).id === 'string' && typeof (h as MentionHit).name === 'string')
      .map((h) => ({ type: h.type, id: h.id, name: h.name.slice(0, 120), ...(typeof h.workflowId === 'string' && { workflowId: h.workflowId }), ...(typeof h.hint === 'string' && { hint: h.hint.slice(0, 120) }) }))
      .slice(0, MENTION_LIMITS.refs);
  } catch {
    return [];
  }
}
