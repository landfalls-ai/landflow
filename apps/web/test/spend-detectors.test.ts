/**
 * SP13: the waste detectors (docs/second-brain.md#4-detectors-and-suggestions). Each fires on a seeded case and stays quiet on
 * its near miss; evidence holds numbers, part and tool names and hash prefixes, never text, a person or a prompt.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-detectors-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession } = await import('@/lib/server/agents/runtime');
const { DETECTOR_RUNS, detectContext } = await import('@/lib/server/brain/detectors');
const { upsertProposal, dismissProposal } = await import('@/lib/server/brain/proposals');
const { recordUsage, dayOf } = await import('@/lib/server/usage/ledger');
const { DETECTORS, DETECTOR_LABELS } = await import('@/lib/shared/brain');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const DAY = 86_400_000;
const NOW = Date.now();
let counter = 0;
const reset = () => {
  const db = database();
  for (const [table, column] of [['ai_usage', 'at'], ['ai_call_parts', 'at'], ['usage_events', 'at'], ['proposals', 'created_at']] as const) db.deleteBefore(table, column, '9999');
};
beforeEach(reset);

interface CallInput {
  agent?: string;
  workflow?: string;
  session?: string;
  execution?: string;
  daysAgo?: number;
  provider?: string;
  model?: string;
  input?: number;
  output?: number;
  read?: number;
  write?: number;
  cost?: number;
  surface?: string;
  iteration?: number;
  parts?: Record<string, number>;
  tools?: string[];
  prompt?: string;
  gatewayProvider?: string;
  source?: 'landflow' | 'gateway';
}

function call(c: CallInput) {
  const id = `au_sp13_${++counter}`;
  const at = new Date(NOW - (c.daysAgo ?? 0) * DAY - counter).toISOString();
  const input = c.input ?? 1000;
  database().insertNew('ai_usage', {
    id,
    at,
    day: dayOf(Date.parse(at)),
    operation: 'chat',
    provider: c.provider ?? 'anthropic',
    model: c.model ?? 'claude-x',
    input_tokens: input,
    output_tokens: c.output ?? 50,
    cache_read_tokens: c.read ?? 0,
    cache_write_tokens: c.write ?? 0,
    cost: c.cost ?? (c.provider && c.provider.startsWith('ollama') ? 0 : 0.01),
    agent_id: c.agent ?? null,
    workflow_id: c.workflow ?? null,
    session_id: c.session ?? null,
    execution_id: c.execution ?? null,
    surface: c.surface ?? null,
    iteration: c.iteration ?? null,
    gateway_provider: c.gatewayProvider ?? null,
    source: 'landflow',
  });
  if (c.parts || c.tools || c.prompt) {
    database().insertNew('ai_call_parts', {
      id: `acp_${id}`,
      usage_id: id,
      at,
      source: c.source ?? 'landflow',
      method: 'estimate',
      input_tokens: input,
      parts: JSON.stringify(c.parts ?? { instructions: input }),
      prompt_hash: c.prompt ?? null,
      tool_names: c.tools ? JSON.stringify(c.tools) : null,
    });
  }
  return id;
}
const many = (n: number, make: (i: number) => CallInput) => Array.from({ length: n }, (_, i) => call(make(i)));

const agent = (name: string, extra: Record<string, unknown> = {}) =>
  agentStore.create({ name, instructions: 'Be brief.', model: { provider: 'anthropic', model: 'claude-x' }, ...extra } as never);
const workflow = (id: string, nodes: Workflow['nodes'] = []) => store.saveWorkflow({ id, name: `Flow ${id}`, active: false, nodes, connections: [] } as unknown as Workflow);
const run = (id: keyof typeof DETECTOR_RUNS, quiet: Record<string, number> = {}) => DETECTOR_RUNS[id](detectContext(quiet, database(), NOW));

/** What a proposal would show: it must hold no text of a prompt and no person. */
const serialized = (found: unknown) => JSON.stringify(found);

describe('registration', () => {
  it('the six detectors are registered and labeled', () => {
    for (const id of ['context-bloat', 'fat-tool-results', 'unused-tools', 'cache-misses', 'repeated-calls', 'agent-loops'] as const) {
      expect(DETECTORS).toContain(id);
      expect(DETECTOR_LABELS[id]).toBeTruthy();
      expect(DETECTOR_RUNS[id]).toBeTypeOf('function');
    }
  });
});

