/**
 * Fathom's REST API and its meetings as activity items (docs/protocol.md §16): a small client (X-Api-Key, 429 retries,
 * cursor paging), the meeting → item mapping (one item per meeting, optionally one per action item), the text of a
 * meeting, and webhook signature verification (Standard Webhooks style: webhook-id / webhook-timestamp / webhook-signature).
 */
import { activityItem, NodeOperationError, safeEqual, hmacSha256, DEFAULT_SIGNATURE_TOLERANCE_SECONDS, type ActivityItem, type JsonObject, type TracedFetch } from '@landflow/sdk';

export const DEFAULT_BASE_URL = 'https://api.fathom.ai/external/v1';
export const SUMMARY_MAX = 600;
export const TOLERANCE_SECONDS = DEFAULT_SIGNATURE_TOLERANCE_SECONDS;

export interface FathomCredentials extends JsonObject {
  apiKey: string;
  baseUrl: string;
}

export interface Api {
  http: TracedFetch;
}

const asObject = (v: unknown): JsonObject | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : undefined);
const asArray = (v: unknown): JsonObject[] => (Array.isArray(v) ? v.filter((x): x is JsonObject => !!asObject(x)) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const baseUrlOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_BASE_URL).replace(/\/+$/, '');

function hint(status: number): string | undefined {
  if (status === 401) return 'Fathom rejected the API key (unauthorized). Create a key under Settings → API Access in Fathom and paste it into the credential.';
  if (status === 403) return 'Fathom refused the call (forbidden). Some endpoints are admin-only (Users) or limited by your plan or sharing settings.';
  if (status === 404) return 'Fathom found nothing at that path or id.';
  return undefined;
}

/** One call: JSON in and out, up to `retries` waits on 429 (Retry-After, at most 30 s each). 204 gives `{}`. */
export async function fathomCall<T = any>(
  api: Api,
  credentials: FathomCredentials,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: { query?: Record<string, unknown>; body?: JsonObject; retries?: number } = {},
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) for (const v of value) query.append(key, String(v));
    else query.set(key, String(value));
  }
  const url = `${baseUrlOf(credentials.baseUrl)}${path}${[...query.keys()].length ? `?${query}` : ''}`;
  const headers: Record<string, string> = { 'x-api-key': String(credentials.apiKey ?? '').trim(), accept: 'application/json' };
  if (options.body) headers['content-type'] = 'application/json';
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await api.http(url, { method, headers, ...(options.body && { body: JSON.stringify(options.body) }), signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new NodeOperationError(`Fathom API request failed: ${(error as Error).message}`);
    }
    if (response.status === 429 && attempt < (options.retries ?? 3)) {
      await sleep(Math.min(30, Number(response.headers.get('retry-after') ?? 1) || 1) * 1000);
      continue;
    }
    const text = await response.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }
    if (!response.ok) {
      const detail = str(asObject(body)?.message) ?? str(asObject(body)?.error) ?? (text.slice(0, 200) || `HTTP ${response.status}`);
      throw new NodeOperationError(`Fathom API error (${response.status}): ${detail}`, { description: response.status === 429 ? 'Fathom allows 60 calls a minute (30 for summaries and transcripts). Try again shortly.' : hint(response.status) });
    }
    return body as T;
  }
}

/** All pages of a list endpoint (follows `next_cursor`), at most `maxPages` of them. */
export async function fathomPages(api: Api, credentials: FathomCredentials, path: string, query: Record<string, unknown>, max: number, maxPages = 100): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages && out.length < max; page++) {
    const body: JsonObject = await fathomCall<JsonObject>(api, credentials, 'GET', path, { query: { ...query, cursor } });
    out.push(...asArray(body.items));
    cursor = str(body.next_cursor);
    if (!cursor) break;
  }
  return out;
}

export interface MeetingFlags {
  summary: boolean;
  actionItems: boolean;
  transcript: boolean;
}

export const meetingQuery = (flags: MeetingFlags): Record<string, unknown> => ({
  ...(flags.summary && { include_summary: true }),
  ...(flags.actionItems && { include_action_items: true }),
  ...(flags.transcript && { include_transcript: true }),
});

/** Meetings created after `after` (ISO), oldest first, strictly after it. Fathom's listing order is not documented, so all pages are read and sorted here. */
export async function meetingsSince(api: Api, credentials: FathomCredentials, after: string | null, filters: Record<string, unknown>, flags: MeetingFlags, max: number): Promise<JsonObject[]> {
  const all = await fathomPages(api, credentials, '/meetings', { ...filters, ...meetingQuery(flags), ...(after && { created_after: after }) }, Infinity);
  const floor = after ? Date.parse(after) : -Infinity;
  const stamped = all.map((m) => ({ m, t: Date.parse(String(m.created_at ?? '')) })).filter((x) => Number.isFinite(x.t) && x.t > floor);
  stamped.sort((a, b) => a.t - b.t || Number(a.m.recording_id) - Number(b.m.recording_id));
  return stamped.slice(0, max).map((x) => x.m);
}

