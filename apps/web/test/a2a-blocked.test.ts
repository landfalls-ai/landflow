/**
 * C05, the A2A path: a remote task that fails on a provider quota is Blocked, not a generic failure. The A2A node, an
 * agent's A2A tool and a team member call carry the kind and message; the Run Trace shows a Blocked badge; an ordinary
 * failure stays ordinary.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runNode } from '@landflow/sdk';
import type { ExecutionEvent, Workflow, WorkflowNode } from '@landflow/engine';
import type { JournalDraft } from '@/lib/shared/run-trace';
import type { AgentTeamConfig, TeamMember } from '@/lib/shared/agent-teams';
import { startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeA2a, type FakeA2a } from './fake-a2a';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-a2a-blocked-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { a2aAgentNode } = await import('@/lib/server/nodes/a2a');
const { a2aAgentTool } = await import('@/lib/server/agents/tools');
const { blockedOf, blockedCounts, countBlocked, ProviderBlockedError } = await import('@/lib/server/a2a/blocked');
const { createTranslator, journalStore, resetJournals } = await import('@/lib/server/journal');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
await import('@/lib/server/runtime');

registry.registerBuiltin(corePlugin);

let fake: FakeA2a;
let models: Awaited<ReturnType<typeof startFakeModels>>;
type Body = { model: string; messages: Array<{ role: string; content: string }> };
let leadScript: (turn: number, body: Body) => FakeReply = () => ({ text: 'done' });
let leadTurns = 0;
beforeAll(async () => {
  fake = await startFakeA2a();
  models = await startFakeModels({ reply: (_provider, body: Body) => leadScript(++leadTurns, body) });
});
afterAll(async () => {
  await fake.close();
  await models.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const task = (parts: Array<Record<string, unknown>>, state = 'TASK_STATE_FAILED') => ({ id: 't1', contextId: 'c1', status: { state, message: { messageId: 'm', role: 'ROLE_AGENT', parts } } }) as never;

describe('blockedOf', () => {
  it('reads codex_error_info from a status data part', () => {
    expect(blockedOf(task([{ text: 'stopped' }, { data: { codex_error_info: 'usage_limit_exceeded' } }]))).toMatchObject({ blocked: true, kind: 'usage_limit' });
  });
  it('reads a usage-limit sentence', () => {
    expect(blockedOf(task([{ text: "You've hit your usage limit." }]))).toMatchObject({ blocked: true, kind: 'usage_limit' });
  });
  it('reads the error fields of the task metadata', () => {
    const t = { ...(task([{ text: 'stopped' }]) as object), metadata: { error: { codex_error_info: 'usage_limit_exceeded', rate_limit_reached_type: 'workspace_member_credits_depleted' } } } as never;
    expect(blockedOf(t)).toMatchObject({ blocked: true, kind: 'credits_depleted' });
  });
  it('is not blocked for a completed task or an ordinary failure', () => {
    expect(blockedOf(task([{ text: 'usage limit' }], 'TASK_STATE_COMPLETED'))).toEqual({ blocked: false });
    expect(blockedOf(task([{ text: 'model not supported' }]))).toEqual({ blocked: false });
  });
});

describe('countBlocked', () => {
  it('tallies by kind and harness', () => {
    countBlocked('usage_limit', 'a2a');
    countBlocked('usage_limit', 'a2a');
    expect(blockedCounts().find((c) => c.kind === 'usage_limit' && c.harness === 'a2a')?.count).toBe(2);
  });
});

describe('the A2A node', () => {
  const params = (message: string, extra: Record<string, unknown> = {}) => ({ agentUrl: fake.url, authentication: 'none', options: { timeout: 5_000 }, operation: 'sendMessage', message, ...extra });
  const call = (message: string, extras: Record<string, unknown> = {}, onRecord?: (r: unknown) => void) => {
    const p = params(message);
    return runNode(
      a2aAgentNode,
      { protocol: 'landflow.plugin/v1', executionId: 'ex_b', workflowId: 'wf_b', mode: 'manual', node: { id: 'n1', name: 'Codex', type: 'core.a2aAgent', typeVersion: 1 }, parameters: p, itemParameters: [p], inputs: [[{ json: {} }]], ...extras } as never,
      undefined,
    ).then((response) => ({ response, onRecord }));
  };

  it('fails as Blocked with the kind in words and the provider message, and records the warn check', async () => {
    const { response } = await call('fail-limit');
    expect(response.error?.message).toBe('fake-agent: Codex usage limit reached');
    expect(response.records?.some((r) => r.type === 'check' && r.name === 'blocked' && r.status === 'warn' && r.message === 'Blocked by a provider limit' && r.subject === 'fake-agent')).toBe(true);
  });

  it('with continue on fail, the item says blocked and why', async () => {
    const { response } = await call('fail-credits', { continueOnFail: true });
    expect(response.outputs[0][0].json).toMatchObject({ blocked: true, blockedKind: 'credits_depleted' });
  });

  it('a usage-limit sentence without the field is Blocked too', async () => {
    const { response } = await call('fail-limit-text');
    expect(response.error?.message).toBe('fake-agent: Codex usage limit reached');
  });

  it('an ordinary failure stays a generic failure, with no check', async () => {
    const { response } = await call('fail-model');
    expect(response.error?.message).toBe('fake-agent: the task failed');
    expect(response.records?.some((r) => r.type === 'check')).toBeFalsy();
  });
});

describe('an agent A2A tool', () => {
  const toolContext = (progress: (r: unknown) => void) => ({ agent: { id: 'agt_1', name: 'Caller' }, session: { id: 'ses_b', remoteContexts: {} }, runId: 'run_1', signal: new AbortController().signal, approvals: 'ask', progress }) as never;
  const build = async () => {
    const built = await a2aAgentTool({ id: 'cap_b', name: 'Codex', parameters: { agentUrl: fake.url, authentication: 'none', options: { timeout: 5_000 } } } as never);
    if ('error' in built) throw new Error(built.error);
    return built;
  };

  it('throws ProviderBlockedError with the kind and reports state blocked', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const tool = await build();
    const error = await tool.invoke({ message: 'fail-limit' }, toolContext((r) => seen.push(r as Record<string, unknown>))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderBlockedError);
    expect((error as InstanceType<typeof ProviderBlockedError>).kind).toBe('usage_limit');
    expect(seen.at(-1)).toMatchObject({ state: 'blocked', blocked: { kind: 'usage_limit' } });
  });

  it('keeps an ordinary failure ordinary', async () => {
    const tool = await build();
    const error = await tool.invoke({ message: 'fail-model' }, toolContext(() => {})).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ProviderBlockedError);
    expect((error as Error).message).toContain('the task failed');
  });
});

describe('the Run Trace', () => {
  const workflow: Workflow = { id: 'wf_b', name: 'b', nodes: [{ id: 'trigger', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} } as WorkflowNode, { id: 'codex', name: 'Codex', type: 'core.a2aAgent', typeVersion: 1, position: [0, 0], parameters: {} } as WorkflowNode], connections: [] };
  it('ends the span error with attrs.blocked', () => {
    const drafts: JournalDraft[] = [];
    const translator = createTranslator({ workflow, executionId: 'ex_b', emit: (d) => drafts.push(d) });
    const at = (s: number) => new Date(Date.UTC(2026, 10, 21, 9, 0, s)).toISOString();
    const events = [
      { type: 'execution.started', executionId: 'ex_b', workflowId: 'wf_b', mode: 'manual', traceId: 't', at: at(0) },
      { type: 'node.started', executionId: 'ex_b', nodeId: 'codex', nodeName: 'Codex', source: 'main', at: at(1) },
      { type: 'node.progress', executionId: 'ex_b', nodeId: 'codex', nodeName: 'Codex', data: { agent: 'fake-agent', state: 'blocked', blocked: { kind: 'usage_limit', message: 'out' }, steps: [] }, at: at(2) },
      { type: 'execution.finished', executionId: 'ex_b', status: 'error', durationMs: 3, error: { nodeId: 'codex', message: 'fake-agent: Codex usage limit reached' }, at: at(3) },
    ] as unknown as ExecutionEvent[];
    for (const e of events) translator.feed(e);
    const ended = drafts.find((d) => d.type === 'span.ended' && d.spanId.includes('codex')) as Extract<JournalDraft, { type: 'span.ended' }>;
    expect(ended.status).toBe('error');
    expect(ended.attrs).toMatchObject({ blocked: { kind: 'usage_limit', message: 'out' } });
  });
});

describe('a team with a blocked remote member', () => {
  it('records a Blocked warn check naming the member, and tells the lead it was blocked', async () => {
    const lead = agentStore.create({ name: 'Lead', instructions: 'Lead.', model: { provider: 'ollama', model: 'c05-lead', baseUrl: models.url.replace(/\/v1$/, '') } });
    agentStore.publish(lead.id);
    const members: TeamMember[] = [
      { id: 'm_lead', title: 'Lead', kind: 'agent', agentId: lead.id },
      { id: 'm_codex', title: 'Coder', kind: 'a2a', reportsTo: 'm_lead', role: 'Codes', parameters: { agentUrl: fake.url } } as TeamMember,
    ];
    const config: AgentTeamConfig = { name: 'Blocked team', goal: 'Ship it', members };
    const team = agentTeamStore.create(config);
    agentTeamStore.publish(team.id);
    let toolResult = '';
    leadTurns = 0;
    leadScript = (turn, body) => {
      if (turn === 1) return { toolCalls: [{ id: 'b1', name: 'ask_coder', arguments: { message: 'fail-limit', reason: 'Code' } }] };
      toolResult = body.messages.map((m) => m.content).join('\n');
      return { text: 'ok' };
    };
    const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
    const wf: Workflow = {
      id: 'wf_c05',
      name: 'team',
      nodes: [node('Start', 'core.manualTrigger'), node('Team', 'core.runTeam', { teamId: team.id, message: 'Do it' })],
      connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Team', sourceIndex: 0, targetIndex: 0 }],
    };
    store.saveWorkflow(wf);
    const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
    const events = journalStore.readAll(record.executionId);
    resetJournals();
    expect(events.find((e) => e.type === 'check' && e.check.name === 'Blocked')).toMatchObject({ check: { status: 'warn', subject: 'Coder', message: 'Coder: Codex usage limit reached' } });
    expect(toolResult).toContain('Codex usage limit reached');
    expect(toolResult).toContain('not a failure of its work');
  });
});
