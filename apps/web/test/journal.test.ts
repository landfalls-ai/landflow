/**
 * The Run Trace journal (lib/server/journal): the translator on an event sequence shaped like a multi-agent run (an agent
 * node with a model, a memory, a remote-agent delegate whose steps include a failed push, a node record, a wait and a
 * resume), the writer's numbering and content modes, and the routes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent, Workflow, WorkflowNode } from '@landflow/engine';
import type { JournalDraft, JournalEvent } from '@/lib/shared/run-trace';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-journal-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { createTranslator, journalOf, journalStore, liveJournal, releaseJournal, resetJournals, pruneJournal } = await import('@/lib/server/journal');
const { applyContent } = await import('@/lib/server/journal/content');
const { runWorkflow } = await import('@/lib/server/runner');
const { store } = await import('@/lib/server/store');
const { bus } = await import('@/lib/server/bus');

registry.registerBuiltin(corePlugin);

afterAll(() => {
  resetJournals();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const node = (id: string, name: string, type: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters: {}, ...extra });
const workflow: Workflow = {
  id: 'wf_trace',
  name: 'Grafana run',
  nodes: [
    node('trigger', 'Suggestion approved', 'core.manualTrigger'),
    node('lead', 'Tech Lead', 'core.messageAgent', { notes: 'Leads the build' }),
    node('model', 'qwen3-coder (Ollama)', 'core.ollamaChatModel', { parameters: { model: 'qwen3-coder:30b' } }),
    node('memory', 'Memory', 'core.simpleMemory'),
    node('planner', 'Planner', 'core.a2aAgent'),
    node('check', 'Check branch', 'github.github'),
    node('pr', 'Open PR', 'github.github'),
  ],
  connections: [],
};

let clock = Date.parse('2026-10-31T10:00:00.000Z');
const at = (ms = 1000) => new Date((clock += ms)).toISOString();

const started = (nodeId: string, extra: Record<string, unknown> = {}) => ({ type: 'node.started', executionId: 'ex_1', nodeId, nodeName: workflow.nodes.find((n) => n.id === nodeId)!.name, source: 'main', at: at(), ...extra }) as ExecutionEvent;
const finished = (nodeId: string, json: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
  ({
    type: 'node.finished',
    executionId: 'ex_1',
    nodeId,
    nodeName: workflow.nodes.find((n) => n.id === nodeId)!.name,
    source: 'main',
    status: 'success',
    durationMs: 10,
    itemCounts: [1],
    run: { startedAt: at(0), durationMs: 10, status: 'success', source: 'main', inputs: [[]], outputs: [json ? [{ json }] : []], spanId: `otel-${nodeId}`, ...extra },
    at: at(),
    ...extra,
  }) as unknown as ExecutionEvent;
const progress = (nodeId: string, data: Record<string, unknown>) => ({ type: 'node.progress', executionId: 'ex_1', nodeId, nodeName: nodeId, parentNodeId: 'lead', data, at: at() }) as unknown as ExecutionEvent;

function translate(events: ExecutionEvent[], seed: JournalEvent[] = []): JournalDraft[] {
  const drafts: JournalDraft[] = [];
  const translator = createTranslator({ workflow, executionId: 'ex_1', startedBy: { id: 'usr_1', name: 'Dana' }, emit: (d) => drafts.push(d) });
  translator.seed(seed);
  for (const event of events) translator.feed(event);
  return drafts;
}

const withSeq = (drafts: JournalDraft[]): JournalEvent[] => drafts.map((d, i) => ({ ...d, seq: i + 1, executionId: 'ex_1', at: d.at ?? at() }) as JournalEvent);
const ofType = <T extends JournalEvent['type']>(drafts: JournalDraft[], type: T) => drafts.filter((d) => d.type === type) as Array<Extract<JournalDraft, { type: T }>>;
const spanStart = (drafts: JournalDraft[], id: string) => ofType(drafts, 'span.started').find((d) => d.spanId === id);
const spanEnd = (drafts: JournalDraft[], id: string) => ofType(drafts, 'span.ended').find((d) => d.spanId === id);

/** A tool step as the remote run's progress carries it (arguments and results shortened to text). */
const push = { id: 'call_push', name: 'Bash', status: 'running', args: '{"command":"git push"}', startedAt: '2026-10-31T10:05:00.000Z' };

function firstSegment(): ExecutionEvent[] {
  return [
    { type: 'execution.started', executionId: 'ex_1', workflowId: workflow.id, mode: 'manual', traceId: 'trace-1', at: at() },
    started('trigger'),
    finished('trigger', { chatInput: 'Build a Grafana plugin', sessionId: 'sess_9' }),
    started('lead'),
    started('memory', { source: 'memory', parentNodeId: 'lead' }),
    finished('memory', { action: 'load' }, { source: 'memory', parentNodeId: 'lead' }),
    started('model', { source: 'model', parentNodeId: 'lead' }),
    finished('model', { text: '', toolCalls: [{ id: 'c1', name: 'Planner', input: { message: 'plan it' } }], usage: { inputTokens: 120, outputTokens: 30 } }, { source: 'model', parentNodeId: 'lead' }),
    started('planner', { source: 'tool', parentNodeId: 'lead', input: { message: 'plan it' } }),
    progress('planner', { agent: 'landflow_planner', state: 'working', taskId: 'task-1', contextId: 'ctx-1', steps: [push] }),
    progress('planner', { agent: 'landflow_planner', state: 'working', taskId: 'task-1', contextId: 'ctx-1', steps: [{ ...push, status: 'error', error: 'Exit code 128\nfatal: no remote', endedAt: '2026-10-31T10:05:02.000Z' }, { id: 'call_ask', name: 'ask', status: 'awaiting_approval', startedAt: '2026-10-31T10:05:03.000Z' }] }),
    progress('planner', { agent: 'landflow_planner', state: 'input-required', taskId: 'task-1', contextId: 'ctx-1', steps: [] }),
    progress('planner', { agent: 'landflow_planner', state: 'working', taskId: 'task-1', contextId: 'ctx-1', steps: [] }),
    { type: 'node.record', executionId: 'ex_1', nodeId: 'planner', nodeName: 'Planner', parentNodeId: 'lead', record: { type: 'artifact', name: 'plan.md', kind: 'file', text: '# Plan' }, at: at() },
    { type: 'node.record', executionId: 'ex_1', nodeId: 'planner', nodeName: 'Planner', parentNodeId: 'lead', record: { type: 'check', name: 'tests', status: 'fail', message: '2 failed' }, at: at() },
    finished(
      'planner',
      {
        reply: 'Here is the plan',
        state: 'completed',
        taskId: 'task-1',
        contextId: 'ctx-1',
        agent: 'landflow_planner',
        steps: [
          { id: 'call_push', name: 'Bash', status: 'error', args: { command: 'git push' }, error: 'Exit code 128\nfatal: no remote', startedAt: '2026-10-31T10:05:00.000Z', endedAt: '2026-10-31T10:05:02.000Z' },
          { id: 'call_ask', name: 'ask', status: 'success', output: 'ok', endedAt: '2026-10-31T10:05:09.000Z' },
          { id: 'call_late', name: 'Write', status: 'success', args: { path: 'a.ts' }, output: 'done', startedAt: '2026-10-31T10:05:10.000Z', endedAt: '2026-10-31T10:05:11.000Z' },
        ],
        usage: { inputTokens: 900, outputTokens: 100 },
      },
      { source: 'tool', parentNodeId: 'lead' },
    ),
    started('check', { source: 'tool', parentNodeId: 'lead', input: { which_branch: 'agents/x' } }),
    finished('check', { sha: 'abc' }, { source: 'tool', parentNodeId: 'lead' }),
    finished('lead', { reply: 'All done' }),
    started('pr'),
    {
      type: 'execution.finished',
      executionId: 'ex_1',
      status: 'waiting',
      durationMs: 5000,
      wait: { nodeId: 'pr', nodeName: 'Open PR', resume: 'webhook', since: at(), data: { approval: { channel: 'chat', calls: [{ id: 'k1', tool: 'create_pull_request', input: { title: 'x' } }] } } },
      at: at(),
    } as ExecutionEvent,
  ];
}