/** A Since value as an ISO time: an ISO string (or cursor) as is, empty is 24 hours ago. */
export function sinceIso(value: unknown, now = Date.now()): string {
  const text = String(value ?? '').trim();
  if (!text) return new Date(now - 86_400_000).toISOString();
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(text) ? `${text}Z` : text);
  if (!Number.isFinite(ms)) throw new NodeOperationError(`Since must be an ISO time or a cursor from an earlier item (got "${text}")`);
  return new Date(ms).toISOString();
}

// ---- mapping -----------------------------------------------------------------------------------------------------

export interface MappingOptions {
  /** Comma-separated domains that are the company's own; empty: the recorder's domain. */
  internalDomains: string;
  /** Also one item per action item. */
  actionItemItems: boolean;
  /** Put the transcript into `raw`. */
  transcript: boolean;
  cursor?: boolean;
}

const lower = (v: unknown) => str(v)?.toLowerCase() ?? null;
const domainOf = (email: string | null) => (email && email.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : null);

/** Markdown made plain enough for a one-paragraph summary. */
export function plainMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const summaryOf = (meeting: JsonObject): string => plainMarkdown(str(asObject(meeting.default_summary)?.markdown_formatted) ?? '');
export const meetingId = (meeting: JsonObject) => String(meeting.recording_id ?? '');
const startOf = (meeting: JsonObject) => str(meeting.recording_start_time) ?? str(meeting.scheduled_start_time) ?? str(meeting.created_at) ?? new Date(0).toISOString();

