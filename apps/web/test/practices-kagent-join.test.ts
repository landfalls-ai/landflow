/**
 * The join of practices for a Landflow agent on kagent (PR07 ↔ PR06's practices source): with the real source, port and
 * store (`lib/server/runtime` first), a team run asks a kagent member, which opens a notebook call; while the member works
 * it calls `practices_for` on its kagent MCP server and gets the project's practices, recorded as delivered with the run's
 * execution id. The index the request carried is what `runPractices(…, size 'index')` gives. PR07's own test used a fake
 * source and port.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { AgentTeamConfig, TeamMember } from '@/lib/shared/agent-teams';
import type { PracticeDraftInput } from '@/lib/shared/practices';
import { startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeA2a } from './fake-a2a';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-kagent-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// The real registrations first (lesson 10): nothing below sets a fake source or port.
await import('@/lib/server/runtime');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { resetJournals } = await import('@/lib/server/journal/writer');
const { credentials } = await import('@/lib/server/credentials/vault');
const { storePort } = await import('@/lib/server/practices/register');
const { approvePractice } = await import('@/lib/server/practices/approve');
const { runPractices } = await import('@/lib/server/project-context/practices');
const { PRACTICES_INDEX_LINE } = await import('@/lib/server/practices/remote');
const mcpRoute = await import('@/app/api/mcp/agents/[id]/route');

registry.registerBuiltin(corePlugin);

const owner = await createUser({ email: 'owner@kagent-join.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
enableTestAuth(owner);
const project = createTeamProject({ name: 'Charts', createdBy: owner.id });
const elsewhere = createTeamProject({ name: 'Elsewhere', createdBy: owner.id });
setMember(project.id, owner.id, 'admin');
setMember(elsewhere.id, owner.id, 'admin');

const approve = (over: Partial<PracticeDraftInput>): string => {
  const input: PracticeDraftInput = { title: 'A rule', level: 'project', strength: 'recommended', topics: [], repos: [], paths: [], summary: 'A short rule', body: 'The full rule.', handle: 'x/x', ...over };
  const { practice } = storePort.draft(input, { source: 'person', actor: owner });
  approvePractice(owner, practice.id, { version: 1 });
  return practice.id;
};
const chartId = approve({ handle: 'helm/chart-location', projectId: project.id, summary: 'Put charts in deploy/', body: 'Every chart lives under deploy/helm.' });
approve({ handle: 'ops/elsewhere-only', projectId: elsewhere.id });

type Body = { model: string; messages: Array<{ role: string; content: string }> };
let leadTurn = 0;
const fake = await startFakeModels({
  reply: (_provider, body: Body): FakeReply | undefined => {
    if (body.model !== 'kagent-join-lead') return undefined;
    leadTurn++;
    if (leadTurn === 1) return { toolCalls: [{ id: 'p1', name: 'ask_planner', arguments: { message: 'Plan the chart work', reason: 'Plan' } }] };
    return { text: 'done' };
  },
});
const a2a = await startFakeA2a();

const TOKEN = 'lfk_kagent_join_token';
const remote = agentStore.create({ name: 'Planner on kagent', instructions: 'Plan.' });
agentStore.publish(remote.id);
agentStore.setKagent(remote.id, { credential: { id: 'cred', name: 'kind' }, name: 'kagent-join-remote', version: 1, token: credentials.sealSecret(TOKEN), trace: { url: 'http://x', a2aUrl: a2a.url } } as never);
setHomeProject('agent', remote.id, elsewhere.id);
const lead = agentStore.create({ name: 'Lead', instructions: 'Lead.', model: { provider: 'ollama', model: 'kagent-join-lead', baseUrl: fake.url.replace(/\/v1$/, '') } });
agentStore.publish(lead.id);
setHomeProject('agent', lead.id, project.id);

/** `practices_for` on the agent's kagent MCP server, as the agent would call it. */
async function practicesFor(args: Record<string, unknown>) {
  const request = new Request(`http://localhost/api/mcp/agents/${remote.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'practices_for', arguments: args } }),
  });
  const raw = await (await (mcpRoute.POST as unknown as (r: Request, c: unknown) => Promise<Response>)(request, { params: Promise.resolve({ id: remote.id }) })).text();
  const rpc = JSON.parse(raw.includes('data:') ? raw.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : raw) as { result?: { content?: Array<{ text: string }>; isError?: boolean } };
  return rpc.result!;
}

afterAll(async () => {
  enableTestAuth();
  await fake.close();
  await a2a.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const textOf = (c: { params: { message?: { parts?: Array<{ text?: string }> } } }) => (c.params.message?.parts?.[0]?.text ?? '').replace(/^<!-- landflow-trace [^>]*-->\n*/, '');

describe('a team run with a kagent member', () => {
  it('the member’s practices_for gives the run’s project practices, recorded with its execution id; the index is runPractices’', async () => {
    const members: TeamMember[] = [
      { id: 'm_lead', title: 'Lead', kind: 'agent', agentId: lead.id },
      { id: 'm_plan', title: 'Planner', kind: 'a2a', reportsTo: 'm_lead', role: 'Plans', parameters: { agentUrl: a2a.url } } as TeamMember,
    ];
    const team = agentTeamStore.create({ name: 'Chart team', goal: 'Ship charts', members } satisfies AgentTeamConfig);
    agentTeamStore.publish(team.id);
    setHomeProject('agentTeam', team.id, project.id);

    // While the member works (its notebook call is open), it reads its practices over MCP.
    const answers: Array<Awaited<ReturnType<typeof practicesFor>>> = [];
    a2a.mod = async (text) => {
      answers.push(await practicesFor({}));
      return text;
    };

    const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
    const wf: Workflow = {
      id: 'wf_kagent_join',
      name: 'Chart team flow',
      nodes: [node('Start', 'core.manualTrigger'), node('Team', 'core.runTeam', { teamId: team.id, message: 'Do it' })],
      connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Team', sourceIndex: 0, targetIndex: 0 }],
    };
    store.saveWorkflow(wf);
    setHomeProject('workflow', wf.id, project.id);
    const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
    resetJournals();
    a2a.mod = undefined;
    expect(record.error?.message ?? record.status).toBe('success');

    // practices_for: the run's project (not the agent's home), in full.
    expect(answers).toHaveLength(1);
    expect(answers[0]!.isError).toBeFalsy();
    const given = JSON.parse(answers[0]!.content![0]!.text) as { practices: Array<{ handle: string; body: string }> };
    expect(given.practices.map((p) => p.handle)).toEqual(['helm/chart-location']);
    expect(given.practices[0]!.body).toContain('Every chart lives under deploy/helm.');
    const delivered = database().all<{ practice_id: string; execution_id: string; agent_id: string }>("SELECT practice_id, execution_id, agent_id FROM practice_applications WHERE kind = 'delivered'");
    expect(delivered.filter((r) => r.agent_id === remote.id)).toEqual([{ practice_id: chartId, execution_id: record.executionId, agent_id: remote.id }]);
    // The lead runs in-process and gets the same practice in its prompt (PR06), on the same run.
    expect(delivered.filter((r) => r.agent_id === lead.id)).toEqual([{ practice_id: chartId, execution_id: record.executionId, agent_id: lead.id }]);

    // The index PR07 sent with the request is the practices source's index for the same run.
    const index = runPractices(undefined, { projectId: project.id, agentId: remote.id, task: 'Plan the chart work', size: 'index' });
    expect(index.practices).toEqual([{ handle: 'helm/chart-location', version: 1 }]);
    const sent = a2a.calls.filter((c) => c.method === 'SendMessage' || c.method === 'SendStreamingMessage').map(textOf);
    expect(sent[0]).toContain(`${index.text}\n\n${PRACTICES_INDEX_LINE}`);
    expect(sent[0]).not.toContain('ops/elsewhere-only');
  });
});
