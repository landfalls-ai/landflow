// @vitest-environment happy-dom
/**
 * AG24 (wave ag5, items 1 and 6): the eval gate compares like with like. A draft is held against the published version only on the
 * cases both versions ran; when a change replaced the cases it is judged against the 3.0 threshold alone, and says so. A held verdict
 * carries its score and basis in the agent publish route's 409, in the workflow publish's held answer and on the publish card, on the
 * first attempt and every later one. The judge is scripted by the question it is asked; nothing leaves this machine.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from '@landflow/engine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-gate-ag5-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

/** The score the scripted judge gives a case, by a word of its question; the agent always answers "ok". */
const scores = vi.hoisted(() => ({ by: {} as Record<string, number>, fallback: 4 }));
vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => ({
    provider: 'scripted',
    model: config?.model ?? 'x',
    async generate(input) {
      if (!(input.system ?? '').includes('"score"')) return { text: 'Hello, I can help with sales questions.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } };
      const first = input.messages[0];
      const asked = typeof first?.content === 'string' ? first.content : JSON.stringify(first?.content);
      const hit = Object.entries(scores.by).find(([word]) => asked.includes(word));
      return { text: JSON.stringify({ score: hit ? hit[1] : scores.fallback, reasoning: `scripted for ${hit?.[0] ?? 'the rest'}` }), toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } };
    },
  }),
}));

const { agentStore } = await import('@/lib/server/agents/store');
const { addCase, adoptRun, checkPublish, listCases, replaceCases } = await import('@/lib/server/agents/eval-gate');
const { publishAgentChecked } = await import('@/lib/server/agents/publish-first');
const publishRoute = await import('@/app/api/agents/[id]/publish/route');
const { compareRuns } = await import('@/lib/shared/agent-eval');

const makeAgent = () => agentStore.create({ name: 'Short writer', instructions: 'Write a short summary.', model: { provider: 'ollama', model: 'scripted-1' } });

/** An agent published with cases Alpha, Bravo and Charlie that scored 4.3 on average (the adopted run). */
async function published() {
  const agent = makeAgent();
  const old = ['Alpha question', 'Bravo question', 'Charlie question'].map((input) => addCase(agent.id, { input, expected: 'a summary' }));
  scores.by = { Alpha: 4, Bravo: 5, Charlie: 4 };
  const first = await checkPublish(agent.id);
  expect(first.verdict.ok).toBe(true);
  const version = agentStore.publish(agent.id)!.published!.version;
  adoptRun(first.run!, version);
  return { agent, old };
}

