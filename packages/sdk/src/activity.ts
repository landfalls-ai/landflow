/**
 * Activity items: one change in an outside tool (a message, an edited document, a moved ticket, a held meeting) in the
 * same shape whatever the tool, so one flow can take items from any integration trigger or List Changed Since
 * operation. The schema is `packages/protocol/activity-items/activity-item.schema.json`; the Go (`landflow.ActivityItem`)
 * and Python (`landflow_sdk.activity.activity_item`) SDKs build the same output, checked against the shared cases in
 * `packages/protocol/activity-items/cases.json`.
 */
import type { JsonObject, JsonValue } from '@landflow/protocol';

export const ACTIVITY_TITLE_MAX = 200;
export const ACTIVITY_SUMMARY_MAX = 600;
export const ACTIVITY_HINT_MAX = 200;
/** Strings inside `raw` keep this many characters. */
export const ACTIVITY_RAW_STRING_MAX = 1000;
/** Lists inside `raw` keep this many entries. */
export const ACTIVITY_RAW_LIST_MAX = 25;
/** Objects and lists this deep inside `raw` become "…". */
export const ACTIVITY_RAW_DEPTH_MAX = 5;

const KIND = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const ELLIPSIS = '…';

export interface ActivityInput {
  source: string;
  sourceId: string;
  url?: string | null;
  actorEmail?: string | null;
  /** ISO 8601 (a date alone, or a time without an offset, is UTC), epoch milliseconds, or a Date. */
  occurredAt: string | number | Date;
  kind: string;
  title?: string | null;
  summary?: string | null;
  teamHint?: string | null;
  initiativeHint?: string | null;
  customerHint?: string | null;
  raw?: unknown;
  /** Left out: the item has no `cursor` field. */
  cursor?: string | null;
}

export interface ActivityItem extends JsonObject {
  source: string;
  sourceId: string;
  url: string | null;
  actorEmail: string | null;
  occurredAt: string;
  kind: string;
  title: string;
  summary: string;
  teamHint: string | null;
  initiativeHint: string | null;
  customerHint: string | null;
  raw: JsonObject;
}

/** The JSON Schema of one activity item: a node's (or operation's) `outputSchema`. */
export const ACTIVITY_ITEM_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    source: { type: 'string', description: 'The tool, lowercase: slack, google-drive, google-calendar, notion, …' },
    sourceId: { type: 'string', description: "Stable id of the change, '<source>:<tool ids>': the same change always has the same id, so a replay is recognised" },
    url: { type: ['string', 'null'], description: 'Where a person opens it' },
    actorEmail: { type: ['string', 'null'], description: "Email of the person who made the change, lowercase; null when the tool doesn't say" },
    occurredAt: { type: 'string', format: 'date-time', description: 'When it happened, ISO 8601 in UTC with milliseconds' },
    kind: { type: 'string', pattern: '^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$', description: 'Suggested event kind, such as work.discussion or work.doc_edited; a flow may change it' },
    title: { type: 'string', maxLength: 200, description: 'One line: the document, ticket or meeting title, or the channel and first words' },
    summary: { type: 'string', maxLength: 600, description: 'The text, whitespace collapsed, at most 600 characters' },
    teamHint: { type: ['string', 'null'], description: "The team it seems to belong to, from the tool's own grouping, when there is one" },
    initiativeHint: { type: ['string', 'null'], description: 'The project or initiative it seems to belong to, when there is one' },
    customerHint: { type: ['string', 'null'], description: 'The customer it is about, when there is one (a #customer-<name> channel, a CRM company…)' },
    raw: { type: 'object', description: "The tool's own object, trimmed: long strings clipped, long lists cut, deep nesting dropped" },
    cursor: { type: ['string', 'null'], description: 'Pass it back as Since to continue after this item (List Changed Since operations)' },
  },
  required: ['source', 'sourceId', 'url', 'actorEmail', 'occurredAt', 'kind', 'title', 'summary', 'teamHint', 'initiativeHint', 'customerHint', 'raw'],
  additionalProperties: false,
};

/** At most `max` characters (code points); a longer text ends in "…" within the limit. */
export function clipText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - 1)).join('').trimEnd() + ELLIPSIS;
}

/** Runs of whitespace (newlines included) become one space; ends trimmed. */
export function collapseWhitespace(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ');
}

const line = (value: unknown, max: number): string => clipText(collapseWhitespace(value == null ? '' : String(value)), max);
const optional = (value: unknown, max: number): string | null => line(value, max) || null;

/** ISO 8601 in UTC with milliseconds, from an ISO string, epoch milliseconds or a Date; throws on anything else. */
export function toIsoTime(value: string | number | Date): string {
  let ms: number;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'number') ms = value;
  else {
    const text = String(value ?? '').trim();
    // A date alone is UTC in JavaScript; a time without an offset would be local, so it is read as UTC too.
    const iso = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(text) ? `${text}Z` : text;
    ms = /^\d{4}-\d{2}-\d{2}/.test(iso) ? Date.parse(iso) : NaN;
  }
  if (!Number.isFinite(ms)) throw new Error(`occurredAt is not a time: ${JSON.stringify(value)}`);
  return new Date(Math.trunc(ms)).toISOString();
}

/** A vendor object made small: strings clipped, lists cut, deep nesting replaced by "…", undefined dropped. */
export function trimRaw(value: unknown, depth = 0): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return clipText(value, ACTIVITY_RAW_STRING_MAX);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (depth >= ACTIVITY_RAW_DEPTH_MAX) return ELLIPSIS;
    return value.slice(0, ACTIVITY_RAW_LIST_MAX).map((entry) => trimRaw(entry === undefined ? null : entry, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= ACTIVITY_RAW_DEPTH_MAX) return ELLIPSIS;
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined || typeof entry === 'function') continue;
      out[key] = trimRaw(entry, depth + 1);
    }
    return out;
  }
  return null;
}

/** One activity item, normalised: the same output as the Go and Python SDKs for the same input. Throws on a missing source or sourceId, a bad kind or time. */
export function activityItem(input: ActivityInput): ActivityItem {
  const source = String(input.source ?? '').trim().toLowerCase();
  if (!source) throw new Error('source is required');
  const sourceId = String(input.sourceId ?? '').trim();
  if (!sourceId) throw new Error('sourceId is required');
  const kind = String(input.kind ?? '').trim().toLowerCase();
  if (!KIND.test(kind)) throw new Error(`kind must be <namespace>.<name> in lowercase letters, digits and underscores (got ${JSON.stringify(input.kind)})`);
  const email = String(input.actorEmail ?? '').trim().toLowerCase();
  const raw = input.raw === undefined || input.raw === null ? {} : typeof input.raw === 'object' && !Array.isArray(input.raw) ? input.raw : { value: input.raw };
  const item: ActivityItem = {
    source,
    sourceId,
    url: String(input.url ?? '').trim() || null,
    actorEmail: email.includes('@') ? email : null,
    occurredAt: toIsoTime(input.occurredAt),
    kind,
    title: line(input.title, ACTIVITY_TITLE_MAX) || clipText(sourceId, ACTIVITY_TITLE_MAX),
    summary: line(input.summary, ACTIVITY_SUMMARY_MAX),
    teamHint: optional(input.teamHint, ACTIVITY_HINT_MAX),
    initiativeHint: optional(input.initiativeHint, ACTIVITY_HINT_MAX),
    customerHint: optional(input.customerHint, ACTIVITY_HINT_MAX),
    raw: trimRaw(raw) as JsonObject,
  };
  if (input.cursor !== undefined) item.cursor = input.cursor === null ? null : String(input.cursor).trim() || null;
  return item;
}
