/**
 * Work events and the person's own briefing (docs/work-and-briefings.md): POST/DELETE /api/brain/work, GET
 * /api/brain/briefing, the instance time zone, the brain:read and brain:write scopes, and the brain being off.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasScope } from '@/lib/shared/auth';
import type { Briefing } from '@/lib/shared/brain-work';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-work-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { updateSettings } = await import('@/lib/server/settings');
const workRoute = await import('@/app/api/brain/work/route');
const workItemRoute = await import('@/app/api/brain/work/[sourceId]/route');
const briefingRoute = await import('@/app/api/brain/briefing/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const settingsRoute = await import('@/app/api/settings/route');
const { dayBefore } = await import('@/lib/server/brain/briefing');

const owner = await createUser({ email: 'owner@work.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const alice = await createUser({ email: 'alice@work.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const bob = await createUser({ email: 'bob@work.test', name: 'Bob', role: 'member', password: 'bob-password-1' });

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  if (previousEnv.LANDFLOW_BRAIN === undefined) delete process.env.LANDFLOW_BRAIN;
  else process.env.LANDFLOW_BRAIN = previousEnv.LANDFLOW_BRAIN;
});

const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://work.test${url}`, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const post = (events: unknown[], headers?: Record<string, string>) => workRoute.POST(req('POST', '/api/brain/work', { events }, headers));
const briefing = async (day: string, headers?: Record<string, string>) => (await (await briefingRoute.GET(req('GET', `/api/brain/briefing?day=${day}`, undefined, headers))).json()) as Briefing;
const remove = (source: string, sourceId: string, headers?: Record<string, string>) =>
  workItemRoute.DELETE(req('DELETE', `/api/brain/work/${encodeURIComponent(sourceId)}?source=${source}`, undefined, headers), { params: Promise.resolve({ sourceId }) });

const event = (sourceId: string, patch: Record<string, unknown> = {}) => ({
  kind: 'work.session',
  source: 'claude-code',
  sourceId,
  occurredAt: '2026-11-13T09:30:00.000Z',
  title: `Session ${sourceId}`,
  ...patch,
});
const rows = () => database().all<{ id: string; owner_id: string; visibility: string; source: string; source_id: string; at: string; message: string; attrs: string }>("SELECT * FROM usage_events WHERE kind LIKE 'work.%' ORDER BY at");

beforeEach(() => {
  database().deleteBefore('usage_events', 'at', '9999');
  updateSettings({ timezone: 'UTC' });
  delete process.env.LANDFLOW_BRAIN;
  enableTestAuth(alice);
});

describe('POST /api/brain/work', () => {
  it('saves valid events, rejects an invalid one with its reason, and keeps them private to the caller', async () => {
    const response = await post([
      event('s1', { repo: 'acme/billing', areas: ['services/worker'], commits: 2, prs: [{ url: 'https://github.com/acme/billing/pull/9?token=abc', state: 'opened' }] }),
      event('s2'),
      event('bad', { areas: ['src/app.ts'] }),
    ]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { saved: Array<{ sourceId: string; id: string; created: boolean }>; rejected: Array<{ sourceId: string; reason: string }> };
    expect(body.saved.map((s) => [s.sourceId, s.created])).toEqual([['s1', true], ['s2', true]]);
    expect(body.rejected).toEqual([{ sourceId: 'bad', reason: expect.stringContaining('file name') }]);
    const stored = rows();
    expect(stored).toHaveLength(2);
    expect(stored.every((r) => r.owner_id === alice.id && r.visibility === 'private' && r.source === 'claude-code')).toBe(true);
    const attrs = JSON.parse(stored[0].attrs) as Record<string, unknown>;
    expect(attrs).toMatchObject({ actor: 'alice@work.test', repo: 'acme/billing', areas: 'services/worker', commits: 2, prs: 1, prUrl: 'https://github.com/acme/billing/pull/9' });
  });

  it('redacts on the server, whatever the client sent', async () => {
    await post([event('s1', { title: 'Mailed bob@work.test about invoice 4821903', summary: 'token=sk_live_abcdefgh12345678' })]);
    const [row] = rows();
    expect(row.message).toBe('Mailed <email> about invoice <n>');
    expect(row.attrs).not.toContain('sk_live');
    expect(row.attrs).not.toContain('bob@work.test');
  });

  it('updates the event when the same source and sourceId come again (one row, created false)', async () => {
    const first = (await (await post([event('s1', { title: 'First title' })])).json()) as { saved: Array<{ id: string }> };
    const second = (await (await post([event('s1', { title: 'Second title', occurredAt: '2026-11-13T11:00:00.000Z' })])).json()) as { saved: Array<{ id: string; created: boolean }> };
    expect(second.saved).toEqual([{ sourceId: 's1', id: first.saved[0].id, created: false }]);
    const stored = rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ message: 'Second title', at: '2026-11-13T11:00:00.000Z' });
    // Another person's event with the same ids is another event.
    enableTestAuth(bob);
    await post([event('s1')]);
    expect(rows()).toHaveLength(2);
  });

  it('refuses team and org visibility for now, and declares the kind on first use', async () => {
    const body = (await (await post([event('s1', { visibility: 'team' }), event('s2', { visibility: 'org' }), event('s3', { visibility: 'private' })])).json()) as { saved: unknown[]; rejected: Array<{ reason: string }> };
    expect(body.saved).toHaveLength(1);
    expect(body.rejected.map((r) => r.reason)).toEqual(['Sharing comes later: send it as private for now', 'Sharing comes later: send it as private for now']);
    expect(database().get<{ kind: string }>("SELECT kind FROM usage_kinds WHERE kind = 'work.session'")).toBeTruthy();
  });

  it('declares only listed kinds itself: an unknown one is rejected, an already declared custom one is accepted', async () => {
    const body = (await (await post([event('k1', { kind: 'work.junk_one' })])).json()) as { saved: unknown[]; rejected: Array<{ reason: string }> };
    expect(body.saved).toHaveLength(0);
    expect(body.rejected.map((r) => r.reason)).toEqual(['Unknown work kind; an admin can declare it']);
    expect(database().get("SELECT kind FROM usage_kinds WHERE kind = 'work.junk_one'")).toBeUndefined();
    const at = new Date().toISOString();
    database().upsert('usage_kinds', { kind: 'work.custom_thing', description: '', fields: '[]', project_id: null, created_by: null, created_at: at, updated_at: at });
    const again = (await (await post([event('k2', { kind: 'work.custom_thing' })])).json()) as { saved: unknown[] };
    expect(again.saved).toHaveLength(1);
  });

  it('answers 400 for no events or more than 50', async () => {
    expect((await post([])).status).toBe(400);
    expect((await post(Array.from({ length: 51 }, (_, i) => event(`s${i}`)))).status).toBe(400);
  });

  it('answers 503 when the brain is off', async () => {
    process.env.LANDFLOW_BRAIN = 'false';
    expect((await post([event('s1')])).status).toBe(503);
    expect((await remove('claude-code', 's1')).status).not.toBe(503);
    const off = await briefing('2026-11-13');
    expect(off).toMatchObject({ brain: 'off', today: [], yesterday: [] });
  });
});

describe('DELETE /api/brain/work/:sourceId', () => {
  it('removes only the caller’s own event; another person’s is not found', async () => {
    await post([event('s1')]);
    enableTestAuth(bob);
    expect((await remove('claude-code', 's1')).status).toBe(404);
    expect(rows()).toHaveLength(1);
    enableTestAuth(alice);
    expect((await remove('claude-code', 's1')).status).toBe(204);
    expect(rows()).toHaveLength(0);
    expect((await remove('claude-code', 's1')).status).toBe(404);
    // The source is required.
    const missing = await workItemRoute.DELETE(req('DELETE', '/api/brain/work/s1'), { params: Promise.resolve({ sourceId: 's1' }) });
    expect(missing.status).toBe(400);
  });
});

describe('GET /api/brain/briefing', () => {
  it('lists the caller’s own today and yesterday, newest first, and nobody else’s', async () => {
    await post([
      event('a-old', { occurredAt: '2026-11-12T08:00:00.000Z', title: 'Yesterday morning' }),
      event('a-new', { occurredAt: '2026-11-13T15:00:00.000Z', title: 'Today afternoon', repo: 'acme/billing', areas: ['docs', 'services/api'], url: 'https://example.com/s/1?x=1' }),
      event('a-mid', { occurredAt: '2026-11-13T09:00:00.000Z', title: 'Today morning' }),
      event('a-ancient', { occurredAt: '2026-11-10T09:00:00.000Z', title: 'Three days ago' }),
    ]);
    enableTestAuth(bob);
    await post([event('b-1', { occurredAt: '2026-11-13T10:00:00.000Z', title: 'Bob’s work' })]);
    enableTestAuth(alice);
    const mine = await briefing('2026-11-13');
    expect(mine).toMatchObject({ day: '2026-11-13', source: 'live', related: [], autoSend: 'allowed', brain: 'on' });
    expect(mine.today.map((i) => i.title)).toEqual(['Today afternoon', 'Today morning']);
    expect(mine.yesterday.map((i) => i.title)).toEqual(['Yesterday morning']);
    expect(mine.today[0]).toMatchObject({ sourceId: 'a-new', source: 'claude-code', kind: 'work.session', repo: 'acme/billing', areas: ['docs', 'services/api'], url: 'https://example.com/s/1', visibility: 'private' });
    expect((await briefing('2026-11-13')).today.some((i) => i.title === 'Bob’s work')).toBe(false);
    enableTestAuth(owner);
    expect((await briefing('2026-11-13')).today).toEqual([]);
  });

  it('counts days in the instance time zone', async () => {
    updateSettings({ timezone: 'Asia/Tokyo' });
    await post([event('late', { occurredAt: '2026-11-13T16:30:00.000Z', title: 'After midnight in Tokyo' })]);
    expect((await briefing('2026-11-14')).today.map((i) => i.title)).toEqual(['After midnight in Tokyo']);
    expect((await briefing('2026-11-13')).today).toEqual([]);
    expect((await briefing('2026-11-15')).yesterday.map((i) => i.title)).toEqual(['After midnight in Tokyo']);
  });

  it('defaults to today and takes the admin’s auto-send setting', async () => {
    const now = (await (await briefingRoute.GET(req('GET', '/api/brain/briefing'))).json()) as Briefing;
    expect(now.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    updateSettings({ brain: { workAutoSend: 'forbidden' } });
    expect((await briefing('2026-11-13')).autoSend).toBe('forbidden');
    updateSettings({ brain: { workAutoSend: 'allowed' } });
    expect((await briefing('2026-11-13')).autoSend).toBe('allowed');
    // An admin sets it through the settings route.
    enableTestAuth(owner);
    const patched = await settingsRoute.PATCH(req('PATCH', '/api/settings', { brain: { workAutoSend: 'forbidden' } }));
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { settings: { brain: unknown } }).settings.brain).toEqual({ workAutoSend: 'forbidden' });
    enableTestAuth(alice);
    expect((await briefing('2026-11-13')).autoSend).toBe('forbidden');
    updateSettings({ brain: { workAutoSend: 'allowed' } });
    expect((await briefingRoute.GET(req('GET', '/api/brain/briefing?day=yesterday'))).status).toBe(400);
  });

  it('steps back a calendar day across month and year ends', () => {
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(dayBefore('2027-01-01')).toBe('2026-12-31');
  });
});

describe('API key scopes', () => {
  it('brain:write includes brain:read, and neither reaches anything else', async () => {
    expect(hasScope(['brain:write'], 'brain:read')).toBe(true);
    expect(hasScope(['brain:read'], 'brain:write')).toBe(false);
    expect(hasScope(['workflows:write'], 'brain:write')).toBe(false);
    expect(hasScope(['admin'], 'brain:write')).toBe(true);

    const writer = createApiKey(alice, { label: 'mod', scopes: ['brain:write'] });
    const reader = createApiKey(alice, { label: 'brief', scopes: ['brain:read'] });
    const builder = createApiKey(alice, { label: 'build', scopes: ['workflows:read', 'workflows:write', 'executions:read'] });
    const bearer = (key: { token: string }) => ({ authorization: `Bearer ${key.token}` });

    expect((await post([event('k1')], bearer(writer))).status).toBe(200);
    expect((await briefingRoute.GET(req('GET', '/api/brain/briefing?day=2026-11-13', undefined, bearer(writer)))).status).toBe(200);
    expect((await workflowsRoute.GET(req('GET', '/api/workflows', undefined, bearer(writer)))).status).toBe(403);

    expect((await briefingRoute.GET(req('GET', '/api/brain/briefing?day=2026-11-13', undefined, bearer(reader)))).status).toBe(200);
    expect((await post([event('k2')], bearer(reader))).status).toBe(403);

    expect((await post([event('k3')], bearer(builder))).status).toBe(403);
    expect((await briefingRoute.GET(req('GET', '/api/brain/briefing?day=2026-11-13', undefined, bearer(builder)))).status).toBe(403);
    expect(rows().map((r) => r.source_id)).toEqual(['k1']);
  });
});
