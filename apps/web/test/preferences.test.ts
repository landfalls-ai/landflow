/** Personal preferences: defaults, a partial change, unknown keys, bad values, and each person's own. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { enableTestAuth, TEST_OWNER } from '@/lib/server/auth/test-bypass';

const previousDir = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'landflow-preferences-'));

const route = await import('@/app/api/me/preferences/route');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { readPreferences, PREFERENCE_DEFAULTS, BRIEFING_DELIVERIES } = await import('@/lib/shared/preferences');
const { preferencesSchema } = await import('@/lib/shared/preferences-schema');

const OTHER = { ...TEST_OWNER, id: 'usr_test_other', email: 'other@landflow.test', name: 'Other', role: 'member' as const };

afterAll(() => {
  enableTestAuth();
  process.env.LANDFLOW_DATA_DIR = previousDir;
});

const patch = (body: unknown) => route.PATCH(new Request('http://localhost/api/me/preferences', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const get = async () => ((await route.GET(new Request('http://localhost/api/me/preferences'))).json() as Promise<{ preferences: Record<string, unknown> }>).then((b) => b.preferences);

describe('preferences', () => {
  it('writes its defaults out, equal to the schema’s (no zod in the browser module: the production CSP)', () => {
    expect(PREFERENCE_DEFAULTS).toEqual(preferencesSchema.parse({}));
    expect(Object.keys(preferencesSchema.shape).sort()).toEqual(Object.keys(PREFERENCE_DEFAULTS).sort());
  });

  it('reads each value the way the schema does', () => {
    const samples = [true, false, 'yes', 0, null, undefined, {}, ...BRIEFING_DELIVERIES, 'carrier pigeon'];
    for (const key of Object.keys(PREFERENCE_DEFAULTS) as (keyof typeof PREFERENCE_DEFAULTS)[]) {
      for (const sample of samples) {
        const field = preferencesSchema.shape[key].safeParse(sample);
        expect(readPreferences({ [key]: sample })[key], `${key} ${String(sample)}`).toEqual(field.success ? field.data : PREFERENCE_DEFAULTS[key]);
      }
    }
  });

  it('keeps zod out of the module every page loads', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/lib/shared/preferences.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from 'zod'/);
  });

  it('answers the defaults until something is set', async () => {
    expect(await get()).toEqual({ developerDetails: false, keepConversations: true, briefingDelivery: 'none' });
  });

  it('changes only the keys it names', async () => {
    const response = await patch({ developerDetails: true });
    expect(response.status).toBe(200);
    expect((await response.json()).preferences).toEqual({ developerDetails: true, keepConversations: true, briefingDelivery: 'none' });
    await patch({ briefingDelivery: 'slack' });
    expect(await get()).toEqual({ developerDetails: true, keepConversations: true, briefingDelivery: 'slack' });
  });

  it('drops an unknown key and refuses a bad value', async () => {
    const response = await patch({ keepConversations: false, shoeSize: 42 });
    expect(response.status).toBe(200);
    const preferences = (await response.json()).preferences;
    expect(preferences.keepConversations).toBe(false);
    expect(preferences).not.toHaveProperty('shoeSize');
    expect((await patch({ briefingDelivery: 'carrier pigeon' })).status).toBe(400);
    expect((await patch({ developerDetails: 'yes' })).status).toBe(400);
    expect((await get()).keepConversations).toBe(false);
  });

  it('keeps each person their own', async () => {
    enableTestAuth(OTHER);
    try {
      expect(await get()).toEqual(PREFERENCE_DEFAULTS);
      await patch({ developerDetails: true });
    } finally {
      enableTestAuth();
    }
    expect((await get()).briefingDelivery).toBe('slack');
  });

  it('reads stored data defensively', () => {
    expect(readPreferences({ developerDetails: 'x', extra: 1, keepConversations: false })).toEqual({ developerDetails: false, keepConversations: false, briefingDelivery: 'none' });
  });

  it('is session only', () => {
    expect(routePolicy('GET', '/api/me/preferences').sessionOnly).toBe(true);
    expect(routePolicy('PATCH', '/api/me/preferences').sessionOnly).toBe(true);
  });
});
