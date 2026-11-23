/**
 * The join of practices in a run (contract run-practices and what-it-saw): PR06's real practices source behind the seam,
 * PC08's `saw` attribute, PR09's run route and PC07's context preview, on one run with a fake model. Each package tested
 * its side with fakes; here every side is real: `lib/server/runtime` is imported first (its side-effect registrations
 * replace whatever was set before them), and the practices are approved in the real store.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, ModelTurn, ToolSpec } from '@landflow/engine';
import type { PracticeDraftInput } from '@/lib/shared/practices';
import { PRACTICES_HEADING } from '@/lib/shared/practices';

vi.setConfig({ testTimeout: 30_000 });

type Step = (input: { system?: string; messages: AgentMessage[]; tools: ToolSpec[] }) => Partial<ModelTurn>;
const script: Step[] = [];
const systems: string[] = [];

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => ({
    provider: 'scripted',
    model: config?.model ?? 'm',
    async generate(input) {
      systems.push(input.system ?? '');
      const step = script.shift();
      if (!step) throw new Error('The script ran out of turns');
      return { text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, ...step(input as never) };
    },
  }),
}));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-run-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// The real registrations first: the goals source, the provider, the practices port and the practices source.
await import('@/lib/server/runtime');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { createTeamProject, setHomeProject, setMember, updateProjectBrief } = await import('@/lib/server/projects/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { decide, newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { journalOf, journalStore, releaseJournal, resetJournals } = await import('@/lib/server/journal');
const { storePort } = await import('@/lib/server/practices/register');
const { approvePractice } = await import('@/lib/server/practices/approve');
const { sawOf } = await import('@/components/run-trace/what-it-saw');
const { injectedText } = await import('@/components/agents/project-names');
const workflowsRoute = await import('@/app/api/workflows/route');
const runPracticesRoute = await import('@/app/api/executions/[id]/practices/route');
const previewRoute = await import('@/app/api/agents/[id]/context-preview/route');

const owner = await createUser({ email: 'owner@run-join.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
enableTestAuth(owner);
const project = createTeamProject({ name: 'Charts', createdBy: owner.id });
setMember(project.id, owner.id, 'admin');
updateProjectBrief(project.id, { brief: 'Keep the charts in one place.' });

const draft = (over: Partial<PracticeDraftInput>): string => {
  const input: PracticeDraftInput = { title: 'A rule', level: 'org', strength: 'recommended', topics: [], repos: [], paths: [], summary: 'A short rule', body: 'The full rule.', handle: 'x/x', ...over };
  const { practice } = storePort.draft(input, { source: 'person', actor: owner });
  approvePractice(owner, practice.id, { version: 1 });
  return practice.id;
};
const orgId = draft({ handle: 'org/plain-words', summary: 'Write in plain words' });
const projectId = draft({ handle: 'helm/chart-location', level: 'project', projectId: project.id, summary: 'Put charts in deploy/' });

const EXEC = 'exec_practices_run_join';
let agentId = '';
let workflowId = '';
const applications = (kind?: string) =>
  database().all<{ practice_id: string; kind: string }>(`SELECT practice_id, kind FROM practice_applications WHERE execution_id = ?${kind ? ' AND kind = ?' : ''}`, ...(kind ? [EXEC, kind] : [EXEC]));
const sawEvents = () => journalStore.read(EXEC).filter((e) => e.type === 'span.updated' && e.attrs && 'saw' in e.attrs);

beforeAll(async () => {
  registry.registerBuiltin(corePlugin);
  const created = await workflowsRoute.POST(new Request(`http://localhost/api/workflows?projectId=${project.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Chart check', nodes: [], connections: [] }) }));
  workflowId = ((await created.json()) as { workflow: { id: string } }).workflow.id;
  const now = new Date().toISOString();
  database().upsert('executions', { id: EXEC, workflow_id: workflowId, status: 'success', mode: 'manual', started_at: now, finished_at: now, duration_ms: 1, summary: '{}', data: '{}' });
  const agent = agentStore.create({
    name: 'Chart helper',
    instructions: 'Be brief.',
    model: { provider: 'ollama', model: 'scripted-1' },
    tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo', nodeType: 'core.noOp', parameters: {}, requireApproval: true }],
  });
  setHomeProject('agent', agent.id, project.id);
  agentId = agent.id;

  // One run in the project: a tool call that waits for approval, then the reply that cites one practice.
  const journal = journalOf(EXEC, { workflowId });
  journal.bindSpans((nodeId) => (nodeId === 'n1' ? 'node:n1:0' : undefined));
  const session = { ...newSession(agent, { source: 'workflow', userId: `workflow:${workflowId}`, version: 'draft' }), execution: { workflowId, executionId: EXEC, nodeId: 'n1', nodeName: 'Check' } };
  script.push(() => ({ toolCalls: [{ id: 'call_Echo', name: 'Echo', input: {} }] }));
  const paused = await runAgent({ agent, session, message: 'Check the chart' });
  expect(paused.session.status).toBe('awaiting_approval');
  script.push(() => ({ text: 'Done.\nPractices followed: [helm/chart-location@1]' }));
  await decide(agent, session.id, 'call_Echo', true);
  releaseJournal(EXEC);
});

afterAll(() => {
  resetJournals();
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('one agent run with approved practices', () => {
  it('the model gets the project block, a blank line, then the practices block (PR06)', () => {
    const system = systems[0]!;
    const block = system.indexOf('## Where this work fits');
    const practices = system.indexOf(PRACTICES_HEADING);
    expect(block).toBeGreaterThan(-1);
    expect(practices).toBeGreaterThan(block);
    expect(system.slice(block, practices)).toContain('Keep the charts in one place.');
    expect(system.slice(block, practices).endsWith('\n\n')).toBe(true);
    expect(system.slice(block, practices).slice(0, -2)).not.toContain('\n\n');
    expect(system).toContain('[org/plain-words@1]');
    expect(system).toContain('[helm/chart-location@1]');
    // The resume after the approval keeps the same prompt.
    expect(systems[1]).toBe(system);
  });

  it('the step’s span has one saw listing both practices, and the resume records no second (PC08)', () => {
    const events = sawEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ spanId: 'node:n1:0' });
    const saw = sawOf((events[0] as { attrs: { saw: unknown } }).attrs.saw)!;
    expect(saw.practices?.map((p) => `${p.handle}@${p.version}`).sort()).toEqual(['helm/chart-location@1', 'org/plain-words@1']);
    expect(saw.text).toContain(PRACTICES_HEADING);
  });

  it('records two delivered rows and one cited row for the run', () => {
    expect(applications('delivered').map((r) => r.practice_id).sort()).toEqual([orgId, projectId].sort());
    expect(applications('cited').map((r) => r.practice_id)).toEqual([projectId]);
  });

  it('GET /api/executions/:id/practices gives both, one cited (PR09)', async () => {
    const response = await runPracticesRoute.GET(new Request(`http://localhost/api/executions/${EXEC}/practices`), { params: Promise.resolve({ id: EXEC }) });
    expect(response.status).toBe(200);
    const { practices } = (await response.json()) as { practices: Array<{ handle: string; version: number; delivered: boolean; cited: boolean }> };
    expect(practices).toEqual([
      { handle: 'helm/chart-location', version: 1, delivered: true, cited: true },
      { handle: 'org/plain-words', version: 1, delivered: true, cited: false },
    ]);
  });

  it('GET /api/agents/:id/context-preview gives the practices text the run got and writes no row (PC07)', async () => {
    const before = database().all('SELECT id FROM practice_applications').length;
    const response = await previewRoute.GET(new Request(`http://localhost/api/agents/${agentId}/context-preview?projectId=${project.id}`), { params: Promise.resolve({ id: agentId }) });
    expect(response.status).toBe(200);
    const preview = (await response.json()) as { text: string; practices: { text: string; list: Array<{ handle: string; version: number }> } };
    expect(preview.practices.list.map((p) => `${p.handle}@${p.version}`).sort()).toEqual(['helm/chart-location@1', 'org/plain-words@1']);
    expect(preview.practices.text.startsWith(PRACTICES_HEADING)).toBe(true);
    expect(systems[0]).toContain(`\n\n${preview.practices.text}`);
    // What Test agent shows ("What it will be given") is the block then the practices, as the run has them.
    expect(injectedText(preview)).toContain(`\n\n${preview.practices.text}`);
    expect(database().all('SELECT id FROM practice_applications').length).toBe(before);
  });
});