describe('the gate on the cases both versions ran', () => {
  it('a change that replaced every case is judged against 3.0 alone: 3.7 against 4.3 on other cases is no hold', async () => {
    const { agent, old } = await published();
    replaceCases(agent.id, old.map((c) => c.id), ['Delta question', 'Echo question', 'Foxtrot question'].map((input) => ({ input, expected: 'figures from the sales database' })));
    scores.by = { Delta: 4, Echo: 4, Foxtrot: 3 };
    const gate = await checkPublish(agent.id);
    expect(gate.verdict).toMatchObject({ ok: true, basis: 'threshold' });
    expect(gate.verdict.average).toBeCloseTo(3.7, 1);
    expect(gate.verdict.shared).toBeUndefined();
  });

  it('the same replacement at 2.7 is held, and the reason names its new cases and the 3.0', async () => {
    const { agent, old } = await published();
    replaceCases(agent.id, old.map((c) => c.id), ['Delta question', 'Echo question', 'Foxtrot question'].map((input) => ({ input })));
    scores.by = { Delta: 3, Echo: 3, Foxtrot: 2 };
    const gate = await checkPublish(agent.id);
    expect(gate.verdict).toMatchObject({ ok: false, basis: 'threshold' });
    expect(gate.verdict.reason).toBe('The draft averages 2.7 / 5 on its new cases, below the 3.0 it asks for.');
    expect(gate.lowCases).toHaveLength(3);
  });

  it('a change that keeps two cases and adds one is compared on the two', async () => {
    const { agent, old } = await published();
    replaceCases(agent.id, [old[2]!.id], [{ input: 'Delta question', expected: 'figures' }]);
    scores.by = { Alpha: 3, Bravo: 4, Delta: 5 }; // on Alpha and Bravo 3.5 against 4.5; the added case lifts the overall average to 4.0
    const gate = await checkPublish(agent.id);
    expect(gate.verdict).toMatchObject({ ok: false, basis: 'same-cases', shared: 2 });
    expect(gate.verdict.reason).toBe("On the 2 cases both versions ran, the draft averages 3.5 / 5, 1.0 below the published version's 4.5.");
    expect(gate.verdict.baseline).toBeCloseTo(4.5, 2);
  });

  it('on the shared cases a drop within half a point passes, and the threshold still holds the whole draft', async () => {
    expect(
      compareRuns(
        { average: 4, results: [1, 2, 3].map((n) => ({ caseId: `c${n}`, input: 'q', reply: '', score: 4, reasoning: '' })) },
        { average: 4.3, results: [1, 2, 3].map((n) => ({ caseId: `c${n}`, input: 'q', reply: '', score: 4.3, reasoning: '' })) },
      ),
    ).toMatchObject({ ok: true, basis: 'same-cases', shared: 3 });
    expect(
      compareRuns(
        { average: 2.8, results: [1, 2].map((n) => ({ caseId: `c${n}`, input: 'q', reply: '', score: 2.8, reasoning: '' })) },
        { average: 3, results: [1, 2].map((n) => ({ caseId: `c${n}`, input: 'q', reply: '', score: 3, reasoning: '' })) },
      ),
    ).toMatchObject({ ok: false, basis: 'same-cases', reason: 'The draft averages 2.8 / 5, below the 3 the gate asks for.' });
  });

  it('a run adopted before ag5 has no case ids: the threshold, said', () => {
    const verdict = compareRuns(
      { average: 3.7, results: [{ caseId: 'n1', input: 'q', reply: '', score: 3.7, reasoning: '' }, { caseId: 'n2', input: 'q', reply: '', score: 3.7, reasoning: '' }] },
      { average: 4.3, results: [{ input: 'old', reply: '', score: 4.3, reasoning: '' }, { input: 'older', reply: '', score: 4.3, reasoning: '' }] as never },
    );
    expect(verdict).toMatchObject({ ok: true, basis: 'threshold' });
  });

  it('an agent with no published version is judged against the threshold, as before', async () => {
    const agent = makeAgent();
    addCase(agent.id, { input: 'Alpha question' });
    scores.by = { Alpha: 2 };
    const gate = await checkPublish(agent.id);
    expect(gate.verdict).toMatchObject({ ok: false, basis: 'threshold', reason: 'The draft averages 2.0 / 5, below the 3 the gate asks for.' });
  });
});

