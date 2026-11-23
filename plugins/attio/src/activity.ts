/**
 * Attio objects as activity items (docs/protocol.md §16): lookups with a small cache, and the mapping of a record, a
 * list entry, a note and a task to the item shape. The id of an item is `attio:<object, list, notes or tasks>:<id>:<time>`.
 */
import { activityItem, type ActivityItem, type JsonObject, type TracedFetch } from '@landflow/sdk';
import { asArray, asObject, asString, attioCall, isNotFound, type AttioCredentials } from './api';

export const SOURCE = 'attio';
export const KINDS = { moved: 'work.deal_moved', won: 'work.deal_won', note: 'work.discussion', task: 'work.action_item' } as const;
export const DEFAULT_WON_STAGES = 'Won';
export const DEFAULT_STAGE_ATTRIBUTE = 'stage';

export interface ActivityOptions {
  wonStages: string[];
  stageAttribute: string;
  teamHint: string;
}

export const activityOptions = (options: JsonObject | undefined): ActivityOptions => ({
  wonStages: String(options?.wonStages ?? DEFAULT_WON_STAGES).split(',').map((s) => s.trim()).filter(Boolean),
  stageAttribute: String(options?.stageAttribute ?? '').trim() || DEFAULT_STAGE_ATTRIBUTE,
  teamHint: String(options?.teamHint ?? '').trim(),
});

export const OPTION_PROPERTIES = [
  { name: 'wonStages', displayName: 'Won Stages', type: 'string', default: DEFAULT_WON_STAGES, description: 'Comma-separated stage names that count as won (compared ignoring case, emoji and punctuation, so "Won 🎉" matches Won): the kind becomes work.deal_won' },
  { name: 'stageAttribute', displayName: 'Stage Attribute', type: 'string', default: DEFAULT_STAGE_ATTRIBUTE, description: 'The API slug of the status attribute that holds the stage (deals: stage; a list: the list\'s own status attribute)' },
  { name: 'teamHint', displayName: 'Team Hint', type: 'string', default: '', placeholder: 'Sales', description: 'A constant for teamHint on every item. Empty: no team hint.' },
] as const;

/** Letters and digits only, lower case: "Won 🎉" and "won" compare equal. */
const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
export const isWon = (stage: string | undefined, wonStages: string[]) => Boolean(stage) && wonStages.some((w) => plain(w) === plain(stage as string));

/** An Attio timestamp (nanoseconds) as a millisecond ISO time. */
export const isoTime = (value: unknown): string | undefined => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

/** The active value entries of an attribute. */
export const entriesOf = (values: JsonObject | undefined, slug: string): JsonObject[] =>
  asArray(values?.[slug]).map(asObject).filter((e): e is JsonObject => Boolean(e) && (e as JsonObject).active_until == null);

/** One value entry as text, whatever its attribute type. */
export function valueText(entry: JsonObject): string {
  const status = asObject(entry.status);
  const option = asObject(entry.option);
  const parts = [entry.full_name, entry.value, entry.email_address, entry.domain, status?.title, option?.title, entry.currency_value, entry.target_record_id ? undefined : entry.original_phone_number];
  const found = parts.find((p) => typeof p === 'string' ? p !== '' : typeof p === 'number');
  return found === undefined ? '' : String(found);
}

/** The latest change in a record's or entry's values (or its creation), as a millisecond ISO time. */
export function changedAt(object: JsonObject, valuesKey: 'values' | 'entry_values'): string {
  let latest = Date.parse(String(object.created_at ?? '')) || 0;
  for (const entries of Object.values(asObject(object[valuesKey]) ?? {})) {
    for (const entry of asArray(entries)) {
      const from = Date.parse(String(asObject(entry)?.active_from ?? ''));
      if (Number.isFinite(from) && from > latest) latest = from;
    }
  }
  return new Date(latest || Date.now()).toISOString();
}

