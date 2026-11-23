/**
 * A fake Fathom API: X-Api-Key auth, GET /meetings (cursor pages of 2, newest first, created_after, include_* flags),
 * /recordings/{id}/summary|transcript, /teams, /team_members, /users (admin only), /meeting_types, and POST/DELETE
 * /webhooks. Fake keys and data only.
 */
import { randomBytes } from 'node:crypto';
import type { JsonObject } from '@landflow/sdk';
import { startFakeApi, type FakeApi, type FakeRequest } from './helpers';

export const KEY = 'fake-fathom-key';
export const PAGE = 2;

export interface FakeFathom {
  meetings: JsonObject[];
  webhooks: Map<string, JsonObject>;
}

export const meeting = (id: number, createdAt: string, extra: JsonObject = {}): JsonObject => ({
  title: `Meeting ${id}`,
  meeting_title: `Meeting ${id}`,
  meeting_type: 'external',
  recording_id: id,
  url: `https://fathom.video/calls/${id}`,
  share_url: `https://fathom.video/share/${id}`,
  created_at: createdAt,
  scheduled_start_time: createdAt,
  scheduled_end_time: createdAt,
  recording_start_time: createdAt,
  recording_end_time: createdAt,
  calendar_invitees_domains_type: 'one_or_more_external',
  shared_with: 'no_teams',
  transcript_language: 'en',
  recorded_by: { name: 'Dana', email: 'Dana@Acme.example', email_domain: 'acme.example', team: 'Sales' },
  calendar_invitees: [
    { name: 'Dana', email: 'dana@acme.example', email_domain: 'acme.example', is_external: false, matched_speaker_display_name: null },
    { name: 'Pat', email: 'pat@globex.example', email_domain: 'globex.example', is_external: true, matched_speaker_display_name: null },
  ],
  ...extra,
});

export const SUMMARY = '## Summary\n\n**Renewal** discussed. ' + 'Pricing and rollout were covered in depth. '.repeat(30);

export const withNotes = (id: number, createdAt: string): JsonObject =>
  meeting(id, createdAt, {
    default_summary: { template_name: 'general', markdown_formatted: SUMMARY },
    action_items: [
      { description: 'Send the quote', user_generated: false, completed: false, recording_timestamp: '00:10:00', recording_playback_url: `https://fathom.video/share/${id}?t=600`, assignee: { name: 'Dana', email: 'Dana@Acme.example', team: 'Sales' } },
      { description: 'Book a kickoff', user_generated: false, completed: true, recording_timestamp: '00:20:00', recording_playback_url: `https://fathom.video/share/${id}?t=1200`, assignee: { name: null, email: null, team: null } },
    ],
    transcript: [{ speaker: { display_name: 'Dana', matched_calendar_invitee_email: 'dana@acme.example' }, text: 'Secret words', timestamp: '00:00:05' }],
  });

/** Meetings as the list endpoint serves them: only the parts the include flags ask for. */
function shaped(m: JsonObject, q: URLSearchParams): JsonObject {
  const out = { ...m };
  if (q.get('include_summary') !== 'true') delete out.default_summary;
  if (q.get('include_action_items') !== 'true') delete out.action_items;
  if (q.get('include_transcript') !== 'true') delete out.transcript;
  return out;
}

export async function startFakeFathom(state: () => FakeFathom, options: { admin?: boolean } = {}): Promise<FakeApi> {
  return startFakeApi((request: FakeRequest) => {
    if (request.headers['x-api-key'] !== KEY) return { status: 401, body: { message: 'Unauthorized' } };
    const s = state();
    const q = request.query;
    const path = request.path;
    if (request.method === 'GET' && path === '/meetings') {
      let list = [...s.meetings].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const after = q.get('created_after');
      if (after) list = list.filter((m) => Date.parse(String(m.created_at)) > Date.parse(after));
      const start = Number(q.get('cursor') ?? 0) || 0;
      const slice = list.slice(start, start + PAGE);
      return { body: { limit: PAGE, next_cursor: start + PAGE < list.length ? String(start + PAGE) : null, items: slice.map((m) => shaped(m, q)) } };
    }
    const rec = /^\/recordings\/(\d+)\/(summary|transcript)$/.exec(path);
    if (rec) {
      const m = s.meetings.find((x) => String(x.recording_id) === rec[1]);
      if (!m) return { status: 404, body: { message: 'not found' } };
      return { body: rec[2] === 'summary' ? { summary: m.default_summary ?? { template_name: null, markdown_formatted: null } } : { transcript: m.transcript ?? [] } };
    }
    if (path === '/teams') return { body: { limit: 50, next_cursor: null, items: [{ name: 'Sales', created_at: '2026-01-01T00:00:00Z' }] } };
    if (path === '/meeting_types') return { body: { limit: 50, next_cursor: null, items: [{ name: 'External', status: 'active', created_at: '2026-01-01T00:00:00Z' }] } };
    if (path === '/team_members') {
      const team = q.get('team');
      const all = [{ name: 'Dana', email: 'Dana@Acme.example', created_at: '2026-01-01T00:00:00Z' }, { name: 'Lee', email: 'lee@acme.example', created_at: '2026-01-02T00:00:00Z' }];
      const items = team === 'Empty' ? [] : all;
      const start = Number(q.get('cursor') ?? 0) || 0;
      return { body: { limit: 1, next_cursor: start + 1 < items.length ? String(start + 1) : null, items: items.slice(start, start + 1) } };
    }
    if (path === '/users') {
      if (!options.admin) return { status: 403, body: { message: 'admin only' } };
      return { body: { limit: 50, next_cursor: null, items: [{ name: 'Dana', email: 'dana@acme.example', created_at: '2026-01-01T00:00:00Z', status: 'active', permissions: {} }] } };
    }
    if (request.method === 'POST' && path === '/webhooks') {
      const b = request.body ?? {};
      if (!b.destination_url || !Array.isArray(b.triggered_for)) return { status: 400, body: { message: 'bad request' } };
      if (!b.include_summary && !b.include_action_items && !b.include_transcript && !b.include_crm_matches) return { status: 400, body: { message: 'at least one include flag' } };
      const id = `wh_${s.webhooks.size + 1}`;
      const hook = { id, url: b.destination_url, secret: `whsec_${randomBytes(24).toString('base64')}`, created_at: new Date().toISOString(), ...b };
      s.webhooks.set(id, hook);
      return { status: 201, body: hook };
    }
    const del = /^\/webhooks\/([^/]+)$/.exec(path);
    if (request.method === 'DELETE' && del) {
      if (!s.webhooks.delete(del[1])) return { status: 404, body: { message: 'not found' } };
      return { status: 204 };
    }
    return { status: 404, body: { message: 'no route' } };
  });
}
