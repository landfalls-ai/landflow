/**
 * Practices in Landflow agent runs (docs/practices.md#landflow-agents): the block after the project block, delivered and
 * cited rows, the switch, and the unchanged prompt. A fake model and a fake port with made-up practices.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, ModelTurn, ToolSpec } from '@landflow/engine';
import type { Agent, AgentConfig } from '@/lib/shared/agents';
import type { ContextDataSource } from '@/lib/shared/project-context';
import type { ApprovedPractice } from '@/lib/shared/practices';

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

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore, configOf } = await import('@/lib/server/agents/store');
const { setHomeProject } = await import('@/lib/server/projects/store');
const { decide, newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { personaPrompt } = await import('@/lib/shared/persona');
// The host boots lazily and its runtime imports the goals and practices sources; load it first so the fakes set below win.
await import('@/lib/server/runtime');
const { setContextDataSource, setPracticesSource } = await import('@/lib/server/project-context/seam');
const { setPracticesPort } = await import('@/lib/server/practices/port');
const { selectForRun } = await import('@/lib/server/practices/context-source');
const { runPractices } = await import('@/lib/server/project-context/practices');

const source: ContextDataSource = {
  mission: () => undefined,
  project: (id) => ({ id, name: 'Flow project', brief: 'Flow brief.', goalIds: [] }),
  goalChain: () => [],
};

const practice = (handle: string, extra: Partial<ApprovedPractice> = {}): ApprovedPractice => ({
  id: `prc_${handle.replace('/', '_')}`,
  handle,
  title: handle,
  level: 'org',
  strength: 'recommended',
  topics: [],
  repos: [],
  paths: [],
  version: 1,
  summary: `Rule ${handle}`,
  body: 'Body',
  checks: [],
  sha256: 'x',
  approvedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});
const all = [
  practice('org/everywhere'),
  practice('wf/local', { level: 'project', projectId: 'p_wf', version: 3 }),
  practice('other/local', { level: 'project', projectId: 'p_other', version: 2 }),
  practice('org/repo-only', { repos: ['acme/api'] }),
];
const recorded: Array<Record<string, unknown>> = [];
const portOn = () => process.env.LANDFLOW_PRACTICES !== 'off';

const reply = (text: string): Step => () => ({ text });
const makeAgent = (config: Partial<AgentConfig> = {}): Agent => {
  const agent = agentStore.create({ name: 'Helper', instructions: 'Be brief.', model: { provider: 'ollama', model: 'scripted-1' }, ...config });
  setHomeProject('agent', agent.id, 'p_wf');
  return agent;
};
const testSession = (agent: Agent) => newSession(agent, { source: 'test', userId: 'you', version: 'draft' });
const rows = (kind: string) => recorded.filter((r) => r.kind === kind);

beforeAll(() => registry.registerBuiltin(corePlugin));
beforeEach(() => {
  script.length = 0;
  systems.length = 0;
  recorded.length = 0;
  setContextDataSource(source);
  setPracticesSource({ select: selectForRun });
  setPracticesPort({
    enabled: portOn,
    draft: () => {
      throw new Error('not used');
    },
    approved: ({ projectIds }) => (portOn() ? all.filter((p) => p.level === 'org' || (projectIds !== 'all' && projectIds.includes(p.projectId!))) : []),
    record: (row) => void recorded.push({ ...row }),
  });
});
afterEach(() => {
  setContextDataSource(undefined);
  setPracticesSource(undefined);
  setPracticesPort(undefined);
  delete process.env.LANDFLOW_PRACTICES;
});

describe('practices in an agent run', () => {
  it('gives the project block, then the org and project practices, and records two delivered rows', async () => {
    const agent = makeAgent();
    script.push(reply('ok'));
    const result = await runAgent({ agent, session: testSession(agent), message: 'hi' });
    const system = systems[0]!;
    expect(system).toContain('- [org/everywhere@1]');
    expect(system).toContain('- [wf/local@3]');
    expect(system).not.toContain('other/local');
    expect(system).not.toContain('org/repo-only');
    expect(system).toMatch(/Flow brief\.[^\n]*\n(?:[^\n]*\n)*?\n## Practices to follow/);
    expect(system.indexOf('## Where this work fits')).toBeLessThan(system.indexOf('## Practices to follow'));
    expect(result.session.context?.practices.map((p) => p.handle).sort()).toEqual(['org/everywhere', 'wf/local']);
    expect(rows('delivered').map((r) => r.practiceId).sort()).toEqual(['prc_org_everywhere', 'prc_wf_local']);
    expect(rows('delivered').every((r) => r.agentId === agent.id)).toBe(true);
  });

  it('gives a run in another project the org practice only; a project context Off still gets practices', async () => {
    const agent = makeAgent({ projectContext: 'off' });
    setHomeProject('agent', agent.id, 'p_other');
    script.push(reply('ok'));
    await runAgent({ agent, session: testSession(agent), message: 'hi' });
    expect(systems[0]).not.toContain('## Where this work fits');
    expect(systems[0]).toContain('- [org/everywhere@1]');
    expect(systems[0]).toContain('- [other/local@2]');
    expect(systems[0]).not.toContain('wf/local');
  });

  it('is byte for byte the old prompt with the switch off, LANDFLOW_PRACTICES=off, or no source', async () => {
    const agent = makeAgent({ projectContext: 'off' });
    const old = () => personaPrompt(configOf(agent), { now: new Date(/Current date and time: (\S+Z)\./.exec(systems.at(-1)!)![1]!) });
    script.push(reply('1'), reply('2'), reply('3'), reply('4'));
    await runAgent({ agent: { ...agent, practices: 'off' }, session: testSession(agent), message: 'hi' });
    expect(systems.at(-1)).toBe(old());
    process.env.LANDFLOW_PRACTICES = 'off';
    await runAgent({ agent, session: testSession(agent), message: 'hi' });
    expect(systems.at(-1)).toBe(old());
    delete process.env.LANDFLOW_PRACTICES;
    setPracticesSource(undefined);
    await runAgent({ agent, session: testSession(agent), message: 'hi' });
    expect(systems.at(-1)).toBe(old());
    expect(recorded).toEqual([]);
    setPracticesSource({ select: selectForRun });
    await runAgent({ agent, session: testSession(agent), message: 'hi' });
    expect(systems.at(-1)).not.toBe(old());
  });

  it('writes no second delivered row on a resume and keeps the same prompt', async () => {
    const agent = makeAgent({ tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo', nodeType: 'core.noOp', parameters: {}, requireApproval: true }] });
    script.push(() => ({ toolCalls: [{ id: 'call_Echo', name: 'Echo', input: {} }] }));
    const paused = await runAgent({ agent, session: testSession(agent), message: 'go' });
    expect(rows('delivered')).toHaveLength(2);
    script.push(reply('done'));
    await decide(agent, paused.session.id, 'call_Echo', true);
    expect(systems[1]).toBe(systems[0]);
    expect(rows('delivered')).toHaveLength(2);
  });

  it('records one cited row for a given practice, none for one the run was not given', async () => {
    const agent = makeAgent();
    script.push(reply('Done.\nPractices followed: [wf/local@3], [other/local@2], [org/everywhere@9]'));
    await runAgent({ agent, session: testSession(agent), message: 'hi' });
    expect(rows('cited').map((r) => r.practiceId)).toEqual(['prc_wf_local']);
  });

  it('keeps only valid switch values in the agent config', () => {
    expect(makeAgent({ practices: 'off' }).practices).toBe('off');
    expect(makeAgent({ practices: 'bogus' as never }).practices).toBeUndefined();
  });

  it('runPractices never throws when the source throws', () => {
    setPracticesSource({
      select: () => {
        throw new Error('boom');
      },
    });
    expect(runPractices(undefined, { size: 'full' })).toEqual({ text: '', practices: [] });
  });
});