/** Who made the latest change in a record's or entry's values (an actor `{ type, id }`), if Attio says. */
export function latestActor(object: JsonObject, valuesKey: 'values' | 'entry_values'): JsonObject | undefined {
  let best: { at: number; actor?: JsonObject } = { at: -1 };
  for (const entries of Object.values(asObject(object[valuesKey]) ?? {})) {
    for (const entry of asArray(entries)) {
      const e = asObject(entry);
      const at = Date.parse(String(e?.active_from ?? ''));
      if (Number.isFinite(at) && at > best.at) best = { at, actor: asObject(e?.created_by_actor) };
    }
  }
  return best.actor;
}

export interface Cache extends JsonObject {
  /** object or list UUID → slug (lists: slug and name). */
  objects: Record<string, string>;
  lists: Record<string, { slug: string; name: string }>;
  members: Record<string, string>;
}

export const emptyCache = (): Cache => ({ objects: {}, lists: {}, members: {} });
export const cacheOf = (value: unknown): Cache => {
  const o = asObject(value);
  return { objects: { ...(asObject(o?.objects) as Record<string, string>) }, lists: { ...(asObject(o?.lists) as Cache['lists']) }, members: { ...(asObject(o?.members) as Record<string, string>) } };
};

/** Reads from Attio for the mapping, remembering object and list slugs and member emails in `cache`. */
export class AttioLookup {
  changed = false;
  private records = new Map<string, JsonObject | null>();
  private membersLoaded = false;

  constructor(
    readonly http: TracedFetch,
    readonly credentials: AttioCredentials,
    readonly cache: Cache = emptyCache(),
    private readonly warn: (message: string) => void = () => {},
  ) {}

  call<T = any>(method: string, path: string, options = {}) {
    return attioCall<T>(this.http, this.credentials, method, path, options);
  }

  async objectSlug(idOrSlug: string): Promise<string> {
    if (this.cache.objects[idOrSlug]) return this.cache.objects[idOrSlug];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(idOrSlug)) return idOrSlug;
    const slug = asString(asObject((await this.call('GET', `/objects/${idOrSlug}`)).data)?.api_slug) ?? idOrSlug;
    this.cache.objects[idOrSlug] = slug;
    this.changed = true;
    return slug;
  }

  async list(idOrSlug: string): Promise<{ slug: string; name: string }> {
    const known = this.cache.lists[idOrSlug];
    if (known) return known;
    const data = asObject((await this.call('GET', `/lists/${idOrSlug}`)).data);
    const list = { slug: asString(data?.api_slug) ?? idOrSlug, name: asString(data?.name) ?? idOrSlug };
    this.cache.lists[idOrSlug] = list;
    this.changed = true;
    return list;
  }

  async record(object: string, id: string): Promise<JsonObject | null> {
    const key = `${object}/${id}`;
    if (!this.records.has(key)) {
      try {
        this.records.set(key, asObject((await this.call('GET', `/objects/${object}/records/${id}`)).data) ?? null);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        this.records.set(key, null);
      }
    }
    return this.records.get(key) ?? null;
  }

  async memberEmail(id: string | undefined): Promise<string | null> {
    if (!id) return null;
    if (!this.cache.members[id] && !this.membersLoaded) {
      this.membersLoaded = true;
      try {
        for (const member of asArray((await this.call('GET', '/workspace_members')).data)) {
          const m = asObject(member);
          const memberId = asString(asObject(m?.id)?.workspace_member_id);
          const email = asString(m?.email_address);
          if (memberId && email) this.cache.members[memberId] = email;
        }
        this.changed = true;
      } catch (error) {
        this.warn(`could not read workspace members (user_management:read?): ${(error as Error).message}`);
      }
    }
    return this.cache.members[id] ?? null;
  }

  /** The email of a workspace-member actor `{ type, id }`; null for tokens, apps and the system. */
  async actorEmail(actor: unknown): Promise<string | null> {
    const a = asObject(actor);
    return a?.type === 'workspace-member' ? this.memberEmail(asString(a.id)) : null;
  }

  /** The company a record belongs to: itself (companies), its Company (people) or Associated company (deals). */
  async customerOf(objectSlug: string, record: JsonObject | null): Promise<string | undefined> {
    if (!record) return undefined;
    const values = asObject(record.values);
    if (objectSlug === 'companies') return nameOf(record);
    const reference = entriesOf(values, objectSlug === 'people' ? 'company' : 'associated_company')[0] ?? entriesOf(values, 'associated_company')[0] ?? entriesOf(values, 'company')[0];
    const target = asString(reference?.target_record_id);
    if (!target) return undefined;
    return nameOf(await this.record(asString(reference?.target_object) ?? 'companies', target));
  }
}