describe('context-bloat', () => {
  const seed = (a: { id: string }, now: number, before: number, over = 3000, base = 1000, extra: Partial<CallInput> = {}) => {
    many(before, (i) => ({ agent: a.id, session: `s_b${i}`, daysAgo: 10, input: base, parts: { instructions: 300, history: base - 300 }, ...extra }));
    many(now, (i) => ({ agent: a.id, session: `s_n${i}`, daysAgo: 2, input: over, parts: { instructions: 300, history: over - 300 }, ...extra }));
  };
  it('fires when the median passes 1.5x with 20+ calls each, and names the part that grew', () => {
    const a = agent('Bloaty');
    seed(a, 20, 20);
    const found = run('context-bloat');
    expect(found).toHaveLength(1);
    expect(found[0].proposal.target).toMatchObject({ type: 'agent', id: a.id });
    expect(serialized(found)).toContain('Conversation so far');
    expect(found[0].proposal.evidence.find((e) => e.label === 'Runs this week')?.value).toBe(20);
  });
  it('is quiet on 19 calls and on a 1.4x rise', () => {
    const a = agent('Near');
    seed(a, 19, 20);
    expect(run('context-bloat')).toEqual([]);
    reset();
    const b = agent('Rise');
    seed(b, 20, 20, 1400);
    expect(run('context-bloat')).toEqual([]);
  });
  it('ignores Spotlight rows and does not judge formatting on Ollama', () => {
    const a = agent('Spot');
    seed(a, 20, 20, 3000, 1000, { surface: 'spotlight' });
    expect(run('context-bloat')).toEqual([]);
    reset();
    const b = agent('Local');
    many(20, (i) => ({ agent: b.id, session: `l_b${i}`, daysAgo: 10, provider: 'ollama', input: 1000, parts: { instructions: 800, formatting: 200 } }));
    many(20, (i) => ({ agent: b.id, session: `l_n${i}`, daysAgo: 2, provider: 'ollama', input: 1600, parts: { instructions: 800, formatting: 800 } }));
    // The reported input rose, but the rise is formatting: with it left out the median is flat.
    expect(run('context-bloat')).toEqual([]);
  });
  it('counts distinct runs in its evidence', () => {
    const a = agent('Runs');
    many(20, (i) => ({ agent: a.id, session: 's_old', daysAgo: 10, input: 1000, parts: { history: 1000 } }));
    many(20, (i) => ({ agent: a.id, session: i < 10 ? 's_a' : 's_b', daysAgo: 2, input: 3000, parts: { history: 3000 } }));
    const found = run('context-bloat');
    expect(found[0].proposal.evidence.find((e) => e.label === 'Runs this week')?.value).toBe(2);
  });
});

describe('fat-tool-results', () => {
  it('fires over 40% on 20+ calls and is quiet at 39% and at 19 calls', () => {
    const a = agent('Fat');
    many(20, (i) => ({ agent: a.id, session: `f${i}`, input: 1000, parts: { toolResults: 410, instructions: 590 } }));
    expect(run('fat-tool-results')).toHaveLength(1);
    reset();
    const b = agent('Lean');
    many(20, (i) => ({ agent: b.id, session: `f${i}`, input: 1000, parts: { toolResults: 390, instructions: 610 } }));
    expect(run('fat-tool-results')).toEqual([]);
    reset();
    const c = agent('Few');
    many(19, (i) => ({ agent: c.id, session: `f${i}`, input: 1000, parts: { toolResults: 800, instructions: 200 } }));
    expect(run('fat-tool-results')).toEqual([]);
  });
});