describe('translator', () => {
  const drafts = translate(firstSegment());

  it('starts the run with its workflow, mode and the person who started it', () => {
    expect(drafts[0]).toMatchObject({ type: 'span.started', spanId: 'run', kind: 'run', name: 'Grafana run', actor: { id: 'workflow', type: 'system' }, caller: { id: 'human:usr_1', name: 'Dana' }, attrs: { mode: 'manual' } });
  });

  it('classifies agent nodes, steps, models, memory and delegates with deterministic span ids', () => {
    expect(spanStart(drafts, 'node:trigger:0')).toMatchObject({ kind: 'step', actor: { id: 'workflow' }, parentSpanId: 'run' });
    expect(spanStart(drafts, 'node:lead:0')).toMatchObject({ kind: 'agent', actor: { id: 'node:lead', type: 'agent', role: 'Leads the build' }, parentSpanId: 'run' });
    expect(spanStart(drafts, 'node:memory:0')).toMatchObject({ kind: 'step', parentSpanId: 'node:lead:0', attrs: { hidden: true } });
    expect(spanStart(drafts, 'node:model:0')).toMatchObject({ kind: 'model', actor: { id: 'model:qwen3-coder:30b' }, caller: { id: 'node:lead' }, parentSpanId: 'node:lead:0' });
    expect(spanStart(drafts, 'node:planner:0')).toMatchObject({ kind: 'delegate', actor: { id: 'remote:Planner', type: 'agent' }, caller: { id: 'node:lead' }, input: { message: 'plan it' } });
    expect(spanStart(drafts, 'node:check:0')).toMatchObject({ kind: 'tool', actor: { id: 'node:lead' }, input: { which_branch: 'agents/x' } });
  });

  it('ends a model span with its text, tool calls and usage', () => {
    expect(spanEnd(drafts, 'node:model:0')).toMatchObject({ status: 'success', output: { text: '', toolCalls: [{ name: 'Planner' }] }, usage: { inputTokens: 120, outputTokens: 30 }, attrs: { otelSpanId: 'otel-model' } });
  });

  it('turns the chat trigger into the first message of the run', () => {
    expect(ofType(drafts, 'message')[0]).toMatchObject({ spanId: 'run', from: { id: 'human:sess_9', type: 'human' }, text: 'Build a Grafana plugin' });
  });

  it('follows a remote run: card name, states, steps, a failed step, a wait and the final steps', () => {
    expect(ofType(drafts, 'span.updated').find((d) => d.spanId === 'node:planner:0' && d.attrs?.agent)).toMatchObject({ attrs: { agent: 'landflow_planner', taskId: 'task-1', contextId: 'ctx-1' }, state: 'working' });
    expect(spanStart(drafts, 'node:planner:0/step:call_push')).toMatchObject({ kind: 'tool', name: 'Bash', parentSpanId: 'node:planner:0', actor: { name: 'landflow_planner' }, at: '2026-10-31T10:05:00.000Z' });
    expect(spanEnd(drafts, 'node:planner:0/step:call_push')).toMatchObject({ status: 'error', error: 'Exit code 128\nfatal: no remote', at: '2026-10-31T10:05:02.000Z' });
    expect(ofType(drafts, 'span.updated').find((d) => d.spanId === 'node:planner:0/step:call_ask')).toMatchObject({ status: 'waiting' });
    // The question: a wait span for a person while the state is input-required, ended when it moves on.
    expect(spanStart(drafts, 'node:planner:0/wait')).toMatchObject({ kind: 'wait', actor: { type: 'human' }, caller: { name: 'landflow_planner' } });
    expect(spanEnd(drafts, 'node:planner:0/wait')).toMatchObject({ status: 'success' });
    expect(ofType(drafts, 'span.updated').find((d) => d.state === 'input-required')).toMatchObject({ status: 'waiting' });
    // The final output has every step: the one never seen in progress is started and ended, the pending one ended.
    expect(spanStart(drafts, 'node:planner:0/step:call_late')).toMatchObject({ input: { path: 'a.ts' } });
    expect(spanEnd(drafts, 'node:planner:0/step:call_late')).toMatchObject({ status: 'success', output: 'done' });
    expect(spanEnd(drafts, 'node:planner:0/step:call_ask')).toMatchObject({ status: 'success', output: 'ok' });
    expect(ofType(drafts, 'span.ended').filter((d) => d.spanId === 'node:planner:0/step:call_push')).toHaveLength(1);
    expect(spanEnd(drafts, 'node:planner:0')).toMatchObject({ status: 'success', output: 'Here is the plan', usage: { inputTokens: 900, outputTokens: 100 }, attrs: { state: 'completed', taskId: 'task-1' } });
  });

  it('puts a node record in the node’s open span, a check marked as the node’s', () => {
    expect(ofType(drafts, 'artifact')[0]).toMatchObject({ spanId: 'node:planner:0', artifact: { name: 'plan.md', kind: 'file', text: '# Plan' } });
    expect(ofType(drafts, 'check')[0]).toMatchObject({ spanId: 'node:planner:0', check: { name: 'tests', status: 'fail', source: 'node' } });
    expect(ofType(drafts, 'artifact')[0].artifact).not.toHaveProperty('type');
  });

  it('waits: the run and node are waiting and a wait span for a person names the approval', () => {
    expect(ofType(drafts, 'span.updated').find((d) => d.spanId === 'run')).toMatchObject({ status: 'waiting' });
    expect(spanStart(drafts, 'run/wait:1')).toMatchObject({ kind: 'wait', name: 'Approve create_pull_request', actor: { type: 'human' }, attrs: { wait: 'approval', channel: 'chat' } });
    expect(spanEnd(drafts, 'run')).toBeUndefined();
  });

  it('resumes in another segment: seeded from the stored events it ends the wait, counts node runs on and ends the run', () => {
    const seed = withSeq(drafts);
    const second = translate(
      [
        { type: 'execution.started', executionId: 'ex_1', workflowId: workflow.id, mode: 'manual', resumed: true, at: at() },
        started('pr'),
        finished('pr', { number: 2 }),
        { type: 'execution.finished', executionId: 'ex_1', status: 'success', durationMs: 9000, at: at() } as ExecutionEvent,
      ],
      seed,
    );
    expect(second[0]).toMatchObject({ type: 'span.updated', spanId: 'run', status: 'running' });
    expect(spanEnd(second, 'run/wait:1')).toMatchObject({ status: 'success' });
    // The waiting node's first span is closed when the node runs again, and the new span is the second run of it.
    expect(spanEnd(second, 'node:pr:0')).toBeDefined();
    expect(spanStart(second, 'node:pr:1')).toBeDefined();
    expect(spanEnd(second, 'node:pr:1')).toMatchObject({ status: 'success', output: { number: 2 } });
    expect(spanEnd(second, 'run')).toMatchObject({ status: 'success' });
    expect(ofType(second, 'span.started').some((d) => d.spanId === 'run')).toBe(false);
  });

  it('ends the spans left open when the run fails or is canceled', () => {
    const events = [
      { type: 'execution.started', executionId: 'ex_1', workflowId: workflow.id, mode: 'manual', at: at() } as ExecutionEvent,
      started('lead'),
      started('planner', { source: 'tool', parentNodeId: 'lead', input: { message: 'x' } }),
      progress('planner', { agent: 'p', state: 'working', steps: [push] }),
    ];
    const failed = translate([...events, { type: 'execution.finished', executionId: 'ex_1', status: 'error', durationMs: 1, error: { message: 'boom', nodeId: 'lead' }, at: at() } as ExecutionEvent]);
    expect(spanEnd(failed, 'node:planner:0/step:call_push')).toMatchObject({ status: 'canceled' });
    expect(spanEnd(failed, 'node:planner:0')).toMatchObject({ status: 'canceled' });
    expect(spanEnd(failed, 'node:lead:0')).toMatchObject({ status: 'error', error: 'boom' });
    expect(spanEnd(failed, 'run')).toMatchObject({ status: 'error', error: 'boom' });
    const canceled = translate([...events, { type: 'execution.finished', executionId: 'ex_1', status: 'canceled', durationMs: 1, at: at() } as ExecutionEvent]);
    expect(spanEnd(canceled, 'node:lead:0')).toMatchObject({ status: 'canceled' });
    expect(spanEnd(canceled, 'run')).toMatchObject({ status: 'canceled' });
  });

  it('turns other progress into a note, once', () => {
    const out = translate([
      { type: 'execution.started', executionId: 'ex_1', workflowId: workflow.id, mode: 'manual', at: at() } as ExecutionEvent,
      started('pr'),
      { type: 'node.progress', executionId: 'ex_1', nodeId: 'pr', nodeName: 'Open PR', data: { message: 'Pushing' }, at: at() } as ExecutionEvent,
      { type: 'node.progress', executionId: 'ex_1', nodeId: 'pr', nodeName: 'Open PR', data: { message: 'Pushing' }, at: at() } as ExecutionEvent,
      { type: 'node.progress', executionId: 'ex_1', nodeId: 'pr', nodeName: 'Open PR', data: { pct: 5 }, at: at() } as ExecutionEvent,
    ]);
    expect(ofType(out, 'span.updated').map((d) => d.note)).toEqual(['Pushing', '{"pct":5}']);
  });

  it('follows the remote run of an A2A Agent node on the canvas, as of one in an agent’s tools', () => {
    // A top-level node: no parentNodeId on its events. Its steps were kept as a JSON note, and its output cut whole.
    const top = (data: Record<string, unknown>) => ({ type: 'node.progress', executionId: 'ex_1', nodeId: 'planner', nodeName: 'Planner', data, at: at() }) as unknown as ExecutionEvent;
    const write = { id: 'call_w', name: 'Write', status: 'success', args: { file_path: '/tmp/work/out/nodes.csv', content: 'node,file\nGet alerts,get-alerts.ts' }, startedAt: '2026-10-31T10:06:00.000Z' };
    const events = [
      { type: 'execution.started', executionId: 'ex_1', workflowId: workflow.id, mode: 'manual', at: at() } as ExecutionEvent,
      started('planner'),
      top({ agent: 'landflow_developer', state: 'working', taskId: 'task-9', steps: [{ ...push, status: 'success' }] }),
      finished('planner', { reply: 'Wrote nodes.csv', state: 'completed', taskId: 'task-9', agent: 'landflow_developer', steps: [{ ...push, status: 'success' }, write] }),
    ];
    const out = translate(events);
    expect(spanStart(out, 'node:planner:0')).toMatchObject({ kind: 'agent' });
    expect(ofType(out, 'span.updated').filter((d) => d.note)).toEqual([]);
    expect(spanStart(out, 'node:planner:0/step:call_push')).toMatchObject({ kind: 'tool', name: 'Bash' });
    expect(spanStart(out, 'node:planner:0/step:call_w')).toMatchObject({ kind: 'tool', name: 'Write', input: write.args });
    expect(spanEnd(out, 'node:planner:0')).toMatchObject({ output: 'Wrote nodes.csv', attrs: expect.objectContaining({ taskId: 'task-9', agent: 'landflow_developer' }) });
    // A segment that starts after the node began (a resume) knows it follows a remote run.
    const later = translate([top({ agent: 'landflow_developer', state: 'working', steps: [{ id: 'call_x', name: 'Read', status: 'running' }] })], withSeq(translate(events.slice(0, 2))));
    expect(spanStart(later, 'node:planner:0/step:call_x')).toMatchObject({ kind: 'tool', name: 'Read' });
  });
});