/** A record's display name. */
export function nameOf(record: JsonObject | null | undefined): string | undefined {
  const values = asObject(record?.values);
  for (const slug of ['name', 'email_addresses', 'domains']) {
    const text = entriesOf(values, slug).map(valueText).find(Boolean);
    if (text) return text;
  }
  return undefined;
}

const recordId = (record: JsonObject) => asString(asObject(record.id)?.record_id) ?? '';

/** The stage of a record or entry: its title and when it was set. */
function stageOf(values: JsonObject | undefined, slug: string): { title: string; since?: string } | undefined {
  const entry = entriesOf(values, slug)[0];
  const title = entry ? valueText(entry) : '';
  return title ? { title, since: isoTime(entry?.active_from) } : undefined;
}

/** A line per set attribute: "stage: Won; value: 1200". Skips references. */
function valueSummary(values: JsonObject | undefined): string {
  const parts: string[] = [];
  for (const slug of Object.keys(values ?? {})) {
    const text = entriesOf(values, slug).map(valueText).filter(Boolean).join(', ');
    if (text) parts.push(`${slug}: ${text}`);
  }
  return parts.join('; ');
}

const trimRecord = (record: JsonObject): JsonObject => ({ id: record.id ?? null, created_at: record.created_at ?? null, web_url: record.web_url ?? null, values: valueSnapshot(asObject(record.values)) });
function valueSnapshot(values: JsonObject | undefined): JsonObject {
  const out: JsonObject = {};
  for (const slug of Object.keys(values ?? {})) {
    const text = entriesOf(values, slug).map(valueText).filter(Boolean);
    if (text.length) out[slug] = text;
  }
  return out;
}

const kindFor = (stage: { title: string; since?: string } | undefined, changed: string, fresh: boolean, won: string[]) => {
  const latest = stage?.since !== undefined && (fresh || Date.parse(stage.since) >= Date.parse(changed));
  return latest && isWon(stage?.title, won) ? KINDS.won : KINDS.moved;
};

export interface RecordItemInput {
  record: JsonObject;
  objectSlug: string;
  /** The webhook's event type, or undefined when the record is listed. */
  event?: string;
  customer?: string;
  actorEmail?: string | null;
  options: ActivityOptions;
  cursor?: boolean;
  /** Use this time (the record's creation) instead of its latest change. */
  time?: string;
}

/** A record as an activity item. The time is the record's latest value change (or its creation). */
export function recordItem(input: RecordItemInput): ActivityItem {
  const { record, objectSlug, options } = input;
  const id = recordId(record);
  const values = asObject(record.values);
  const fresh = input.event === 'record.created';
  const time = input.time ?? (fresh ? (isoTime(record.created_at) ?? changedAt(record, 'values')) : changedAt(record, 'values'));
  const stage = stageOf(values, options.stageAttribute);
  const name = nameOf(record) ?? id;
  const kind = kindFor(stage, time, fresh || time === isoTime(record.created_at), options.wonStages);
  const verb = fresh ? 'created' : kind === KINDS.won ? `won (${stage?.title})` : stage && kind === KINDS.moved && stage.since && Date.parse(stage.since) >= Date.parse(time) ? `moved to ${stage.title}` : 'updated';
  return activityItem({
    source: SOURCE,
    sourceId: `${SOURCE}:${objectSlug}:${id}:${time}`,
    url: asString(record.web_url),
    actorEmail: input.actorEmail,
    occurredAt: time,
    kind,
    title: `${name} ${verb}`,
    summary: `${objectSlug} record ${name} ${verb}. ${valueSummary(values)}`,
    teamHint: options.teamHint,
    customerHint: input.customer,
    raw: { record: trimRecord(record), ...(input.event && { event: input.event }) },
    ...(input.cursor && { cursor: time }),
  });
}