describe('a held verdict carries its score', () => {
  it('the agent publish route answers 409 with the verdict (average, basis, reason) and the lowest cases', async () => {
    const { agent, old } = await published();
    replaceCases(agent.id, old.map((c) => c.id), ['Delta question', 'Echo question', 'Foxtrot question', 'Golf question'].map((input) => ({ input })));
    scores.by = { Delta: 2, Echo: 2, Foxtrot: 3, Golf: 3 };
    const res = await publishRoute.POST(new Request('http://localhost/x', { method: 'POST' }), { params: Promise.resolve({ id: agent.id }) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { gate: { verdict: { ok: boolean; average: number; basis: string; reason: string }; lowCases: Array<{ input: string; score: number; reasoning: string; reply?: string }> } };
    expect(body.gate.verdict).toMatchObject({ ok: false, average: 2.5, basis: 'threshold' });
    expect(body.gate.verdict.reason).toContain('2.5 / 5 on its new cases');
    expect(body.gate.lowCases).toHaveLength(3);
    expect(body.gate.lowCases[0]).toMatchObject({ score: 2 });
    expect(body.gate.lowCases.every((c) => !('reply' in c))).toBe(true);
    expect(agentStore.get(agent.id)!.published!.version).toBe(1);
  });

  it('publishing an agent first (the workflow publish) is held with the score in its message, and the lowest cases (at most 3) in its details', async () => {
    const { agent, old } = await published();
    const long = `Hotel ${'x'.repeat(300)}`;
    replaceCases(agent.id, old.map((c) => c.id), [long, 'Echo question', 'Foxtrot question', 'Golf question'].map((input) => ({ input })));
    scores.by = { Hotel: 1, Echo: 2, Foxtrot: 2, Golf: 2 };
    const outcome = await publishAgentChecked(agent.id);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('The eval gate held “Short writer”: The draft averages 1.8 / 5 on its new cases, below the 3.0 it asks for.');
    const gate = (outcome.details as { gate: { verdict: { average: number; basis: string }; lowCases: Array<{ input: string; score: number; reasoning: string }> } }).gate;
    expect(gate.verdict).toMatchObject({ average: 1.75, basis: 'threshold' });
    expect(gate.lowCases).toHaveLength(3);
    expect(gate.lowCases[0]!.input.length).toBeLessThanOrEqual(160);
    expect(gate.lowCases[0]!.reasoning.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(outcome.details)).not.toContain('I can help with sales');
    expect(listCases(agent.id)).toHaveLength(4);
  });
});

describe('the publish card shows the score on every attempt', () => {
  let root: Root;
  let host: HTMLElement;
  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('a held publish reads as the verdict line, the first time and the second, never the bare message', async () => {
    const { useAssistant } = await import('../src/components/editor/assistant');
    const { useEditor } = await import('../src/components/editor/store');
    const { PublishCardView } = await import('../src/components/editor/spotlight/publish-card');
    useEditor.setState({ workflowId: 'wf1', dirty: false } as never);
    const held = { error: 'The eval gate held “Short writer”: The draft averages 2.7 / 5 on its new cases, below the 3.0 it asks for.', code: 'agent_publish_held', agent: 'a1', gate: { verdict: { ok: false, average: 2.7, basis: 'threshold', reason: 'The draft averages 2.7 / 5 on its new cases, below the 3.0 it asks for.' }, lowCases: [] } };
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/publish')) {
        posts += 1;
        return new Response(JSON.stringify(held), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const offer = { workflowId: 'wf1', kind: 'draft' as const, nextVersion: 2, pins: [{ nodeId: 'n1', agentId: 'a1', agentName: 'Short writer', version: 1 }], blocks: [{ agentId: 'a1', name: 'Short writer', published: 1, changes: ['Tools'] }] };
    useAssistant.getState().append([{ id: 'i1', role: 'assistant', parts: [{ kind: 'publishOffer', offer }] }]);
    function Card() {
      const part = useAssistant((s) => s.items.find((i) => i.id === 'i1')?.parts[0]);
      return part?.kind === 'publishOffer' ? createElement(PublishCardView, { itemId: 'i1', offer: part.offer, card: part.card }) : null;
    }
    await act(async () => root.render(createElement(Card)));
    const press = async () => {
      const button = [...host.querySelectorAll('button')].find((b) => /Publish Short writer first/.test(b.textContent ?? ''));
      expect(button).toBeTruthy();
      await act(async () => {
        button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    };
    await press();
    const line = () => host.querySelector('[data-testid="publish-held"]')?.textContent ?? '';
    expect(line()).toContain('2.7 / 5');
    expect(line()).toContain('judged on its own cases against 3.0');
    expect(line()).toContain('below the 3.0 it asks for');
    expect(host.textContent).not.toContain('The eval gate held “Short writer”');
    await press();
    expect(posts).toBe(2);
    expect(line()).toContain('2.7 / 5');
    expect(Array.from(host.querySelectorAll('button')).some((b) => /as published/.test(b.textContent ?? ''))).toBe(true); // AG21's choice stays where it was
  });
});