describe('content modes', () => {
  const long = 'x'.repeat(5000);
  const span = (): JournalEvent => ({ type: 'span.ended', seq: 1, executionId: 'e', at: 'a', spanId: 's', status: 'error', error: long, output: { text: long, nested: [long] } });

  it('summaries cut every text of input and output to 400 characters', () => {
    const event = applyContent(span(), 'summaries') as Extract<JournalEvent, { type: 'span.ended' }>;
    const text = (event.output as { text: string; nested: string[] }).text;
    expect(text.length).toBe(400 + '…[cut]'.length);
    expect((event.output as { nested: string[] }).nested[0]).toHaveLength(406);
    expect(event.error).toHaveLength(406);
  });

  it('off keeps names, statuses and errors and drops the content', () => {
    const event = applyContent(span(), 'off') as Extract<JournalEvent, { type: 'span.ended' }>;
    expect(event.output).toBeUndefined();
    expect(event.status).toBe('error');
    expect(event.error).toHaveLength(406);
    const message = applyContent({ type: 'message', seq: 1, executionId: 'e', at: 'a', spanId: 'run', from: { id: 'human:1', name: 'A', type: 'human' }, text: 'secret words' }, 'off') as Extract<JournalEvent, { type: 'message' }>;
    expect(message.text).toBe('');
    const artifact = applyContent({ type: 'artifact', seq: 1, executionId: 'e', at: 'a', spanId: 's', artifact: { name: 'f', kind: 'file', text: 'body', url: 'u' } }, 'off') as Extract<JournalEvent, { type: 'artifact' }>;
    expect(artifact.artifact).toEqual({ name: 'f', kind: 'file', url: 'u' });
  });

  it('full cuts an event over 32 KB by shortening its longest strings', () => {
    const big: JournalEvent = { type: 'span.started', seq: 1, executionId: 'e', at: 'a', spanId: 's', kind: 'tool', name: 'Bash', actor: { id: 'a', name: 'A', type: 'agent' }, input: { command: 'y'.repeat(80_000), other: 'z'.repeat(10_000) } };
    const event = applyContent(big, 'full') as Extract<JournalEvent, { type: 'span.started' }>;
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(32 * 1024);
    expect((event.input as { command: string }).command).toMatch(/…\[cut\]$/);
    expect(event.name).toBe('Bash');
    // A small event is untouched.
    expect(applyContent(span(), 'full')).toMatchObject({ error: long });
  });
});

