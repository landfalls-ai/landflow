/** Final live run 2, item 5: the credentials page counts agents (a tool or model credential) as users: "Used by 1 agent", not "Not used yet". */
import { beforeAll, describe, expect, it } from 'vitest';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { credentialUsageLine } from '@/lib/shared/credential-usage';

const { credentials } = await import('@/lib/server/credentials/vault');
const { agentStore } = await import('@/lib/server/agents/store');
const route = await import('@/app/api/credentials/route');

beforeAll(() => registry.registerBuiltin(corePlugin));

describe('credential usage', () => {
  it('names workflows and agents in one line', () => {
    expect(credentialUsageLine([], [])).toBe('Not used yet');
    expect(credentialUsageLine([{}], [])).toBe('Used by 1 workflow');
    expect(credentialUsageLine([], [{}])).toBe('Used by 1 agent');
    expect(credentialUsageLine([{}, {}], [{}])).toBe('Used by 2 workflows and 1 agent');
  });
  it('GET /api/credentials lists the agents whose tool uses a credential', async () => {
    const cred = credentials.create({ name: 'Sales DB', type: 'core.httpHeaderAuth', data: { name: 'x', value: 'y' } });
    const other = credentials.create({ name: 'Unused', type: 'core.httpHeaderAuth', data: { name: 'x', value: 'y' } });
    const agent = agentStore.create({ name: 'Summary', tools: [{ id: 't1', type: 'node', name: 'sqlite', description: 'x', nodeType: 'core.httpRequest', parameters: {}, credentials: { httpHeaderAuth: { id: cred.id, name: cred.name } } } as never] });
    const body = (await (await route.GET(new Request('http://localhost/api/credentials'))).json()) as { credentials: Array<{ id: string; usedByAgents: Array<{ agentId: string; agentName: string }>; usedBy: unknown[] }> };
    expect(body.credentials.find((c) => c.id === cred.id)?.usedByAgents).toEqual([{ agentId: agent.id, agentName: 'Summary' }]);
    expect(body.credentials.find((c) => c.id === other.id)?.usedByAgents).toEqual([]);
  });
});
