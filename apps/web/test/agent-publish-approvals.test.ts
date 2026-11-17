// @vitest-environment happy-dom
/**
 * AG05 (wave ag1): a publish you can follow, a held verdict that stays, and approval cards that settle.
 * `publishAgentFor` says "publishing" with the eval gate's case count and keeps a held verdict on the row (never `skipEval`);
 * a decided tool call has no Approve or Deny and reads "Approved" or "Denied"; a 409 "Already approved" refreshes quietly;
 * two calls waiting together get one Approve all (n) that decides them in order, each once. The browser's HTTP client is a
 * double; the editor's stores, the run hook and the timeline are the real ones.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, TimelineEntry } from '@/lib/shared/agents';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-publish-approvals-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

// The browser's client: each path answers from `answers` (a function may defer); the streamed calls are kept in order.
const wire = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method?: string; json?: unknown }>,
  answers: {} as Record<string, (init: { method?: string; json?: unknown }) => Promise<unknown>>,
  streams: [] as Array<{ path: string; body: Record<string, unknown> }>,
  streamFails: undefined as undefined | ((body: Record<string, unknown>) => Error | undefined),
}));
vi.mock('@/lib/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/client/api')>()),
  api: vi.fn((path: string, init: { method?: string; json?: unknown } = {}) => {
    wire.calls.push({ path, ...init });
    const answer = wire.answers[`${init.method ?? 'GET'} ${path}`];
    return answer ? answer(init) : Promise.reject(new Error(`unexpected ${init.method ?? 'GET'} ${path}`));
  }),
  streamEvents: vi.fn(async (path: string, body: Record<string, unknown>, onEvent: (name: string, data: unknown) => void) => {
    wire.streams.push({ path, body });
    const failure = wire.streamFails?.(body);
    if (failure) throw failure;
    onEvent('message', { type: 'run.finished', sessionId: 's1', status: 'awaiting_approval', reason: 'awaiting_approval', usage: { inputTokens: 0, outputTokens: 0 } });
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/agents/ag_1', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

const { ApiError } = await import('@/lib/client/api');
const { publishLine } = await import('@/lib/shared/agent-card');
const { useAssistant } = await import('@/components/editor/assistant');
const { publishAgentFor } = await import('@/components/editor/new-agent');
const { agentStep } = await import('@/components/editor/timeline');
const { useAgentRun } = await import('@/components/agents/use-agent-run');
const { timelineItems } = await import('@/components/agents/timeline');
const { AgentBuilder } = await import('@/components/agents/builder');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  Object.assign(wire, { calls: [], answers: {}, streams: [], streamFails: undefined });
  useAssistant.setState({ agents: [] });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const progress = () => useAssistant.getState().agents.find((a) => a.nodeId === 'n1')!;
const seedRow = () => useAssistant.getState().setAgent('n1', { name: 'Watcher', state: 'tested', agentId: 'ag_1', smoke: { state: 'passed' } });
const heldBody = { gate: { verdict: { ok: false, average: 2.3, reason: 'Two answers missed the point.' } } };

describe('publishing is followed (AG05)', () => {
  it('says publishing with the case count before the publish answers, then published', async () => {
    seedRow();
    let finish: (v: unknown) => void = () => {};
    wire.answers['GET /api/agents/ag_1/eval-gate'] = async () => ({ cases: [{}, {}, {}], runs: [] });
    wire.answers['POST /api/agents/ag_1/publish'] = () => new Promise((resolve) => (finish = resolve));
    const done = publishAgentFor('n1');
    await vi.waitFor(() => expect(progress().publish).toEqual({ state: 'publishing', cases: 3 }));
    expect(progress().state).toBe('publishing');
    const during = agentStep(progress());
    expect(during.icon).toBe('busy');
    expect(during.text).toBe('Agent “Watcher” publishing: the eval gate runs 3 cases…');
    finish({ agent: {} });
    expect(await done).toBe(true);
    expect(progress()).toMatchObject({ state: 'published', publish: { state: 'published' } });
    expect(agentStep(progress()).text).toBe('Agent “Watcher” tested, 1 of 1 passed · published');
    // Never the eval gate skipped.
    expect(wire.calls.find((c) => c.method === 'POST')?.json).toBeUndefined();
  });

  it('keeps a held verdict on the row after a re-render, with the gate’s score and reason', async () => {
    seedRow();
    wire.answers['GET /api/agents/ag_1/eval-gate'] = async () => ({ cases: [{}, {}], runs: [] });
    wire.answers['POST /api/agents/ag_1/publish'] = async () => {
      throw new ApiError('Held', 409, heldBody);
    };
    expect(await publishAgentFor('n1')).toBe(false);
    expect(progress().state).toBe('tested');
    expect(progress().publish).toEqual({ state: 'held', score: 2.3, reason: 'Two answers missed the point.' });
    expect(publishLine(progress().publish)).toBe('held by the eval gate: 2.3 / 5 · Two answers missed the point.');
    expect(progress().held).toBe(publishLine(progress().publish));
    // A re-render (the store read again) says the same.
    expect(agentStep(useAssistant.getState().agents.find((a) => a.nodeId === 'n1')!).text).toBe('Agent “Watcher” tested, 1 of 1 passed · held by the eval gate: 2.3 / 5 · Two answers missed the point.');
    expect(JSON.stringify(wire.calls)).not.toContain('skipEval');
  });
});

// A session with two calls waiting in one turn.
const call = (id: string): TimelineEntry => ({ id: `e_${id}`, type: 'tool', callId: id, tool: 'Send_Email', label: 'Send Email', kind: 'node', input: { to: 'oncall@landflow.test' }, status: 'awaiting_approval', at: '2026-11-17T08:00:00Z' } as TimelineEntry);
const session = (decided: Record<string, 'approved' | 'denied'> = {}): AgentSession =>
  ({
    id: 's1',
    agentId: 'ag_1',
    timeline: [call('c1'), call('c2')],
    status: 'awaiting_approval',
    usage: { inputTokens: 0, outputTokens: 0 },
    traceIds: [],
    pending: { calls: ['c1', 'c2'].map((callId) => ({ callId, tool: 'Send_Email', input: {}, ...(decided[callId] && { decision: decided[callId] }) })), results: [], iterations: 1 },
  }) as unknown as AgentSession;

let run: ReturnType<typeof useAgentRun>;
const Probe = ({ initial }: { initial: AgentSession }) => {
  run = useAgentRun('ag_1', initial);
  return createElement(Fragment, null, ...timelineItems({ entries: run.entries, onDecide: (id, ok) => void run.decide(id, ok), decisions: run.decisions, onDecideAll: (ids, ok) => void run.decideAll(ids, ok) }));
};
const labels = () => [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
const mount = async (initial: AgentSession) => {
  await act(async () => root.render(createElement(Probe, { initial })));
};

describe('approval cards settle (AG05)', () => {
  it('a decided call has no buttons and reads Approved', async () => {
    await mount(session({ c1: 'approved' }));
    expect(container.querySelectorAll('[data-testid="tool-decision"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="tool-decision"]')?.textContent).toContain('Approved');
    // Only c2 is still waiting: one Approve and one Deny, no "all".
    expect(labels().filter((l) => l === 'Approve')).toHaveLength(1);
    expect(labels().some((l) => l?.startsWith('Approve all'))).toBe(false);
  });

  it('a 409 "Already approved" refreshes quietly: no error row', async () => {
    await mount(session());
    wire.streamFails = () => new ApiError('Already approved', 409);
    wire.answers['GET /api/agents/ag_1/sessions/s1'] = async () => ({ session: session({ c1: 'approved' }) });
    await act(async () => {
      await run.decide('c1', true);
    });
    expect(run.entries.some((e) => e.type === 'error')).toBe(false);
    expect(run.decisions.c1).toBe('approved');
    expect(wire.calls.some((c) => c.path === '/api/agents/ag_1/sessions/s1')).toBe(true);
    expect(container.textContent).not.toContain('Already');
  });

  it('two calls waiting: Approve all (2) posts both ids in order, once each, and both read Approved', async () => {
    await mount(session());
    expect(labels()).toContain('Approve all (2)');
    const all = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Approve all'))!;
    await act(async () => {
      all.click();
    });
    await vi.waitFor(() => expect(wire.streams).toHaveLength(2));
    expect(wire.streams.map((s) => s.body)).toEqual([
      { callId: 'c1', approved: true },
      { callId: 'c2', approved: true },
    ]);
    expect(wire.streams.every((s) => s.path === '/api/agents/ag_1/sessions/s1/approvals')).toBe(true);
    expect([...container.querySelectorAll('[data-testid="tool-decision"]')].map((n) => n.textContent?.slice(0, 8))).toEqual(['Approved', 'Approved']);
    expect(labels().filter((l) => l === 'Approve' || l === 'Deny' || l?.includes('all'))).toEqual([]);
    // Deciding a settled call again sends nothing.
    await act(async () => {
      await run.decide('c1', true);
    });
    expect(wire.streams).toHaveLength(2);
  });
});

describe('the agent page follows the publish (AG05)', () => {
  const agent = { id: 'ag_1', name: 'Watcher', description: 'Watches', instructions: 'Watch.', model: { provider: 'ollama', model: 'm' }, tools: [], skills: [], schedules: [], channels: [], memory: { crossSession: false }, settings: {}, history: [], createdAt: 'x', updatedAt: 'x' };
  const publishBodies: unknown[] = [];

  it('keeps the held verdict as a notice after 20 s, and Publish anyway sends skipEval only on that click', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      publishBodies.length = 0;
      wire.answers['GET /api/agents/ag_1'] = async () => ({ agent });
      wire.answers['GET /api/agents/ag_1/eval-gate'] = async () => ({ cases: [{}, {}, {}], runs: [] });
      wire.answers['POST /api/agents/ag_1/publish'] = async (init) => {
        publishBodies.push(init.json);
        if ((init.json as { skipEval?: boolean }).skipEval) return { agent: { ...agent, published: { version: 1, publishedAt: 'x', config: agent } } };
        throw new ApiError('Held', 409, heldBody);
      };
      await act(async () => root.render(createElement(AgentBuilder, { agentId: 'ag_1' })));
      await vi.waitFor(() => expect(container.textContent).toContain('Watcher'));
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[title^="Publish the draft"]')?.click();
      });
      await vi.waitFor(() => expect(container.querySelector('[data-testid="publish-notice"]')?.textContent).toContain('held by the eval gate: 2.3 / 5 · Two answers missed the point.'));
      expect(publishBodies).toEqual([{ skipEval: false }]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(container.querySelector('[data-testid="publish-notice"]')?.textContent).toContain('held by the eval gate: 2.3 / 5');
      expect(publishBodies).toHaveLength(1);
      const anyway = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Publish anyway')!;
      await act(async () => {
        anyway.click();
      });
      await vi.waitFor(() => expect(publishBodies).toEqual([{ skipEval: false }, { skipEval: true }]));
      await vi.waitFor(() => expect(container.querySelector('[data-testid="publish-notice"]')).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});