describe('writer and store', () => {
  it('numbers from the stored seq, continues after a restart, and publishes each flushed batch', () => {
    const seen: JournalEvent[][] = [];
    const stop = bus.subscribe((event) => {
      if (event.channel === 'journal' && event.executionId === 'ex_w') seen.push(event.events);
    });
    const first = journalOf('ex_w', { workflowId: 'wf_w' });
    first.traceId = 'trace-w';
    first.record({ type: 'span.started', spanId: 'run', kind: 'run', name: 'W', actor: { id: 'workflow', name: 'W', type: 'system' } });
    first.record({ type: 'message', spanId: 'run', from: { id: 'human:1', name: 'A', type: 'human' }, text: 'hi' });
    first.flush();
    expect(journalStore.read('ex_w').map((e) => [e.seq, e.traceId])).toEqual([[1, 'trace-w'], [2, 'trace-w']]);
    expect(seen[0].map((e) => e.seq)).toEqual([1, 2]);
    releaseJournal('ex_w');

    // A resumed run in another process starts from what is stored.
    const second = journalOf('ex_w', { workflowId: 'wf_w' });
    second.record({ type: 'span.ended', spanId: 'run', status: 'success' });
    second.flush();
    expect(journalStore.read('ex_w').map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(journalStore.read('ex_w', 2).map((e) => e.seq)).toEqual([3]);
    expect(journalStore.lastSeq('ex_w')).toBe(3);
    stop();
  });

  it('renumbers a batch on a primary-key clash and retries', () => {
    const journal = journalOf('ex_clash', { workflowId: 'wf_w' });
    journal.record({ type: 'span.started', spanId: 'run', kind: 'run', name: 'C', actor: { id: 'workflow', name: 'C', type: 'system' } });
    journal.flush();
    // Somebody else (another process) wrote seq 2 and 3 after this writer last looked.
    const other = journalOf('ex_clash_other', { workflowId: 'wf_w' });
    other.record({ type: 'message', spanId: 'run', from: { id: 'human:1', name: 'A', type: 'human' }, text: 'x' });
    other.flush();
    journalStore.append('ex_clash', [
      { type: 'message', seq: 2, executionId: 'ex_clash', at: new Date().toISOString(), spanId: 'run', from: { id: 'human:2', name: 'B', type: 'human' }, text: 'theirs' },
      { type: 'message', seq: 3, executionId: 'ex_clash', at: new Date().toISOString(), spanId: 'run', from: { id: 'human:2', name: 'B', type: 'human' }, text: 'theirs too' },
    ]);
    journal.record({ type: 'span.ended', spanId: 'run', status: 'success' });
    journal.flush();
    expect(journalStore.read('ex_clash').map((e) => [e.seq, e.type])).toEqual([[1, 'span.started'], [2, 'message'], [3, 'message'], [4, 'span.ended']]);
    resetJournals();
  });

  it('batches: events wait for the timer or a flush, and a failing write never throws', () => {
    const journal = journalOf('ex_batch', { workflowId: 'wf_w' });
    journal.record({ type: 'message', spanId: 'run', from: { id: 'human:1', name: 'A', type: 'human' }, text: 'later' });
    expect(journalStore.read('ex_batch')).toHaveLength(0);
    expect(liveJournal('ex_batch')).toBe(journal);
    releaseJournal('ex_batch');
    expect(journalStore.read('ex_batch')).toHaveLength(1);
    expect(liveJournal('ex_batch')).toBeUndefined();
  });

  it('applies the workflow’s content setting to what it stores', () => {
    const journal = journalOf('ex_off', { workflowId: 'wf_w', content: 'off' });
    journal.record({ type: 'span.started', spanId: 'run', kind: 'tool', name: 'Bash', actor: { id: 'a', name: 'A', type: 'agent' }, input: { command: 'rm -rf' } });
    releaseJournal('ex_off');
    expect(journalStore.read('ex_off')[0]).not.toHaveProperty('input');
  });

  it('prunes events older than the retention and deletes an execution’s events with it', () => {
    journalStore.append('ex_old', [{ type: 'message', seq: 1, executionId: 'ex_old', at: '2020-01-01T00:00:00.000Z', spanId: 'run', from: { id: 'h', name: 'H', type: 'human' }, text: 'old' }]);
    journalStore.append('ex_new', [{ type: 'message', seq: 1, executionId: 'ex_new', at: new Date().toISOString(), spanId: 'run', from: { id: 'h', name: 'H', type: 'human' }, text: 'new' }]);
    expect(pruneJournal()).toBeGreaterThanOrEqual(1);
    expect(journalStore.read('ex_old')).toHaveLength(0);
    expect(journalStore.read('ex_new')).toHaveLength(1);
    store.saveExecution({ executionId: 'ex_new', workflowId: 'wf_x', workflowName: 'X', mode: 'manual', status: 'success', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, runData: {}, executionOrder: [] });
    store.deleteExecution('ex_new');
    expect(journalStore.read('ex_new')).toHaveLength(0);
  });
});

describe('a Landflow agent session in a run', () => {
  it('writes its answers, tool calls, approval pauses and guardrails under the node’s span', async () => {
    const { agentSessionJournal } = await import('@/lib/server/journal/agent-session');
    const journal = journalOf('ex_agent', { workflowId: 'wf_a' });
    journal.bindSpans((nodeId) => (nodeId === 'agentnode' ? 'node:agentnode:0' : undefined));
    const entry = agentSessionJournal({ execution: { workflowId: 'wf_a', executionId: 'ex_agent', nodeId: 'agentnode' } }, { id: 'ag_1', name: 'Analyst' });
    const tool = (patch: Record<string, unknown>) => ({ id: 't1', type: 'tool', callId: 'c1', tool: 'send_email', label: 'Send email', kind: 'node', input: { to: 'a@b.c' }, status: 'running', at: '2026-10-31T10:00:00.000Z', ...patch }) as never;
    entry(tool({}));
    entry(tool({ status: 'awaiting_approval', approval: { message: 'Send the email?' } }));
    entry(tool({ status: 'running' }));
    entry(tool({ status: 'success', output: { sent: true }, durationMs: 40 }));
    entry(tool({ id: 't2', callId: 'c2', kind: 'flow', tool: 'planner' }));
    entry({ id: 'a1', type: 'assistant', text: 'Sent.', at: '2026-10-31T10:00:05.000Z' });
    entry({ id: 'g1', type: 'guardrail', stage: 'output', action: 'sanitized', violations: [{ check: 'pii', type: 'email', match: 'a***' }], at: '2026-10-31T10:00:06.000Z' });
    entry({ id: 'g1', type: 'guardrail', stage: 'output', action: 'sanitized', violations: [], at: '2026-10-31T10:00:06.000Z' });
    entry(tool({ id: 't3', callId: 'c3', kind: 'agent', label: 'Researcher', childAgentId: 'ag_2', status: 'error', error: 'timeout' }));
    releaseJournal('ex_agent');
    const events = journalStore.read('ex_agent');
    const call = 'node:agentnode:0/step:c1';
    expect(events.filter((e) => e.spanId === call).map((e) => [e.type, 'status' in e ? e.status : undefined])).toEqual([['span.started', undefined], ['span.updated', 'waiting'], ['span.updated', 'running'], ['span.ended', 'success']]);
    expect(events.find((e) => e.spanId === call)).toMatchObject({ kind: 'tool', parentSpanId: 'node:agentnode:0', actor: { id: 'agent:ag_1' }, input: { to: 'a@b.c' } });
    expect(events.find((e) => e.spanId === `${call}/approval`)).toMatchObject({ kind: 'wait', name: 'Send the email?', actor: { type: 'human' } });
    expect(events.filter((e) => e.spanId === `${call}/approval`).map((e) => e.type)).toEqual(['span.started', 'span.ended']);
    expect(events.some((e) => e.spanId.includes('c2'))).toBe(false);
    expect(events.find((e) => e.type === 'message')).toMatchObject({ spanId: 'node:agentnode:0', text: 'Sent.', from: { id: 'agent:ag_1' } });
    expect(events.filter((e) => e.type === 'check')).toHaveLength(1);
    expect(events.find((e) => e.type === 'check')).toMatchObject({ check: { name: 'Output guardrail', status: 'warn', source: 'builtin' } });
    expect(events.find((e) => e.spanId.endsWith('c3') && e.type === 'span.started')).toMatchObject({ kind: 'delegate', actor: { id: 'agent:ag_2' }, caller: { id: 'agent:ag_1' } });
    expect(events.find((e) => e.spanId.endsWith('c3') && e.type === 'span.ended')).toMatchObject({ status: 'error', error: 'timeout' });
  });

  it('records the layers\' decisions (tool access, the router, the cache) as checks', async () => {
    const { agentSessionJournal, layerCheck } = await import('@/lib/server/journal/agent-session');
    const journal = journalOf('ex_agent_layers', { workflowId: 'wf_a' });
    journal.bindSpans((nodeId) => (nodeId === 'agentnode' ? 'node:agentnode:0' : undefined));
    const entry = agentSessionJournal({ execution: { workflowId: 'wf_a', executionId: 'ex_agent_layers', nodeId: 'agentnode' } }, { id: 'ag_1', name: 'Analyst' });
    const at = '2026-11-05T10:00:00.000Z';
    entry({ id: 'n1', type: 'notice', message: 'Tool access: Refund is not available to you (policy: deny)', at });
    entry({ id: 'n1', type: 'notice', message: 'Tool access: Refund is not available to you (policy: deny)', at });
    entry({ id: 'n2', type: 'notice', message: 'Routed to qwen3.8: short request (31 characters)', at });
    entry({ id: 'n3', type: 'notice', message: 'Answered from the response cache: no model call.', at });
    entry({ id: 'n4', type: 'notice', message: 'Stopped: budget', at });
    releaseJournal('ex_agent_layers');
    const checks = journalStore.read('ex_agent_layers').filter((e) => e.type === 'check');
    expect(checks.map((e) => ('check' in e ? [e.check.name, e.check.status] : []))).toEqual([['Tool access', 'warn'], ['Model router', 'pass'], ['Response cache', 'pass']]);
    expect(checks[0]).toMatchObject({ check: { message: 'Refund is not available to you (policy: deny)', source: 'builtin', subject: 'Analyst' } });
    expect(layerCheck('Something else')).toBeUndefined();
  });

  it('speaks as its node in a flow, so the run has one actor for the agent', async () => {
    const { agentSessionJournal } = await import('@/lib/server/journal/agent-session');
    const journal = journalOf('ex_agent_node', { workflowId: 'wf_a' });
    const lead = { id: 'node:lead', name: 'Tech Lead', type: 'agent', nodeType: 'core.messageAgent' } as const;
    journal.bindSpans(
      (nodeId) => (nodeId === 'lead' ? 'node:lead:0' : undefined),
      (nodeId) => (nodeId === 'lead' ? lead : undefined),
    );
    const entry = agentSessionJournal({ execution: { workflowId: 'wf_a', executionId: 'ex_agent_node', nodeId: 'lead' } }, { id: 'ag_lead', name: 'Tech Lead' });
    entry({ id: 'a1', type: 'assistant', text: 'Outcome: done.', at: '2026-10-31T10:00:05.000Z' });
    releaseJournal('ex_agent_node');
    expect(journalStore.read('ex_agent_node').find((e) => e.type === 'message')).toMatchObject({ spanId: 'node:lead:0', from: { id: 'node:lead' } });
  });

  it('does nothing for a session outside a run', async () => {
    const { agentSessionJournal } = await import('@/lib/server/journal/agent-session');
    expect(() => agentSessionJournal({}, { id: 'a', name: 'A' })({ id: 'a1', type: 'assistant', text: 'x', at: 'now' })).not.toThrow();
  });
});

describe('a real run', () => {
  it('journals a workflow through the runner: the run span and a span per node', async () => {
    const wf = store.saveWorkflow({
      id: 'wf_real',
      name: 'Real',
      nodes: [node('S', 'Start', 'core.manualTrigger'), node('N', 'Note', 'core.noOp')],
      connections: [{ id: 'e1', type: 'main', source: 'S', target: 'N', sourceIndex: 0, targetIndex: 0 }],
    });
    const record = await runWorkflow({ workflow: wf, mode: 'manual' });
    const events = journalStore.read(record.executionId);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const ids = events.filter((e) => e.type === 'span.started').map((e) => e.spanId);
    expect(ids).toEqual(['run', 'node:S:0', 'node:N:0']);
    expect(events.find((e) => e.type === 'span.ended' && e.spanId === 'run')).toMatchObject({ status: 'success' });
  });

  it('rebuilds the journal of a run recorded without one from its run data, once, when it is first read', async () => {
    const { GET } = await import('@/app/api/executions/[id]/events/route');
    const wf = store.saveWorkflow({
      id: 'wf_rebuilt',
      name: 'Rebuilt',
      nodes: [node('S', 'Start', 'core.manualTrigger'), node('N', 'Note', 'core.noOp'), node('M', 'Fails', 'core.stopAndError', { parameters: { errorMessage: 'nope' } })],
      connections: [
        { id: 'e1', type: 'main', source: 'S', target: 'N', sourceIndex: 0, targetIndex: 0 },
        { id: 'e2', type: 'main', source: 'N', target: 'M', sourceIndex: 0, targetIndex: 0 },
      ],
    });
    const record = await runWorkflow({ workflow: wf, mode: 'manual' });
    expect(record.status).toBe('error');
    const kept = journalStore.read(record.executionId, 0, 2000);
    journalStore.deleteFor([record.executionId]);
    const read = async () => {
      const response = await GET(new Request(`http://localhost/api/executions/${record.executionId}/events`), { params: Promise.resolve({ id: record.executionId }) });
      return ((await response.json()) as { events: JournalEvent[] }).events;
    };
    const rebuilt = await read();
    const shape = (events: JournalEvent[]) => events.map((e) => `${e.type} ${'spanId' in e ? e.spanId : ''} ${'status' in e ? e.status : ''}`);
    expect(shape(rebuilt)).toEqual(shape(kept));
    expect(rebuilt[0]).toMatchObject({ type: 'span.started', spanId: 'run', attrs: { rebuilt: true } });
    expect(rebuilt.find((e) => e.type === 'span.ended' && e.spanId === 'node:M:0')).toMatchObject({ status: 'error' });
    // Read again: nothing is added.
    expect((await read()).map((e) => e.seq)).toEqual(rebuilt.map((e) => e.seq));
  });
});

describe('routes', () => {
  it('GET /api/executions/:id/events pages with after, limit and more', async () => {
    const { GET } = await import('@/app/api/executions/[id]/events/route');
    const wf = store.saveWorkflow({ id: 'wf_route', name: 'Route', nodes: [], connections: [] });
    store.saveExecution({ executionId: 'ex_route', workflowId: wf.id, workflowName: 'Route', mode: 'manual', status: 'success', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, runData: {}, executionOrder: [] });
    const journal = journalOf('ex_route', { workflowId: wf.id });
    for (let i = 0; i < 5; i++) journal.record({ type: 'message', spanId: 'run', from: { id: 'human:1', name: 'A', type: 'human' }, text: `m${i}` });
    releaseJournal('ex_route');
    const call = async (query: string) => {
      const response = await GET(new Request(`http://localhost/api/executions/ex_route/events${query}`), { params: Promise.resolve({ id: 'ex_route' }) });
      return (await response.json()) as { events: JournalEvent[]; last: number; more: boolean };
    };
    const all = await call('');
    expect(all).toMatchObject({ last: 5, more: false });
    expect(all.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    const page = await call('?after=1&limit=2');
    expect(page.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(page).toMatchObject({ last: 3, more: true });
    expect(await call('?after=5')).toEqual({ events: [], last: 5, more: false });
    const missing = await GET(new Request('http://localhost/api/executions/nope/events'), { params: Promise.resolve({ id: 'nope' }) });
    expect(missing.status).toBe(404);
  });

  it('POST /api/executions/:id/checks settles a failed check once, and needs-you lists the unsettled ones', async () => {
    const checks = await import('@/app/api/executions/[id]/checks/route');
    const needs = await import('@/app/api/runs/needs-you/route');
    const wf = store.saveWorkflow({ id: 'wf_checks', name: 'Checks', nodes: [], connections: [] });
    store.saveExecution({ executionId: 'ex_checks', workflowId: wf.id, workflowName: 'Checks', mode: 'manual', status: 'success', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, runData: {}, executionOrder: [] });
    const journal = journalOf('ex_checks', { workflowId: wf.id });
    journal.record({ type: 'span.started', spanId: 'node:dev:0', kind: 'agent', name: 'Developer', actor: { id: 'node:dev', name: 'Developer', type: 'agent' } });
    journal.record({ type: 'check', spanId: 'node:dev:0', check: { name: 'tests', status: 'fail', message: '2 failed', source: 'node' } });
    journal.record({ type: 'check', spanId: 'node:dev:0', check: { name: 'lint', status: 'fail', message: 'bad', source: 'node' } });
    journal.record({ type: 'check', spanId: 'node:dev:0', check: { name: 'docs', status: 'pass', source: 'node' } });
    releaseJournal('ex_checks');

    const listed = async () => ((await (await needs.GET()).json()) as { items: Array<{ kind: string; title: string; executionId: string; spanId?: string; actor?: { name: string }; detail?: string }> }).items.filter((i) => i.executionId === 'ex_checks');
    expect((await listed()).map((i) => i.title).sort()).toEqual(['lint', 'tests']);
    expect((await listed())[0]).toMatchObject({ kind: 'check', spanId: 'node:dev:0', actor: { name: 'Developer' } });

    const post = (body: unknown) => checks.POST(new Request('http://localhost/api/executions/ex_checks/checks', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'ex_checks' }) });
    const ok = await post({ spanId: 'node:dev:0', name: 'tests', decision: 'sent_back', note: 'fix them' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { check: { resolution: { decision: string; note: string } } }).check.resolution).toMatchObject({ decision: 'sent_back', note: 'fix them' });
    expect((await post({ spanId: 'node:dev:0', name: 'tests', decision: 'accepted' })).status).toBe(409);
    expect((await post({ spanId: 'node:dev:0', name: 'docs', decision: 'accepted' })).status).toBe(409);
    expect((await post({ spanId: 'node:dev:0', name: 'nothing', decision: 'accepted' })).status).toBe(404);
    expect((await post({ spanId: 'node:dev:0', name: 'tests', decision: 'maybe' })).status).toBe(400);
    expect((await listed()).map((i) => i.title)).toEqual(['lint']);

    const stored = journalStore.read('ex_checks').filter((e) => e.type === 'check');
    expect(stored.at(-1)).toMatchObject({ check: { name: 'tests', resolution: { decision: 'sent_back' } } });
  });

  it('settles one member’s check of a team’s node by its subject, and lists the other', async () => {
    const checks = await import('@/app/api/executions/[id]/checks/route');
    const needs = await import('@/app/api/runs/needs-you/route');
    const wf = store.saveWorkflow({ id: 'wf_team_checks', name: 'Team checks', nodes: [], connections: [] });
    store.saveExecution({ executionId: 'ex_team_checks', workflowId: wf.id, workflowName: 'Team checks', mode: 'manual', status: 'success', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, runData: {}, executionOrder: [] });
    const journal = journalOf('ex_team_checks', { workflowId: wf.id });
    journal.record({ type: 'span.started', spanId: 'node:team:0', kind: 'agent', name: 'Team', actor: { id: 'node:team', name: 'Team', type: 'agent' } });
    journal.record({ type: 'check', spanId: 'node:team:0', check: { name: 'Budget', status: 'fail', message: 'Planner was stopped', subject: 'Planner', source: 'builtin' } });
    journal.record({ type: 'check', spanId: 'node:team:0', check: { name: 'Budget', status: 'fail', message: 'Developer was stopped', subject: 'Developer', source: 'builtin' } });
    releaseJournal('ex_team_checks');
    const listed = async () => ((await (await needs.GET()).json()) as { items: Array<{ executionId: string; detail?: string }> }).items.filter((i) => i.executionId === 'ex_team_checks');
    expect(await listed()).toHaveLength(2);
    const post = (body: unknown) => checks.POST(new Request('http://localhost/api/executions/ex_team_checks/checks', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'ex_team_checks' }) });
    const ok = await post({ spanId: 'node:team:0', name: 'Budget', subject: 'Planner', decision: 'accepted' });
    expect(((await ok.json()) as { check: { subject: string } }).check.subject).toBe('Planner');
    expect(await listed()).toHaveLength(1);
    expect((await post({ spanId: 'node:team:0', name: 'Budget', subject: 'Developer', decision: 'accepted' })).status).toBe(200);
    expect(await listed()).toHaveLength(0);
  });

  it('GET /api/runs/needs-you lists a waiting run that asks a person, not a timer', async () => {
    const needs = await import('@/app/api/runs/needs-you/route');
    const wf = store.saveWorkflow({ id: 'wf_wait', name: 'Waiter', nodes: [node('lead', 'Lead', 'core.aiAgent')], connections: [] });
    const base = { workflowId: wf.id, workflowName: 'Waiter', mode: 'manual' as const, status: 'waiting' as const, startedAt: new Date().toISOString(), durationMs: 1, runData: {}, executionOrder: [], workflow: wf };
    store.saveExecution({ ...base, executionId: 'ex_wait_a', wait: { nodeId: 'lead', nodeName: 'Lead', resume: 'webhook', since: '2026-10-31T09:00:00.000Z', data: { approval: { channel: 'chat', calls: [{ id: 'c', tool: 'send_email', input: {} }] } } } });
    store.saveExecution({ ...base, executionId: 'ex_wait_t', wait: { nodeId: 'lead', nodeName: 'Lead', resume: 'time', since: '2026-10-31T09:00:00.000Z', until: '2099-01-01T00:00:00.000Z' } });
    store.saveExecution({ ...base, executionId: 'ex_wait_f', wait: { nodeId: 'lead', nodeName: 'Lead', resume: 'form', since: '2026-10-31T09:30:00.000Z', data: { form: { title: 'Approve the refund' } } } });
    const items = ((await (await needs.GET()).json()) as { items: Array<{ executionId: string; kind: string; title: string; since: string; workflowName: string; actor?: { id: string } }> }).items.filter((i) => i.executionId.startsWith('ex_wait_'));
    expect(items.map((i) => [i.executionId, i.kind, i.title])).toEqual([
      ['ex_wait_f', 'form', 'Approve the refund'],
      ['ex_wait_a', 'approval', 'Lead wants to run send_email'],
    ]);
    expect(items[1]).toMatchObject({ workflowName: 'Waiter', since: '2026-10-31T09:00:00.000Z', actor: { id: 'node:lead' } });
  });
});

