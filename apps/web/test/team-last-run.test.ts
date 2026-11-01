/**
 * The team page's run panel (GET /api/agent-teams/:id/last-run, docs/agent-teams.md#budgets): a run going on comes
 * first, read from the team node's live progress, with who works now; every member with a budget is listed, and one its
 * manager never asked says so.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-team-last-run-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const running = { executions: [] as Array<{ id: string; record: unknown; progress: Record<string, { data: unknown }> }> };
vi.mock('@/lib/server/runner', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  liveExecutions: () => running.executions.map((e) => ({ id: e.id })),
  liveExecution: (id: string) => running.executions.find((e) => e.id === id)?.record,
  liveProgress: (id: string) => running.executions.find((e) => e.id === id)?.progress ?? {},
}));

const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { GET } = await import('@/app/api/agent-teams/[id]/last-run/route');

const read = async (id: string) => (await (await GET(new Request(`http://localhost/api/agent-teams/${id}/last-run`), { params: Promise.resolve({ id }) })).json()) as { run?: Record<string, unknown> & { members: Array<Record<string, unknown>> } };

describe('the team page while a run goes on', () => {
  it('reads the live run from its progress, lists who works and who was not asked, with each budget', async () => {
    const team = agentTeamStore.create({
      name: 'Desk',
      goal: 'Notes',
      members: [
        { id: 'm_lead', title: 'Editor', kind: 'agent', agentId: 'ag_a' },
        { id: 'm_w', title: 'Writer', kind: 'agent', agentId: 'ag_b', reportsTo: 'm_lead', budgetTokens: 100_000 },
        { id: 'm_f', title: 'Fact checker', kind: 'agent', agentId: 'ag_c', reportsTo: 'm_lead', budgetTokens: 60_000 },
      ],
    });
    // Unpublished: the page reads the draft's budgets.
    expect((await read(team.id)).run).toBeUndefined();

    running.executions.push({
      id: 'ex_live',
      record: { executionId: 'ex_live', workflowId: 'wf_1', workflowName: 'Release Notes', status: 'running', startedAt: '2026-11-01T12:00:00.000Z', runData: {}, workflow: { nodes: [{ id: 'n_team', name: 'Team', type: 'core.runTeam', parameters: { teamId: team.id } }] } },
      progress: {
        n_team: {
          data: {
            member: 'Writer',
            agent: 'Writer',
            state: 'working',
            stepCount: 2,
            steps: [],
            team: { lead: 'Editor', members: [{ title: 'Editor', state: 'working', asked: 1 }, { title: 'Writer', state: 'working', asked: 1 }, { title: 'Fact checker', state: 'idle', asked: 0 }] },
            turns: [],
            moments: [{ at: 1000, member: 'Editor', tone: 'info', text: 'Asked the Writer' }],
            usage: [{ member: 'Editor', tokens: 9_000 }, { member: 'Writer', tokens: 41_000, budget: 100_000 }],
            at: 65_000,
          },
        },
      },
    });
    const { run } = await read(team.id);
    expect(run).toMatchObject({ executionId: 'ex_live', live: true, member: 'Writer', durationMs: 65_000, workflowName: 'Release Notes' });
    expect(run!.members).toEqual([
      { title: 'Editor', tokens: 9_000 },
      { title: 'Writer', tokens: 41_000, budgetTokens: 100_000, working: true },
      { title: 'Fact checker', tokens: 0, budgetTokens: 60_000, notAsked: true },
    ]);
    running.executions.length = 0;
  });
});