/** The first invitee whose email domain is not internal: its domain. */
export function customerOf(meeting: JsonObject, internalDomains: string): string | null {
  const recorderDomain = domainOf(lower(asObject(meeting.recorded_by)?.email));
  const internal = new Set(
    internalDomains.split(/[,\s]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
  );
  if (internal.size === 0 && recorderDomain) internal.add(recorderDomain);
  for (const invitee of asArray(meeting.calendar_invitees)) {
    const email = lower(invitee.email);
    const domain = lower(invitee.email_domain) ?? domainOf(email);
    if (domain && !internal.has(domain)) return domain;
  }
  return null;
}

function meetingRaw(meeting: JsonObject, transcript: boolean): JsonObject {
  const recorder = asObject(meeting.recorded_by);
  return {
    recording_id: meeting.recording_id ?? null,
    meeting_title: meeting.meeting_title ?? null,
    meeting_type: meeting.meeting_type ?? null,
    created_at: meeting.created_at ?? null,
    scheduled_start_time: meeting.scheduled_start_time ?? null,
    recording_start_time: meeting.recording_start_time ?? null,
    recording_end_time: meeting.recording_end_time ?? null,
    transcript_language: meeting.transcript_language ?? null,
    share_url: meeting.share_url ?? null,
    recorded_by: recorder ? { name: recorder.name ?? null, email: recorder.email ?? null, team: recorder.team ?? null } : null,
    invitees: asArray(meeting.calendar_invitees).map((i) => ({ name: i.name ?? null, email: i.email ?? null, is_external: i.is_external ?? null })),
    action_item_count: Array.isArray(meeting.action_items) ? meeting.action_items.length : null,
    ...(transcript && Array.isArray(meeting.transcript) && { transcript: meeting.transcript }),
  };
}

/** One meeting as an activity item: work.meeting_notes with a summary, work.meeting_held without. */
export function meetingActivity(meeting: JsonObject, options: MappingOptions, cursor?: string): ActivityItem {
  const summary = summaryOf(meeting);
  const invitees = asArray(meeting.calendar_invitees).map((i) => str(i.name) ?? str(i.email)).filter(Boolean);
  return activityItem({
    source: 'fathom',
    sourceId: `fathom:meeting:${meetingId(meeting)}`,
    url: str(meeting.share_url) ?? str(meeting.url),
    actorEmail: lower(asObject(meeting.recorded_by)?.email),
    occurredAt: startOf(meeting),
    kind: summary ? 'work.meeting_notes' : 'work.meeting_held',
    title: str(meeting.title) ?? str(meeting.meeting_title) ?? `Meeting ${meetingId(meeting)}`,
    summary: summary || (invitees.length ? `Meeting with ${invitees.slice(0, 8).join(', ')}` : ''),
    teamHint: str(asObject(meeting.recorded_by)?.team),
    customerHint: customerOf(meeting, options.internalDomains),
    raw: meetingRaw(meeting, options.transcript),
    ...(cursor !== undefined && { cursor }),
  });
}

/** One action item as an activity item (work.action_item); the assignee is the actor when Fathom names an email. */
export function actionActivity(meeting: JsonObject, action: JsonObject, n: number, options: MappingOptions, cursor?: string): ActivityItem {
  const assignee = asObject(action.assignee);
  const description = plainMarkdown(str(action.description) ?? '');
  return activityItem({
    source: 'fathom',
    sourceId: `fathom:action:${meetingId(meeting)}:${n}`,
    url: str(action.recording_playback_url) ?? str(meeting.share_url) ?? str(meeting.url),
    actorEmail: lower(assignee?.email) ?? lower(asObject(meeting.recorded_by)?.email),
    occurredAt: startOf(meeting),
    kind: 'work.action_item',
    title: description || `Action item ${n}`,
    summary: description,
    teamHint: str(assignee?.team) ?? str(asObject(meeting.recorded_by)?.team),
    customerHint: customerOf(meeting, options.internalDomains),
    raw: {
      recording_id: meeting.recording_id ?? null,
      meeting_title: str(meeting.title) ?? str(meeting.meeting_title),
      completed: action.completed ?? null,
      user_generated: action.user_generated ?? null,
      recording_timestamp: action.recording_timestamp ?? null,
      assignee: assignee ? { name: assignee.name ?? null, email: assignee.email ?? null, team: assignee.team ?? null } : null,
    },
    ...(cursor !== undefined && { cursor }),
  });
}

/** The meeting's item, then (with the option) one item per action item. The cursor of each is the meeting's created_at. */
export function meetingItems(meeting: JsonObject, options: MappingOptions): ActivityItem[] {
  const cursor = options.cursor ? String(meeting.created_at ?? '') : undefined;
  const items = [meetingActivity(meeting, options, cursor)];
  if (options.actionItemItems) asArray(meeting.action_items).forEach((a, i) => items.push(actionActivity(meeting, a, i + 1, options, cursor)));
  return items;
}

export function transcriptText(transcript: unknown): string {
  return asArray(transcript)
    .map((t) => `[${str(t.timestamp) ?? '00:00:00'}] ${str(asObject(t.speaker)?.display_name) ?? 'Speaker'}: ${str(t.text) ?? ''}`)
    .join('\n');
}

/** The meeting's text: summary, action items and (only when `transcript`) the transcript. */
export function meetingText(meeting: JsonObject, transcript: boolean): string {
  const parts: string[] = [];
  const summary = str(asObject(meeting.default_summary)?.markdown_formatted);
  if (summary) parts.push(`Summary\n${summary}`);
  const actions = asArray(meeting.action_items);
  if (actions.length) {
    parts.push(
      `Action items\n${actions
        .map((a) => `- [${a.completed === true ? 'x' : ' '}] ${str(a.description) ?? ''}${str(asObject(a.assignee)?.name) ? ` (${str(asObject(a.assignee)?.name)})` : ''}`)
        .join('\n')}`,
    );
  }
  if (transcript) {
    const text = transcriptText(meeting.transcript);
    if (text) parts.push(`Transcript\n${text}`);
  }
  return parts.join('\n\n');
}

// ---- webhook signature -------------------------------------------------------------------------------------------

/**
 * Fathom signs like Standard Webhooks: HMAC-SHA256 (base64) over `<webhook-id>.<webhook-timestamp>.<raw body>`, keyed
 * with the base64-decoded part of the `whsec_…` secret after the prefix; `webhook-signature` holds space-delimited
 * `v1,<signature>` values; the timestamp (seconds) must be within the tolerance.
 */
export function verifyFathomSignature(
  secret: string,
  rawBody: string | Uint8Array,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  options: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  const { toleranceSeconds = TOLERANCE_SECONDS, now = Date.now() } = options;
  const id = headers.id?.trim();
  const timestamp = Number(headers.timestamp);
  if (!secret.trim() || !id || !headers.signature || !Number.isFinite(timestamp)) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const key = Buffer.from(secret.trim().replace(/^whsec_/, ''), 'base64');
  if (key.length === 0) return false;
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody) : Buffer.from(rawBody);
  const expected = hmacSha256(key, Buffer.concat([Buffer.from(`${id}.${headers.timestamp!.trim()}.`), body]), 'base64');
  return headers.signature.split(/\s+/).some((entry) => {
    const comma = entry.indexOf(',');
    return comma > 0 && safeEqual(entry.slice(comma + 1), expected);
  });
}

/** A signature header for tests and tools. */
export function signFathom(secret: string, rawBody: string, id: string, timestamp: number): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${hmacSha256(key, `${id}.${timestamp}.${rawBody}`, 'base64')}`;
}