describe('a Run a Team node', () => {
  it('acts as its team’s lead when the host names one, its span keeping the node’s name', () => {
    const drafts: JournalDraft[] = [];
    const translator = createTranslator({ workflow, executionId: 'ex_t', emit: (d) => drafts.push(d), actorNameOf: (n) => (n.id === 'lead' ? 'Editor' : undefined) });
    translator.feed({ type: 'execution.started', executionId: 'ex_t', workflowId: workflow.id, mode: 'manual', at: at() });
    translator.feed({ ...started('lead'), executionId: 'ex_t' } as ExecutionEvent);
    const span = spanStart(drafts, 'node:lead:0')!;
    expect(span.actor).toMatchObject({ id: 'node:lead', name: 'Editor' });
    expect(span.name).toBe(workflow.nodes.find((n) => n.id === 'lead')!.name);
  });
});

describe('connections', () => {
  it('tells what an agent node works with: its sub-nodes, then what the host adds', () => {
    const flow: Workflow = {
      ...workflow,
      nodes: [...workflow.nodes, node('kb', 'Docs', 'core.vectorStorePGVector', { parameters: { collection: 'handbook' } }), node('off', 'Unused', 'core.calculatorTool', { disabled: true })],
      connections: [
        { id: 'c1', type: 'ai_languageModel', source: 'model', sourceIndex: 0, target: 'lead', targetIndex: 0 },
        { id: 'c2', type: 'ai_memory', source: 'memory', sourceIndex: 0, target: 'lead', targetIndex: 0 },
        { id: 'c3', type: 'ai_tool', source: 'check', sourceIndex: 0, target: 'lead', targetIndex: 0 },
        { id: 'c4', type: 'ai_tool', source: 'planner', sourceIndex: 0, target: 'lead', targetIndex: 0 },
        { id: 'c5', type: 'ai_tool', source: 'kb', sourceIndex: 0, target: 'lead', targetIndex: 0 },
        { id: 'c6', type: 'ai_tool', source: 'off', sourceIndex: 0, target: 'lead', targetIndex: 0 },
        { id: 'c7', type: 'main', source: 'trigger', sourceIndex: 0, target: 'lead', targetIndex: 0 },
      ],
    };
    flow.nodes = flow.nodes.map((n) =>
      n.id === 'model' ? { ...n, parameters: { model: 'qwen3-coder:30b', baseUrl: 'http://host.docker.internal:11434' } } : n.id === 'check' ? { ...n, parameters: { resource: 'branch', operation: 'get', branch: "{{ $fromAI('b') }}" } } : n.id === 'memory' ? { ...n, parameters: { turns: 40 } } : n,
    );
    const asked: Array<{ node: string; flow: { model: boolean; memory: boolean } }> = [];
    const drafts: JournalDraft[] = [];
    const translator = createTranslator({
      workflow: flow,
      executionId: 'ex_c',
      emit: (d) => drafts.push(d),
      connectionsOf: (n, given) => {
        asked.push({ node: n.id, flow: given });
        return n.id === 'lead' ? [{ kind: 'model', name: 'qwen3-coder:30b', detail: 'from the agent' }, { kind: 'skill', name: 'Review a PR' }] : undefined;
      },
    });
    translator.feed({ type: 'execution.started', executionId: 'ex_c', workflowId: flow.id, mode: 'manual', at: at() });
    translator.feed({ ...started('lead'), executionId: 'ex_c' } as ExecutionEvent);
    const lead = spanStart(drafts, 'node:lead:0')!;
    expect(lead.actor.connections).toEqual([
      { kind: 'model', name: 'qwen3-coder:30b', detail: 'qwen3-coder (Ollama) · host.docker.internal:11434', nodeType: 'core.ollamaChatModel', from: 'flow' },
      { kind: 'memory', name: 'Memory', detail: '40 turns', nodeType: 'core.simpleMemory', from: 'flow' },
      { kind: 'knowledge', name: 'Docs', detail: 'handbook', nodeType: 'core.vectorStorePGVector', from: 'flow' },
      // An expression isn't a resource or operation; the plain ones are.
      { kind: 'tool', name: 'Check branch', detail: 'branch · get', nodeType: 'github.github', from: 'flow' },
      { kind: 'skill', name: 'Review a PR' },
      { kind: 'agent', name: 'Planner', nodeType: 'core.a2aAgent', from: 'flow' },
    ]);
    // The host is told the flow gives the model and memory, so it doesn't add the agent's own; the sub-node's wins anyway.
    expect(asked).toContainEqual({ node: 'lead', flow: { model: true, memory: true } });

    // A delegate (an A2A tool sub-node) carries what the host says of it.
    translator.feed({ ...started('planner', { source: 'tool', parentNodeId: 'lead' }), executionId: 'ex_c' } as ExecutionEvent);
    expect(asked.map((a) => a.node)).toContain('planner');
  });
});
