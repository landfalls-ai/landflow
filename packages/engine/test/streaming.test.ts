/** Streaming chunks (ctx.sendChunk → node.chunk events), per-node rate limits, and nodes that run again on resume. */
import { describe, expect, it } from 'vitest';
import { defineNode, type INodeType, type JsonObject } from '@landflow/sdk';
import { executeWorkflow, inProcessNodeType, RateLimiter, type ExecutionEvent, type NodeTypeResolver, type ResumeState, type Workflow, type WorkflowNode } from '../src';

const main = [{ type: 'main' as const }];

const trigger = defineNode({
  description: { name: 'trigger', displayName: 'Trigger', description: '', version: 1, kind: 'trigger', inputs: [], outputs: main, properties: [] },
  execute: (ctx) => [ctx.getInputData()],
});

/** Streams "Hel", "lo" when someone listens; returns the whole text either way. */
const talker = defineNode({
  description: { name: 'talker', displayName: 'Talker', description: '', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
  execute(ctx) {
    ctx.sendChunk?.({ type: 'begin', itemIndex: 0 });
    for (const delta of ['Hel', 'lo']) ctx.sendChunk?.({ type: 'item', content: delta, itemIndex: 0 });
    ctx.sendChunk?.({ type: 'end', itemIndex: 0 });
    return [[{ json: { text: 'Hello', streamed: Boolean(ctx.sendChunk) } }]];
  },
});

const counter = defineNode({
  description: { name: 'counter', displayName: 'Counter', description: '', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
  execute: (ctx) => [ctx.getInputData().map((item) => ({ json: { ...item.json, at: Date.now() } }))],
});

/** Waits once with `rerun`, then answers with what the resume handed it. */
const approver = defineNode({
  description: { name: 'approver', displayName: 'Approver', description: '', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
  execute(ctx) {
    const state = ctx.getNodeState!<{ asked?: number; $resume?: { kind: string; data?: JsonObject } }>();
    if (!state?.$resume) {
      ctx.setNodeState!({ asked: (state?.asked ?? 0) + 1 });
      ctx.putExecutionToWait!({ resume: 'webhook', rerun: true, data: { approval: true } });
      return [[]];
    }
    ctx.setNodeState!(undefined);
    return [[{ json: { asked: state.asked ?? 0, kind: state.$resume.kind, decision: state.$resume.data ?? null, input: ctx.getInputData()[0]?.json ?? null } }]];
  },
});

const registry: Record<string, INodeType> = { trigger, talker, counter, approver };
const resolver: NodeTypeResolver = {
  resolve(type) {
    const node = registry[type.replace(/^t\./, '')];
    return node ? inProcessNodeType('t', node) : { error: `Unknown node type "${type}"` };
  },
};

const node = (id: string, type: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type: `t.${type}`, typeVersion: 1, position: [0, 0], parameters: {}, ...extra });
const chain = (...nodes: WorkflowNode[]): Workflow => ({
  id: 'wf',
  name: 'wf',
  nodes,
  connections: nodes.slice(1).map((target, i) => ({ id: `c${i}`, type: 'main', source: nodes[i].id, sourceIndex: 0, target: target.id, targetIndex: 0 })),
});

describe('streaming', () => {
  it('turns ctx.sendChunk into node.chunk events when streaming', async () => {
    const events: ExecutionEvent[] = [];
    const result = await executeWorkflow({ workflow: chain(node('T', 'trigger'), node('A', 'talker')), resolver, executionId: 'ex1', mode: 'chat', streaming: true, onEvent: (e) => events.push(e) });
    expect(result.status).toBe('success');
    const chunks = events.filter((e): e is Extract<ExecutionEvent, { type: 'node.chunk' }> => e.type === 'node.chunk');
    expect(chunks.map((c) => c.chunk.type)).toEqual(['begin', 'item', 'item', 'end']);
    expect(chunks.map((c) => c.chunk.content ?? '').join('')).toBe('Hello');
    expect(chunks[0]).toMatchObject({ nodeId: 'A', nodeName: 'A', executionId: 'ex1' });
    expect(result.runData.A[0].outputs[0][0].json).toEqual({ text: 'Hello', streamed: true });
  });

  it('gives nodes no sendChunk when nobody listens', async () => {
    const events: ExecutionEvent[] = [];
    const result = await executeWorkflow({ workflow: chain(node('T', 'trigger'), node('A', 'talker')), resolver, executionId: 'ex2', mode: 'manual', onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.type === 'node.chunk')).toBe(false);
    expect(result.runData.A[0].outputs[0][0].json.streamed).toBe(false);
  });
});

describe('rate limits', () => {
  it('queues calls over the limit until the window has room', async () => {
    const limiter = new RateLimiter();
    const limit = { limit: 2, intervalSeconds: 0.2 };
    const started = Date.now();
    const waits = await Promise.all([1, 2, 3, 4, 5].map(() => limiter.acquire('k', limit)));
    const elapsed = Date.now() - started;
    expect(waits.filter((w) => w < 50)).toHaveLength(2);
    // Calls 3–4 wait one window, call 5 two.
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(limiter.usage('k')).toBeLessThanOrEqual(2);
  });

  it('keeps keys apart and lets a canceled turn go', async () => {
    const limiter = new RateLimiter();
    const limit = { limit: 1, intervalSeconds: 5 };
    await limiter.acquire('a', limit);
    expect(await limiter.acquire('b', limit)).toBeLessThan(50);
    const controller = new AbortController();
    const queued = limiter.acquire('a', limit, controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow('canceled');
  });

  it('spaces out a node used several times in a run and logs the wait', async () => {
    const limiter = new RateLimiter();
    const events: ExecutionEvent[] = [];
    const nodes = [node('T', 'trigger'), node('C1', 'counter', { rateLimit: { limit: 1, intervalSeconds: 0.15 } })];
    // The same node twice through a loop-free chain: run the workflow twice against one limiter.
    const workflow = chain(...nodes);
    const first = await executeWorkflow({ workflow, resolver, executionId: 'r1', mode: 'trigger', rateLimiter: limiter });
    const second = await executeWorkflow({ workflow, resolver, executionId: 'r2', mode: 'trigger', rateLimiter: limiter, onEvent: (e) => events.push(e) });
    const gap = Number(second.runData.C1[0].outputs[0][0].json.at) - Number(first.runData.C1[0].outputs[0][0].json.at);
    expect(gap).toBeGreaterThanOrEqual(120);
    expect(events.some((e) => e.type === 'node.log' && e.message.startsWith('Rate limit (1 per 0.15 s): waited'))).toBe(true);
  });

  it('shares a credential’s limit between different nodes and runs, next to their own', async () => {
    const limiter = new RateLimiter();
    const events: ExecutionEvent[] = [];
    const credentialRateLimits = (n: WorkflowNode) => (n.credentials?.api ? [{ key: `credential:${n.credentials.api.id}`, name: n.credentials.api.name, limit: { limit: 1, intervalSeconds: 0.15 } }] : []);
    const withCredential = (id: string, type: string) => node(id, type, { credentials: { api: { id: 'cred_1', name: 'Shared API' } } });
    // Two different nodes use the same credential: the second waits for the first's turn.
    const workflow = chain(node('T', 'trigger'), withCredential('C1', 'counter'), withCredential('C2', 'counter'));
    const result = await executeWorkflow({ workflow, resolver, executionId: 'k1', mode: 'trigger', rateLimiter: limiter, credentialRateLimits, onEvent: (e) => events.push(e) });
    const gap = Number(result.runData.C2[0].outputs[0][0].json.at) - Number(result.runData.C1[0].outputs[0][0].json.at);
    expect(gap).toBeGreaterThanOrEqual(120);
    expect(events.some((e) => e.type === 'node.log' && e.nodeId === 'C2' && e.message.startsWith('Rate limit of credential "Shared API" (1 per 0.15 s): waited'))).toBe(true);
    // Another run shares the same window; a node without the credential is not held.
    const other = chain(node('T', 'trigger'), node('Free', 'counter'), withCredential('C3', 'counter'));
    const started = Date.now();
    const second = await executeWorkflow({ workflow: { ...other, id: 'other' }, resolver, executionId: 'k2', mode: 'trigger', rateLimiter: limiter, credentialRateLimits });
    expect(second.status).toBe('success');
    expect(Number(second.runData.Free[0].outputs[0][0].json.at) - started).toBeLessThan(100);
  });

  it('stops waiting when the run is canceled', async () => {
    const limiter = new RateLimiter();
    const workflow = chain(node('T', 'trigger'), node('C1', 'counter', { rateLimit: { limit: 1, intervalSeconds: 60 } }));
    await executeWorkflow({ workflow, resolver, executionId: 'c1', mode: 'trigger', rateLimiter: limiter });
    const controller = new AbortController();
    const run = executeWorkflow({ workflow, resolver, executionId: 'c2', mode: 'trigger', rateLimiter: limiter, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    expect((await run).status).toBe('canceled');
  });
});

describe('rerun on resume', () => {
  it('runs the waiting node again with its input and the resume payload in $resume', async () => {
    const workflow = chain(node('T', 'trigger'), node('Ap', 'approver'), node('After', 'counter'));
    const first = await executeWorkflow({ workflow, resolver, executionId: 'w1', mode: 'manual', triggerItems: [{ json: { q: 1 } }] });
    expect(first.status).toBe('waiting');
    expect(first.wait).toMatchObject({ nodeName: 'Ap', resume: 'webhook', rerun: true, data: { approval: true } });
    expect(first.resumeState?.waiting.rerun).toBe(true);
    const resumed = await executeWorkflow({
      workflow,
      resolver,
      executionId: 'w1',
      mode: 'manual',
      resume: { state: first.resumeState as ResumeState, kind: 'approval', outputs: [[{ json: { approved: ['call_1'] } }]] },
    });
    expect(resumed.status).toBe('success');
    expect(resumed.runData.Ap).toHaveLength(1);
    expect(resumed.runData.Ap[0].outputs[0][0].json).toEqual({ asked: 1, kind: 'approval', decision: { approved: ['call_1'] }, input: { q: 1 } });
    expect(resumed.runData.After).toHaveLength(1);
  });
});