export interface EntryItemInput {
  entry: JsonObject;
  list: { slug: string; name: string };
  parent?: JsonObject | null;
  parentSlug?: string;
  event?: string;
  customer?: string;
  actorEmail?: string | null;
  options: ActivityOptions;
  cursor?: boolean;
  time?: string;
}

/** A list entry (a deal in a pipeline) as an activity item. */
export function entryItem(input: EntryItemInput): ActivityItem {
  const { entry, list, options } = input;
  const id = asString(asObject(entry.id)?.entry_id) ?? '';
  const values = asObject(entry.entry_values);
  const fresh = input.event === 'list-entry.created';
  const time = input.time ?? (fresh ? (isoTime(entry.created_at) ?? changedAt(entry, 'entry_values')) : changedAt(entry, 'entry_values'));
  const stage = stageOf(values, options.stageAttribute);
  const name = nameOf(input.parent) ?? asString(entry.parent_record_id) ?? id;
  const kind = kindFor(stage, time, fresh || time === isoTime(entry.created_at), options.wonStages);
  const verb = fresh ? `added to ${list.name}` : kind === KINDS.won ? `won in ${list.name}` : stage ? `in ${list.name}: ${stage.title}` : `updated in ${list.name}`;
  return activityItem({
    source: SOURCE,
    sourceId: `${SOURCE}:${list.slug}:${id}:${time}`,
    url: asString(input.parent?.web_url),
    actorEmail: input.actorEmail,
    occurredAt: time,
    kind,
    title: `${name} ${verb}`,
    summary: `${name} ${verb}. ${valueSummary(values)}`,
    teamHint: options.teamHint,
    customerHint: input.customer,
    raw: { entry: { id: entry.id ?? null, parent_record_id: entry.parent_record_id ?? null, parent_object: entry.parent_object ?? null, created_at: entry.created_at ?? null, entry_values: valueSnapshot(values) }, ...(input.event && { event: input.event }) },
    ...(input.cursor && { cursor: time }),
  });
}

/** A note as an activity item; the note's parent record gives the URL and the customer. */
export function noteItem(input: { note: JsonObject; parent?: JsonObject | null; customer?: string; actorEmail?: string | null; options: ActivityOptions }): ActivityItem {
  const { note } = input;
  const id = asString(asObject(note.id)?.note_id) ?? '';
  const time = isoTime(note.created_at) ?? new Date().toISOString();
  const title = asString(note.title) ?? 'Note';
  const parentName = nameOf(input.parent);
  return activityItem({
    source: SOURCE,
    sourceId: `${SOURCE}:notes:${id}:${time}`,
    url: asString(input.parent?.web_url),
    actorEmail: input.actorEmail,
    occurredAt: time,
    kind: KINDS.note,
    title: `Note: ${title}${parentName ? ` on ${parentName}` : ''}`,
    summary: `${title}. ${String(note.content_plaintext ?? '')}`,
    teamHint: input.options.teamHint,
    customerHint: input.customer,
    raw: { note: { id: note.id ?? null, parent_object: note.parent_object ?? null, parent_record_id: note.parent_record_id ?? null, title, content_plaintext: note.content_plaintext ?? null, created_at: note.created_at ?? null } },
  });
}

