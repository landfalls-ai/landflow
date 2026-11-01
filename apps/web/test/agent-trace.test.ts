/**
 * What Claude Code agents on kagent report through the landflow-harness mod (lib/server/a2a/agent-trace.ts, POST
 * /api/agent-trace/:id): a trace per call, its summary priced from the agent's provider, the route's answers, which calls
 * get a trace (Landflow agents deployed with the mod), and the A2A node's output with the real usage. A team member's
 * trace is tested in run-team.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTraceSummary } from '@/lib/shared/agents';
import type { JournalDraft, JournalEvent } from '@/lib/shared/run-trace';
import { startFakeA2a, type FakeA2a } from './fake-a2a';

const { openTrace, ingestTrace, resetTraces, traceFor, withMarker, usageOfTrace } = await import('@/lib/server/a2a/agent-trace');
const { traceChecks } = await import('@/lib/server/journal/agent-session');
const { traceModelCalls } = await import('@/lib/server/journal/trace-calls');
const { foldJournal } = await import('@/lib/shared/run-trace-model');
const { agentStore } = await import('@/lib/server/agents/store');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { isPublicPath } = await import('@/lib/shared/auth-paths');
const route = await import('@/app/api/agent-trace/[id]/route');
const { runFlow, outputsOf } = await import('./helpers');

const post = (id: string, body: unknown) =>
  route.POST(new Request(`http://landflow.test/api/agent-trace/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) });

const STEP = { type: 'step', ms: 900, model: 'claude-sonnet-5-5', input: 1200, output: 80, cacheRead: 9000, cacheWrite: 300, tools: ['Bash'] };

let fake: FakeA2a;
beforeAll(async () => {
  registry.registerBuiltin(corePlugin);
  fake = await startFakeA2a();
});
afterAll(() => fake.close());
beforeEach(() => {
  resetTraces();
  fake.mod = undefined;
  fake.usage = true;
});

describe('a trace', () => {
  it('sums what the mod reports: usage priced per request, per model and per subagent, tools, guardrails, masks', async () => {
    const trace = openTrace({ baseUrl: 'http://landflow.test:3000/', provider: 'anthropic' });
    expect(trace.url).toBe(`http://landflow.test:3000/api/agent-trace/${trace.id}`);
    expect(trace.marker).toBe(`<!-- landflow-trace ${trace.url} -->`);
    expect(trace.summary()).toBeUndefined();
    const heard: AgentTraceSummary[] = [];
    trace.onChange((s) => heard.push(s));
    expect(
      ingestTrace(trace.id, [
        { type: 'start', mod: '0.2.0', guard: 'enforce' },
        STEP,
        { type: 'spawn', agent: 'sub-1', kind: 'Explore', description: 'Find the tests', model: 'claude-haiku-5-5' },
        { type: 'step', ms: 300, agent: 'sub-1', model: 'claude-haiku-5-5', input: 2000, output: 100, server: ['web_search'] },
        { type: 'tool', ms: 40, tool: 'Bash', ok: true, arg: 'pnpm test' },
        { type: 'tool', ms: 10, tool: 'Read', ok: false },
        { type: 'guard', rule: 'secret-file', tool: 'Read', arg: '/data/workspace/.env', action: 'deny', agent: 'sub-1' },
        { type: 'redact', kinds: ['GitHub token', 'AWS access key'] },
        { type: 'bogus', x: 1 },
        { type: 'step', input: 'many' },
      ]),
    ).toBe('ok');
    const summary = trace.summary()!;
    const sonnet = (1200 * 2 + 9000 * 0.1 + 300 * 2.5 + 80 * 10) / 1e6;
    const haiku = (2000 * 0.1 + 100 * 0.5) / 1e6;
    expect(summary.usage).toMatchObject({ inputTokens: 10_500 + 2000 + 0, outputTokens: 180, cacheReadTokens: 9000, cacheWriteTokens: 300, requests: 3 });
    expect(summary.usage.costUsd).toBeCloseTo(sonnet + haiku, 12);
    expect(summary.models.map((m) => [m.model, m.requests])).toEqual([
      ['claude-sonnet-5-5', 1],
      ['claude-haiku-5-5', 1],
      ['unknown', 1], // a step whose counts don't parse counts as a request with none
    ]);
    expect(summary.agents).toEqual([expect.objectContaining({ id: 'sub-1', kind: 'Explore', description: 'Find the tests', model: 'claude-haiku-5-5', inputTokens: 2000, requests: 1 })]);
    expect(summary).toMatchObject({ tools: { calls: 2, failed: 1, ms: 50 }, modelMs: 1200, serverTools: 1, redacted: 1, redactedKinds: ['GitHub token', 'AWS access key'], mod: '0.2.0', guardMode: 'enforce' });
    expect(summary.guard).toEqual([{ rule: 'secret-file', tool: 'Read', arg: '/data/workspace/.env', action: 'deny', agent: 'sub-1' }]);
    expect(heard).toHaveLength(1);
    expect(usageOfTrace(summary)).toMatchObject({ inputTokens: 12_500, outputTokens: 180, requests: 3, model: 'unknown' });

    // The turn's end: close doesn't wait, and the trace answers "closed" after.
    expect(ingestTrace(trace.id, [{ type: 'turn', ms: 1500 }])).toBe('ok');
    const started = Date.now();
    expect((await trace.close(5_000))!.turnMs).toBe(1500);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(ingestTrace(trace.id, [STEP])).toBe('closed');
    expect(ingestTrace('nope', [STEP])).toBe('unknown');
  });

  it('prices a local model at nothing, marks report mode, and holds at most 5,000 events', async () => {
    const trace = openTrace({ baseUrl: 'http://landflow.test', provider: 'ollama', guard: 'report' });
    expect(trace.marker).toMatch(/ guard=report -->$/);
    ingestTrace(trace.id, [{ ...STEP, model: 'qwen3-coder:30b' }]);
    expect(trace.summary()!.usage.costUsd).toBe(0);
    for (let i = 0; i < 9; i++) expect(ingestTrace(trace.id, Array.from({ length: 500 }, () => ({ type: 'tool', tool: 'Bash' })))).toBe('ok');
    expect(ingestTrace(trace.id, Array.from({ length: 500 }, () => ({ type: 'tool', tool: 'Bash' })))).toBe('full');
    // Nothing came from the agent: close returns at once with nothing.
    const silent = openTrace({ baseUrl: 'http://landflow.test' });
    expect(await silent.close(5_000)).toBeUndefined();
  });

  it('puts the marker on a new request’s text only', () => {
    const trace = openTrace({ baseUrl: 'http://landflow.test' });
    expect(withMarker({ text: 'Review it' }, trace).text).toBe(`${trace.marker}\nReview it`);
    expect(withMarker({ text: 'blue', taskId: 't1' }, trace).text).toBe('blue');
    expect(withMarker({ data: { x: 1 } } as { text?: string }, trace).text).toBeUndefined();
    expect(withMarker({ text: 'Review it' }, undefined).text).toBe('Review it');
  });
});

describe('POST /api/agent-trace/:id', () => {
  it('is public: the trace id is the credential', () => {
    expect(isPublicPath('/api/agent-trace/abc')).toBe(true);
    expect(isPublicPath('/api/agent-traces')).toBe(false);
  });

  it('takes batches while the call runs, then answers 410; 404 for an unknown id, 400 for a body that isn’t one', async () => {
    const trace = openTrace({ baseUrl: 'http://landflow.test' });
    expect((await post(trace.id, { events: [STEP] })).status).toBe(204);
    expect(trace.summary()!.usage.requests).toBe(1);
    expect((await post(trace.id, { events: 'no' })).status).toBe(400);
    expect((await post(trace.id, 'not json')).status).toBe(400);
    expect((await post(trace.id, { events: Array.from({ length: 501 }, () => STEP) })).status).toBe(400);
    expect((await post('A'.repeat(24), { events: [STEP] })).status).toBe(404);
    expect((await post('../../etc', { events: [STEP] })).status).toBe(404);
    await trace.close(0);
    expect((await post(trace.id, { events: [STEP] })).status).toBe(410);
  });
});

describe('which calls are traced', () => {
  const deploy = (name: string, kagentName: string, trace?: { url: string; a2aUrl?: string }) => {
    const agent = agentStore.create({ name, instructions: 'x', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' } });
    agentStore.setKagent(agent.id, { credential: { id: 'cred', name: 'kind' }, name: kagentName, ...(trace && { trace }) } as never);
    return agent;
  };

  it('a Landflow agent deployed with the mod, by its A2A URL or, failing that, its kagent name', () => {
    deploy('Traced', 'tr-traced', { url: 'http://landflow.test:3000/api/agent-trace', a2aUrl: 'http://controller:8083/agents/kagent/tr-traced' });
    deploy('Untraced', 'tr-untraced');
    expect(traceFor('http://controller:8083/agents/kagent/tr-traced/')?.url).toMatch(/^http:\/\/landflow\.test:3000\/api\/agent-trace\/[A-Za-z0-9_-]{24}$/);
    // The same agent reached another way (a port-forward, host.docker.internal).
    expect(traceFor('http://host.docker.internal:58083/agents/kagent/tr-traced')).toBeDefined();
    expect(traceFor('http://controller:8083/agents/kagent/tr-untraced')).toBeUndefined();
    expect(traceFor('http://elsewhere.test/a2a')).toBeUndefined();
    // Two traced agents with that name on different clusters: only the exact URL decides.
    deploy('Twin', 'tr-traced', { url: 'http://other.test/api/agent-trace', a2aUrl: 'http://other:8083/agents/kagent/tr-traced' });
    expect(traceFor('http://host.docker.internal:58083/agents/kagent/tr-traced')).toBeUndefined();
    expect(traceFor('http://other:8083/agents/kagent/tr-traced')?.url).toMatch(/^http:\/\/other\.test\/api\/agent-trace\//);
  });

  it('the A2A node: its item carries the real usage and the trace', async () => {
    const agentUrl = `${fake.url}/agents/kagent/tr-node`;
    deploy('Node target', 'tr-node', { url: 'http://landflow.test/api/agent-trace', a2aUrl: agentUrl });
    fake.usage = false;
    fake.mod = async (text) => {
      const found = /^<!-- landflow-trace (\S+) -->\n/.exec(text);
      if (!found) return text;
      await post(found[1].split('/').pop()!, { events: [STEP, { type: 'turn', ms: 1000 }] });
      return text.slice(found[0].length);
    };
    const result = await runFlow(
      [{ name: 'Ask', type: 'core.a2aAgent', parameters: { agentUrl, authentication: 'none', operation: 'sendMessage', message: 'slug Real Usage', options: { timeout: 5_000 } } }],
      [['Start', 'Ask']],
    );
    const [item] = outputsOf(result, 'Ask')[0] as Array<Record<string, unknown>>;
    expect(item.reply).toBe('The slug is real-usage');
    expect(item.usage).toMatchObject({ inputTokens: 10_500, outputTokens: 80, cacheReadTokens: 9000, requests: 1, model: 'claude-sonnet-5-5' });
    expect((item.usage as { costUsd: number }).costUsd).toBeCloseTo(0.00485, 9);
    expect(item.trace).toMatchObject({ tools: { calls: 0 }, turnMs: 1000 });
    expect(fake.calls.at(-1)!.params.message?.parts?.[0]?.text).toBe('slug Real Usage');
  });
});

describe('the run journal', () => {
  it('records each guardrail stop and the masked secrets as checks on the request', () => {
    const drafts: JournalDraft[] = [];
    const summary = {
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, requests: 0 },
      models: [],
      agents: [],
      tools: { calls: 0, failed: 0, ms: 0 },
      modelMs: 0,
      guard: [
        { rule: 'write-outside-workspace', tool: 'Write', arg: '/etc/profile', action: 'report' as const },
        { rule: 'merge', tool: 'Bash', action: 'deny' as const, reason: 'a person’s call' },
      ],
      redacted: 2,
    };
    traceChecks('Developer', summary, 'run/step:c1', (draft) => void drafts.push(draft));
    expect(drafts.map((d) => d.type === 'check' && [d.spanId, d.check.name, d.check.status, d.check.message])).toEqual([
      ['run/step:c1', 'Guardrail', 'warn', 'Would have stopped Write: /etc/profile (write-outside-workspace)'],
      ['run/step:c1', 'Guardrail', 'warn', 'Stopped Bash (merge: a person’s call)'],
      ['run/step:c1', 'Secrets masked', 'warn', 'Masked secrets in 2 tool results before the model read them'],
    ]);
  });
});

describe('model requests as journal spans', () => {
  const T0 = Date.parse('2026-11-01T09:00:00.000Z');
  const member = { id: 'remote:Developer', name: 'Developer', type: 'agent' as const };

  it('keeps each request on the summary, in order, with its time and price', () => {
    const trace = openTrace({ baseUrl: 'http://landflow.test', provider: 'anthropic' });
    ingestTrace(trace.id, [
      { type: 'step', at: T0 + 2_000, ms: 1_500, model: 'claude-sonnet-5-5', input: 1000, output: 50, cacheRead: 500 },
      { type: 'step', at: T0 + 5_000, ms: 800, agent: 'sub-1', model: 'claude-haiku-5-5', input: 200, output: 20 },
    ]);
    const { calls, usage } = trace.summary()!;
    expect(calls).toEqual([
      expect.objectContaining({ at: T0 + 2_000, ms: 1_500, model: 'claude-sonnet-5-5', inputTokens: 1500, outputTokens: 50, cacheReadTokens: 500 }),
      expect.objectContaining({ ms: 800, agent: 'sub-1', model: 'claude-haiku-5-5', inputTokens: 200 }),
    ]);
    expect(calls!.reduce((sum, c) => sum + c.costUsd, 0)).toBeCloseTo(usage.costUsd, 5);
  });

  it('records one model span per request under the request, and the fold counts it once', async () => {
    const trace = openTrace({ baseUrl: 'http://landflow.test', provider: 'anthropic' });
    ingestTrace(trace.id, [
      { type: 'step', at: T0 + 3_000, ms: 1_000, model: 'claude-sonnet-5-5', input: 1000, output: 100, cacheRead: 400, cacheWrite: 50 },
      { type: 'step', at: T0 + 6_000, ms: 2_000, model: 'claude-sonnet-5-5', input: 500, output: 40 },
    ]);
    const summary = (await trace.close(0))!;
    const drafts: JournalDraft[] = [];
    traceModelCalls(member, summary, 'node:dev:0', (draft) => void drafts.push(draft));
    expect(drafts.map((d) => [d.type, d.spanId])).toEqual([
      ['span.started', 'node:dev:0/model:1'],
      ['span.ended', 'node:dev:0/model:1'],
      ['span.started', 'node:dev:0/model:2'],
      ['span.ended', 'node:dev:0/model:2'],
    ]);
    expect(drafts[0]).toMatchObject({ kind: 'model', name: 'claude-sonnet-5-5', parentSpanId: 'node:dev:0', actor: { id: 'model:claude-sonnet-5-5', type: 'model' }, caller: { id: 'remote:Developer' }, at: new Date(T0 + 2_000).toISOString() });
    expect(drafts[1]).toMatchObject({ status: 'success', at: new Date(T0 + 3_000).toISOString(), usage: { inputTokens: 1450, outputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 50, model: 'claude-sonnet-5-5' } });

    // The fold: the request keeps the mod's totals; the model spans take their share off it, so nothing counts twice.
    const usage = usageOfTrace(summary)!;
    const at = (ms: number) => new Date(T0 + ms).toISOString();
    const events = [
      { type: 'span.started', spanId: 'run', kind: 'run', name: 'Flow', actor: { id: 'workflow', name: 'Flow', type: 'system' }, at: at(0) },
      { type: 'span.started', spanId: 'node:dev:0', parentSpanId: 'run', kind: 'delegate', name: 'Developer', actor: member, at: at(500) },
      ...drafts.map((d) => ({ ...d, at: d.at ?? at(1000) })),
      { type: 'span.ended', spanId: 'node:dev:0', status: 'success', usage, at: at(7_000) },
      { type: 'span.ended', spanId: 'run', status: 'success', at: at(8_000) },
    ].map((e, i) => ({ ...e, seq: i + 1, executionId: 'ex_m' })) as JournalEvent[];
    const model = foldJournal(events);
    expect(model.tokens).toMatchObject({ inputTokens: 1450 + 500, outputTokens: 140 });
    expect(model.order.filter((s) => s.kind === 'model')).toHaveLength(2);
    const dev = model.actors.find((a) => a.actor.id === 'remote:Developer');
    // Whatever the fold credits to the member plus the model spans adds up to the mod's total, once.
    const all = model.actors.reduce((sum, a) => sum + a.tokensIn, 0);
    expect(all).toBe(1950);
    expect(model.actors.reduce((sum, a) => sum + a.modelCalls, 0) + model.order.filter((s) => s.kind === 'model').length).toBeGreaterThanOrEqual(2);
    expect(dev).toBeDefined();
  });

  it("leaves a call without a time to the writer's clock", () => {
    const summary = { usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, requests: 1 }, models: [], agents: [], tools: { calls: 0, failed: 0, ms: 0 }, modelMs: 0, guard: [], redacted: 0, calls: [{ ms: 100, model: 'm1', inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }] };
    const drafts: JournalDraft[] = [];
    traceModelCalls(member, summary, 'run/step:c9', (d) => void drafts.push(d));
    expect(drafts[0]).toMatchObject({ spanId: 'run/step:c9/model:1', parentSpanId: 'run/step:c9', name: 'm1' });
    expect(drafts[0].at).toBeUndefined();
  });
});
