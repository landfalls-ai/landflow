import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/agents/[id]/access/test/route';
import { agentStore } from '@/lib/server/agents/store';

const call = (id: string, body: unknown) =>
  POST(new Request(`http://localhost/api/agents/${id}/access/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const caller = { id: 'u_1', role: 'member', source: 'api' };
const makeAgent = () => agentStore.create({ name: 'Desk', instructions: 'Help.', model: { provider: 'ollama', model: 'x' } });

describe('POST /api/agents/:id/access/test', () => {
  it('answers for an agent, with unsaved rules, and without calling anything', async () => {
    const response = await call(makeAgent().id, { caller, rules: [{ id: 'r', tool: '*', who: {}, effect: 'deny' }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ decisions: [] });
  });

  it('refuses an unknown agent and a malformed caller', async () => {
    expect((await call('ag_missing', { caller })).status).toBe(404);
    expect((await call(makeAgent().id, { caller: { id: 'u', source: 'nowhere' } })).status).toBe(400);
  });
});