describe('unused-tools', () => {
  const session = (a: { id: string }, id: string, tools: string[]) => {
    const s = newSession(a as never, { source: 'test', userId: 'u', version: 'draft' });
    agentStore.saveSession({ ...s, id, timeline: tools.map((t, i) => ({ id: `e${i}`, type: 'tool', callId: `c${i}`, tool: t, label: t, kind: 'node', input: { secret: 'never read' }, status: 'success', at: new Date().toISOString() })) } as never);
  };
  it('names a tool sent on 50+ calls and never called, reading names only', () => {
    const a = agent('Tooly');
    session(a, 'as_t1', ['Search']);
    many(50, () => ({ agent: a.id, session: 'as_t1', daysAgo: 20, parts: { toolDefinitions: 100 }, tools: ['Search', 'Fax'] }));
    const found = run('unused-tools');
    expect(found).toHaveLength(1);
    const text = serialized(found);
    expect(text).toContain('Fax');
    expect(text).not.toContain('Search,');
    expect(text).not.toContain('never read');
  });
  it('is quiet at 49 calls, when every tool was called, and for a kagent agent', () => {
    const a = agent('Few');
    session(a, 'as_t2', ['Search']);
    many(49, () => ({ agent: a.id, session: 'as_t2', parts: { toolDefinitions: 100 }, tools: ['Fax'] }));
    expect(run('unused-tools')).toEqual([]);
    reset();
    const b = agent('Used');
    session(b, 'as_t3', ['Fax']);
    many(50, () => ({ agent: b.id, session: 'as_t3', parts: { toolDefinitions: 100 }, tools: ['Fax'] }));
    expect(run('unused-tools')).toEqual([]);
    reset();
    const c = agent('Kube');
    agentStore.setKagent(c.id, { name: 'kube', namespace: 'x' } as never);
    session(c, 'as_t4', ['Search']);
    many(50, () => ({ agent: c.id, session: 'as_t4', parts: { toolDefinitions: 100 }, tools: ['Fax'] }));
    expect(run('unused-tools')).toEqual([]);
  });
});

describe('cache-misses', () => {
  it('fires under 20% on 20+ Anthropic calls and names the most common reason', () => {
    const a = agent('Cold');
    many(20, (i) => ({ agent: a.id, session: `c${i % 4}`, read: 0, write: 0, input: 1000, parts: { instructions: 200 } }));
    const found = run('cache-misses');
    expect(found).toHaveLength(1);
    expect(found[0].proposal.evidence.find((e) => e.label === 'Most common reason')?.value).toBe('below-minimum');
  });
  it('is quiet at a hit rate of 21% and at 19 calls', () => {
    const a = agent('Warm');
    many(20, (i) => ({ agent: a.id, session: `c${i}`, read: 210, input: 1000 }));
    expect(run('cache-misses')).toEqual([]);
    reset();
    const b = agent('Few');
    many(19, (i) => ({ agent: b.id, session: `c${i}`, read: 0, input: 1000 }));
    expect(run('cache-misses')).toEqual([]);
  });
});

describe('repeated-calls', () => {
  it('fires on 5 identical prompts in a day and reports distinct runs; quiet at 4', () => {
    const w = workflow('wf_rep');
    many(5, (i) => ({ workflow: w.id, execution: `ex${i % 3}`, prompt: 'abcdef0123456789', parts: { instructions: 100 } }));
    const found = run('repeated-calls');
    expect(found).toHaveLength(1);
    expect(found[0].proposal.why).toContain('5 identical prompts in 3 runs');
    expect(serialized(found)).toContain('abcdef01');
    expect(serialized(found)).not.toContain('abcdef0123456789');
    reset();
    many(4, (i) => ({ workflow: w.id, execution: `ex${i}`, prompt: 'abcdef0123456789', parts: { instructions: 100 } }));
    expect(run('repeated-calls')).toEqual([]);
  });
  it('does not join prompts of different days', () => {
    const w = workflow('wf_rep2');
    many(3, (i) => ({ workflow: w.id, execution: `a${i}`, prompt: 'hashhashhash', daysAgo: 1, parts: { instructions: 1 } }));
    many(3, (i) => ({ workflow: w.id, execution: `b${i}`, prompt: 'hashhashhash', daysAgo: 4, parts: { instructions: 1 } }));
    expect(run('repeated-calls')).toEqual([]);
  });
});

describe('agent-loops', () => {
  const ended = (agentId: string, session: string, reason: string) => recordUsage({ kind: 'agent.session', agentId, attrs: { session, status: 'idle', reason } });
  it('fires on 3 sessions at max_iterations; quiet on 2', () => {
    const a = agent('Looper');
    for (const s of ['s1', 's2', 's3']) {
      ended(a.id, s, 'max_iterations');
      call({ agent: a.id, session: s, iteration: 1 });
    }
    const found = run('agent-loops');
    expect(found).toHaveLength(1);
    expect(found[0].proposal.target).toMatchObject({ type: 'agent', id: a.id });
    reset();
    for (const s of ['s1', 's2']) ended(a.id, s, 'max_iterations');
    expect(run('agent-loops')).toEqual([]);
  });
  it('fires when the highest iteration is over 3x the median', () => {
    const a = agent('Runaway');
    for (const [i, top] of [2, 2, 3, 2, 12].entries()) call({ agent: a.id, session: `r${i}`, iteration: top });
    expect(run('agent-loops')).toHaveLength(1);
  });
});