/** A task as an activity item; its first linked record gives the URL and the customer. */
export function taskItem(input: { task: JsonObject; linked?: JsonObject | null; customer?: string; actorEmail?: string | null; options: ActivityOptions }): ActivityItem {
  const { task } = input;
  const id = asString(asObject(task.id)?.task_id) ?? '';
  const time = isoTime(task.created_at) ?? new Date().toISOString();
  const content = String(task.content_plaintext ?? '');
  const due = asString(task.deadline_at);
  return activityItem({
    source: SOURCE,
    sourceId: `${SOURCE}:tasks:${id}:${time}`,
    url: asString(input.linked?.web_url),
    actorEmail: input.actorEmail,
    occurredAt: time,
    kind: KINDS.task,
    title: `Task: ${content}`,
    summary: `${content}${due ? ` (due ${due})` : ''}${task.is_completed === true ? ' [done]' : ''}`,
    teamHint: input.options.teamHint,
    customerHint: input.customer,
    raw: { task: { id: task.id ?? null, content_plaintext: content, deadline_at: task.deadline_at ?? null, is_completed: task.is_completed ?? false, linked_records: asArray(task.linked_records).slice(0, 10) as never, assignees: asArray(task.assignees).slice(0, 10) as never, created_at: task.created_at ?? null } },
  });
}

/** Build the item for one webhook event (fetching what the id-only payload lacks); undefined when the object is gone or filtered out. */
export async function eventItem(lookup: AttioLookup, event: JsonObject, options: ActivityOptions, objects: string[]): Promise<ActivityItem | undefined> {
  const type = String(event.event_type ?? '');
  const ids = asObject(event.id) ?? {};
  const actorEmail = await lookup.actorEmail(event.actor);
  const allowed = (slug: string) => objects.length === 0 || objects.includes(slug);
  if (type === 'record.created' || type === 'record.updated') {
    const objectId = asString(ids.object_id);
    const id = asString(ids.record_id);
    if (!objectId || !id) return undefined;
    const slug = await lookup.objectSlug(objectId);
    if (!allowed(slug)) return undefined;
    const record = await lookup.record(objectId, id);
    if (!record) return undefined;
    return recordItem({ record, objectSlug: slug, event: type, customer: await lookup.customerOf(slug, record), actorEmail, options });
  }
  if (type === 'list-entry.created' || type === 'list-entry.updated') {
    const listId = asString(ids.list_id);
    const entryId = asString(ids.entry_id);
    if (!listId || !entryId) return undefined;
    const parentSlug = await lookup.objectSlug(String(event.parent_object_id ?? ''));
    if (!allowed(parentSlug)) return undefined;
    let entry: JsonObject | undefined;
    try {
      entry = asObject((await lookup.call('GET', `/lists/${listId}/entries/${entryId}`)).data);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (!entry) return undefined;
    const list = await lookup.list(listId);
    const parent = await lookup.record(String(event.parent_object_id), String(event.parent_record_id));
    return entryItem({ entry, list, parent, parentSlug, event: type, customer: await lookup.customerOf(parentSlug, parent), actorEmail, options });
  }
  if (type === 'note.created') {
    const noteId = asString(ids.note_id);
    if (!noteId) return undefined;
    const parentSlug = await lookup.objectSlug(String(event.parent_object_id ?? ''));
    if (!allowed(parentSlug)) return undefined;
    let note: JsonObject | undefined;
    try {
      note = asObject((await lookup.call('GET', `/notes/${noteId}`)).data);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (!note) return undefined;
    const parent = await lookup.record(String(event.parent_object_id), String(event.parent_record_id));
    return noteItem({ note, parent, customer: await lookup.customerOf(parentSlug, parent), actorEmail: actorEmail ?? (await lookup.actorEmail(note.created_by_actor)), options });
  }
  if (type === 'task.created') {
    const taskId = asString(ids.task_id);
    if (!taskId) return undefined;
    let task: JsonObject | undefined;
    try {
      task = asObject((await lookup.call('GET', `/tasks/${taskId}`)).data);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (!task) return undefined;
    const link = asObject(asArray(task.linked_records)[0]);
    const object = asString(link?.target_object_id);
    const target = asString(link?.target_record_id);
    const linked = object && target ? await lookup.record(object, target) : null;
    const slug = object ? await lookup.objectSlug(object) : '';
    return taskItem({ task, linked, customer: await lookup.customerOf(slug, linked), actorEmail: actorEmail ?? (await lookup.actorEmail(task.created_by_actor)), options });
  }
  return undefined;
}

export const SUPPORTED_EVENTS = ['record.created', 'record.updated', 'list-entry.created', 'list-entry.updated', 'note.created', 'task.created'] as const;
