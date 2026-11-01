/** GET /api/agents/:id/sessions?executionId=: the full sessions a workflow run (and one node of it) started. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-agent-exec-'));
const previous = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = dataDir;

const { agentStore } = await import('@/lib/server/agents/store');
const { newSession } = await import('@/lib/server/agents/runtime');
const route = await import('@/app/api/agents/[id]/sessions/route');

afterAll(() => {
  if (previous === undefined) delete process.env.LANDFLOW_DATA_DIR;
  else process.env.LANDFLOW_DATA_DIR = previous;
});

const get = (id: string, query = '') => route.GET(new Request(`http://landflow.test/api/agents/${id}/sessions${query}`), { params: Promise.resolve({ id }) });

describe('sessions of an execution', () => {
  it('returns the full sessions of an execution, optionally of one node', async () => {
    const agent = agentStore.create({ name: 'Tech Lead', instructions: 'Lead.' });
    const make = (execution?: { workflowId: string; executionId: string; nodeId: string }) => {
      const session = newSession(agent, { source: 'workflow', userId: 'workflow:wf_1', version: 'draft' });
      if (execution) session.execution = execution;
      session.timeline.push({ id: `e_${session.id}`, type: 'user', text: 'go', at: new Date().toISOString() });
      return agentStore.saveSession(session);
    };
    const a = make({ workflowId: 'wf_1', executionId: 'ex_1', nodeId: 'n1' });
    const b = make({ workflowId: 'wf_1', executionId: 'ex_1', nodeId: 'n2' });
    make({ workflowId: 'wf_1', executionId: 'ex_2', nodeId: 'n1' });
    make();

    const all = await (await get(agent.id, '?executionId=ex_1')).json();
    expect(all.sessions.map((s: { id: string }) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(all.sessions[0].timeline).toHaveLength(1);

    const one = await (await get(agent.id, '?executionId=ex_1&nodeId=n2')).json();
    expect(one.sessions.map((s: { id: string }) => s.id)).toEqual([b.id]);

    expect((await (await get(agent.id, '?executionId=nope')).json()).sessions).toEqual([]);
    // Without the filter it is still the summary list.
    expect((await (await get(agent.id)).json()).sessions).toHaveLength(4);
    expect((await get('ag_missing', '?executionId=ex_1')).status).toBe(404);
  });
});
