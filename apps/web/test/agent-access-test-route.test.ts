import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/agents/[id]/access/test/route';
import { PUT as saveAgent } from '@/app/api/agents/[id]/route';
import { agentStore, configOf } from '@/lib/server/agents/store';

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

  it('knows the task source: a rule that matches it is answered and saved', async () => {
    const agent = makeAgent();
    const rule = { id: 'r', tool: '*', who: { source: 'task' }, effect: 'deny' };
    expect((await call(agent.id, { caller: { ...caller, source: 'task' }, rules: [rule] })).status).toBe(200);
    const saved = await saveAgent(
      new Request(`http://localhost/api/agents/${agent.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...configOf(agent), access: { rules: [rule] } }) }),
      { params: Promise.resolve({ id: agent.id }) },
    );
    expect(saved.status).toBe(200);
    expect(agentStore.get(agent.id)!.access?.rules[0].who.source).toBe('task');
  });
});
