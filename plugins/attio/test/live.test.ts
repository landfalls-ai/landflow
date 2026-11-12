/** Against a real Attio workspace: skipped unless LANDFLOW_INTEGRATION contains "attio" and ATTIO_TOKEN is set (a dev workspace; read-only here). */
import { describe, expect, it } from 'vitest';
import { Attio } from '../src/nodes/attio';
import { attioApi } from '../src/api';
import { jsonOf, run } from './helpers';

const enabled = (process.env.LANDFLOW_INTEGRATION ?? '').split(/[,\s]+/).includes('attio') && Boolean(process.env.ATTIO_TOKEN);

describe.skipIf(!enabled)('Attio (live)', () => {
  const credentials = { attioApi: { accessToken: process.env.ATTIO_TOKEN ?? '', baseUrl: process.env.ATTIO_BASE_URL ?? 'https://api.attio.com' } };

  it('the credential test passes', async () => {
    const result = await attioApi.test!(credentials.attioApi, { http: fetch } as never);
    expect(result).toMatchObject({ ok: true });
  });

  it('lists members and companies changed in the last 30 days', async () => {
    const members = jsonOf(await run(Attio, { resource: 'workspaceMember', operation: 'getAll' }, { credentials }));
    expect(members.length).toBeGreaterThan(0);
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const items = jsonOf(await run(Attio, { resource: 'record', operation: 'getManyChangedSince', object: 'companies', since, detect: 'created', limit: 5 }, { credentials }));
    for (const item of items) expect(item).toMatchObject({ source: 'attio' });
  });
});
