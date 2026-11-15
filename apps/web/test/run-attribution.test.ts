/**
 * Every run knows its project and goal (PC05): the project and goal on the usage scope, on the `ai_usage` row and on the
 * `ai.call` usage event, taken over onto an imported spend row, filtered on GET /api/usage/events, and told on the run span.
 * The meter is the real one over a temp database; the provider and data source are fakes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { ContextDataSource, RunContext, RunContextProvider } from '@/lib/shared/project-context';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-run-attribution-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { database } = await import('@/lib/server/db');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { aiUsageMeter, agentScope, assistantScope, executionScope } = await import('@/lib/server/ai-usage');
const { UsageScope, runInUsageScope } = await import('@/lib/server/ai-usage/scope');
const { gatewayHeaders } = await import('@/lib/server/llm-gateway/call');
const { createTeamProject, setHomeProject } = await import('@/lib/server/projects/store');
const { setContextDataSource, setRunContextProvider, withRunContext } = await import('@/lib/server/project-context/seam');
const { recordUsage } = await import('@/lib/server/usage/ledger');
const { listUsageEvents } = await import('@/lib/server/usage/query');
const { spanEvents } = await import('@/lib/server/journal/store');
const eventsRoute = await import('@/app/api/usage/events/route');

registry.registerBuiltin(corePlugin);
const projectA = createTeamProject({ name: 'Project A' });
const projectB = createTeamProject({ name: 'Project B' });
setHomeProject('agent', 'ag_home_a', projectA.id);
setHomeProject('workflow', 'wf_home_a', projectA.id);

afterAll(() => {
  setRunContextProvider(undefined);
  setContextDataSource(undefined);
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const call = (extra: Record<string, unknown> = {}) => ({ provider: 'openai', model: 'gpt-test', operation: 'chat', inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.001, ...extra });
const usageRow = (where: string, ...params: string[]) => database().get<Record<string, unknown>>(`SELECT * FROM ai_usage WHERE ${where}`, ...params);
const context = (projectId: string, goalId?: string): RunContext => ({ projectId, ...(goalId && { goalId }), mode: 'full', text: '', compact: '', line: '', hash: '', at: new Date().toISOString(), practices: [] });
const meter = aiUsageMeter();

describe('the usage scope', () => {
  it('an execution scope writes the run project and goal on the row and the event', () => {
    const scope = executionScope({ executionId: 'ex_1', workflowId: 'wf_home_a', projectId: projectB.id, goalId: 'g_1' }, meter);
    meter.record(call() as never, scope);
    expect(usageRow('execution_id = ?', 'ex_1')).toMatchObject({ project_id: projectB.id, goal_id: 'g_1' });
    expect(listUsageEvents({ goalId: 'g_1' })).toMatchObject([{ kind: 'ai.call', projectId: projectB.id, goalId: 'g_1', executionId: 'ex_1' }]);
  });

  it('an agent run in project B of an agent at home in A writes B, and the gateway tags name B', () => {
    const scope = withRunContext(context(projectB.id, 'g_2'), () => agentScope({ agentId: 'ag_home_a', agentName: 'Home A', sessionId: 's_1', settings: {} }, meter));
    meter.record(call() as never, scope);
    expect(usageRow('session_id = ?', 's_1')).toMatchObject({ project_id: projectB.id, goal_id: 'g_2' });
    const headers = gatewayHeaders(scope, { portalHeaders: false });
    expect(headers['x-litellm-tags']).toContain(`landflow-project:${projectB.id}`);
    expect(headers['x-litellm-tags']).not.toContain(projectA.id);
  });

  it('an agent without a run context keeps its home project and no goal', () => {
    const scope = agentScope({ agentId: 'ag_home_a', agentName: 'Home A', sessionId: 's_2', settings: {} }, meter);
    meter.record(call() as never, scope);
    expect(usageRow('session_id = ?', 's_2')).toMatchObject({ project_id: projectA.id, goal_id: null });
  });

  it('a nested scope gets the nearest project and goal, and a goal never pairs with another project', () => {
    const outer = executionScope({ executionId: 'ex_3', workflowId: 'wf_home_a', projectId: projectB.id, goalId: 'g_3' }, meter);
    const inner = new UsageScope({ agentId: 'ag_x', sessionId: 's_3', projectId: projectA.id, goalId: 'g_inner' }, [], outer);
    meter.record(call() as never, inner);
    expect(usageRow('session_id = ?', 's_3')).toMatchObject({ project_id: projectA.id, goal_id: 'g_inner' });
    // The run context's goal is for the run's project only.
    const other = new UsageScope({ agentId: 'ag_home_a', sessionId: 's_4' }, [], undefined, meter);
    withRunContext(context(projectB.id, 'g_4'), () => meter.record(call() as never, other));
    expect(usageRow('session_id = ?', 's_4')).toMatchObject({ project_id: projectA.id, goal_id: null });
  });

  it('a goal from an outer scope is not paired with an inner scope that names another project', () => {
    const outer = executionScope({ executionId: 'ex_6', workflowId: 'wf_home_a', projectId: projectB.id, goalId: 'g_6' }, meter);
    meter.record(call() as never, new UsageScope({ agentId: 'ag_x', sessionId: 's_6', projectId: projectA.id }, [], outer));
    expect(usageRow('session_id = ?', 's_6')).toMatchObject({ project_id: projectA.id, goal_id: null });
    const parent = executionScope({ executionId: 'ex_7', workflowId: 'wf_home_a', projectId: projectB.id, goalId: 'g_7' }, meter);
    runInUsageScope(parent, () => meter.record(call() as never, executionScope({ executionId: 'ex_8', workflowId: 'wf_home_a', projectId: projectA.id }, meter)));
    expect(usageRow('execution_id = ?', 'ex_8')).toMatchObject({ project_id: projectA.id, goal_id: null });
  });

  it('assistantScope with a workflowId gets the workflow home project', () => {
    const scope = assistantScope({ surface: 'spotlight', workflowId: 'wf_home_a' }, meter);
    expect(scope.lookup('projectId')).toBe(projectA.id);
    expect(assistantScope({ surface: 'brain' }, meter).lookup('projectId')).toBeUndefined();
    expect(assistantScope({ surface: 'brain', projectId: projectB.id, workflowId: 'wf_home_a' }, meter).lookup('projectId')).toBe(projectB.id);
  });

  it('a spend row the import read first gets the goal; the import keeps its own event', () => {
    const db = database();
    db.insertNew('ai_usage', { id: 'au_ll_imp', at: new Date().toISOString(), day: meter.today(), source: 'litellm', runtime: 'landflow', provider: 'openai', model: 'gpt-test', operation: 'chat', input_tokens: 12, output_tokens: 8, cost: 0.002, gateway_request_id: 'req_1' });
    const scope = executionScope({ executionId: 'ex_5', workflowId: 'wf_home_a', projectId: projectB.id, goalId: 'g_5' }, meter);
    meter.record(call({ gatewayRequestId: 'req_1' }) as never, scope);
    expect(usageRow('id = ?', 'au_ll_imp')).toMatchObject({ project_id: projectB.id, goal_id: 'g_5', execution_id: 'ex_5' });
    expect(listUsageEvents({ goalId: 'g_5' })).toEqual([]);
  });

  it('a run without a provider writes nulls, as before', () => {
    const scope = new UsageScope({ surface: 'brain' }, [], undefined, meter);
    meter.record(call() as never, scope);
    expect(usageRow("surface = 'brain'")).toMatchObject({ project_id: null, goal_id: null });
  });
});

describe('the usage events', () => {
  it('GET /api/usage/events filters by goal and project', async () => {
    const get = async (query: string) => ((await (await eventsRoute.GET(new Request(`http://localhost/api/usage/events?${query}`))).json()) as { events: { goalId?: string; projectId?: string }[] }).events;
    const byGoal = await get('goalId=g_1');
    expect(byGoal).toHaveLength(1);
    expect(byGoal[0]).toMatchObject({ goalId: 'g_1', projectId: projectB.id });
    expect((await get(`projectId=${projectB.id}&kinds=ai.call`)).every((e) => e.projectId === projectB.id)).toBe(true);
    expect(await get('goalId=g_missing')).toEqual([]);
  });

  it('private work of another person never shows', () => {
    recordUsage({ kind: 'ai.call', goalId: 'g_private', projectId: projectB.id, ownerId: 'u_other', visibility: 'private' });
    expect(listUsageEvents({ goalId: 'g_private' }, { scope: { viewerId: 'u_me', workflows: new Set(), agents: new Set(), entities: new Set() } })).toEqual([]);
    expect(listUsageEvents({ goalId: 'g_private' }, { scope: { viewerId: 'u_other', workflows: new Set(), agents: new Set(), entities: new Set() } })).toHaveLength(1);
  });
});

describe('the run', () => {
  it('puts the project and goal on the run span and on its usage scope', async () => {
    const provider: RunContextProvider = { resolve: () => ({ projectId: projectB.id, goalId: 'g_run' }), build: () => context(projectB.id, 'g_run') };
    const data: ContextDataSource = { mission: () => undefined, project: (id) => ({ id, name: 'Project B', goalIds: [] }), goalChain: () => [{ id: 'g_run', title: 'Ship it', level: 'project', status: 'active' }] };
    setRunContextProvider(provider);
    setContextDataSource(data);
    const workflow: Workflow = { id: 'wf_span', name: 'Span', nodes: [{ id: 't', name: 't', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [], settings: {} } as never;
    store.saveWorkflow(workflow);
    const record = await runWorkflow({ workflow, mode: 'manual', startNodeId: 't' });
    const find = () => spanEvents(record.executionId).find((e) => e.type === 'span.updated' && e.spanId === 'run' && e.attrs?.project);
    for (let i = 0; i < 100 && !find(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    const updated = find();
    expect(updated).toMatchObject({ attrs: { project: { id: projectB.id, name: 'Project B' }, goal: { id: 'g_run', title: 'Ship it' } } });
  });
});