describe('evidence and the proposals pipeline', () => {
  it('holds no text, no person and no prompt', () => {
    const a = agent('Plain');
    many(20, (i) => ({ agent: a.id, session: `p${i}`, input: 1000, parts: { toolResults: 600, instructions: 400 }, prompt: 'deadbeefdeadbeef' }));
    const found = [...run('fat-tool-results'), ...run('repeated-calls')];
    expect(found.length).toBeGreaterThan(0);
    const text = serialized(found);
    expect(text).not.toContain('deadbeefdeadbeef');
    expect(text).not.toMatch(/user_id|userId|@/);
    for (const f of found) expect(f.proposal.ops).toEqual([]);
  });
  it('a dismissed suggestion is held back', () => {
    const a = agent('Held');
    many(20, (i) => ({ agent: a.id, session: `h${i}`, input: 1000, parts: { toolResults: 600, instructions: 400 } }));
    const [first] = run('fat-tool-results');
    const saved = upsertProposal(first.proposal, database(), NOW);
    expect(saved).toBeDefined();
    dismissProposal(saved!.id, 'intended');
    expect(upsertProposal(first.proposal, database(), NOW)).toBeUndefined();
  });
  it('a quiet factor raises the thresholds', () => {
    const a = agent('Quiet');
    many(20, (i) => ({ agent: a.id, session: `q${i}`, input: 1000, parts: { toolResults: 600, instructions: 400 } }));
    expect(run('fat-tool-results')).toHaveLength(1);
    expect(run('fat-tool-results', { 'fat-tool-results': 2 })).toEqual([]);
  });
});

describe('ai-cost on a local model', () => {
  const flow = (model: string) => workflow('wf_local', [{ id: 'n1', name: 'Ask', type: 'core.ollama', parameters: { model }, position: [0, 0] } as never]);
  const seed = (n: number, model = 'qwen3-coder:30b') => many(n, () => ({ workflow: 'wf_local', provider: 'ollama', model, input: 500, output: 40 }));
  it('names a smaller local model seen here, and nothing without one', () => {
    flow('qwen3-coder:30b');
    seed(20);
    expect(run('ai-cost').filter((f) => f.proposal.title.includes('qwen'))).toEqual([]);
    call({ workflow: 'other', provider: 'ollama', model: 'qwen3-coder:8b' });
    const found = run('ai-cost').filter((f) => f.proposal.target.id === 'wf_local');
    expect(found).toHaveLength(1);
    expect(found[0].proposal.title).toContain('qwen3-coder:8b');
    expect(found[0].proposal.effect ?? '').not.toMatch(/\$/);
    expect(found[0].proposal.ops).toEqual([{ op: 'setParameters', node: 'Ask', parameters: { model: 'qwen3-coder:8b' } }]);
  });
  it('does not pick another family, needs 20 calls, and leaves a priced model to the dollar path', () => {
    flow('qwen3-coder:30b');
    call({ workflow: 'other', provider: 'ollama', model: 'llama3:8b' });
    seed(20);
    expect(run('ai-cost').filter((f) => f.proposal.target.id === 'wf_local')).toEqual([]);
    reset();
    call({ workflow: 'other', provider: 'ollama', model: 'qwen3-coder:8b' });
    seed(19);
    expect(run('ai-cost').filter((f) => f.proposal.target.id === 'wf_local')).toEqual([]);
  });
  it('ignores Spotlight rows and gateway names for the same model', () => {
    flow('qwen3-coder:30b');
    call({ workflow: 'other', provider: 'ollama', model: 'qwen3-coder:8b' });
    many(20, () => ({ workflow: 'wf_local', provider: 'ollama', model: 'qwen3-coder:30b', surface: 'spotlight', output: 40 }));
    expect(run('ai-cost').filter((f) => f.proposal.target.id === 'wf_local')).toEqual([]);
    reset();
    call({ workflow: 'other', provider: 'ollama', model: 'qwen3-coder:8b' });
    many(20, () => ({ workflow: 'wf_local', provider: 'litellm', gatewayProvider: 'ollama_chat', model: 'ollama_chat/qwen3-coder:30b', cost: 0, output: 40 }));
    expect(run('ai-cost').filter((f) => f.proposal.target.id === 'wf_local')).toHaveLength(1);
  });
});
