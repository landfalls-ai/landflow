/**
 * The run trace shows what happened in an agentic run whatever "Show developer details" says (docs/run-trace.md,
 * docs/ui-review.md#developer-details): each model call's tokens in the Trace tab, and each agent's model, tokens and
 * cost on its Team card. The switch hides ids and transports only. The preference hook is replaced by a flag, since a
 * server render always reads the defaults.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalEvent } from '../src/lib/shared/run-trace-model';

const flag = vi.hoisted(() => ({ on: false }));
vi.mock('../src/lib/client/preferences', () => ({ usePreference: () => flag.on }));

const { foldJournal } = await import('../src/lib/shared/run-trace-model');
const { Trace } = await import('../src/components/run-trace/trace');
const { ActorCard } = await import('../src/components/run-trace/team');

const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 14, 38, s)).toISOString();
const agent = { id: 'node:lead', name: 'Tech Lead', type: 'agent' } as const;
const events = [
  { type: 'span.started', spanId: 'run', kind: 'run', name: 'Tech Review', actor: { id: 'workflow', name: 'Tech Review', type: 'system' }, at: at(0), seq: 1 },
  { type: 'span.started', spanId: 'node:lead:0', parentSpanId: 'run', kind: 'agent', name: 'Tech Lead', actor: agent, at: at(1), seq: 2 },
  { type: 'span.started', spanId: 'node:model:0', parentSpanId: 'node:lead:0', kind: 'model', name: 'qwen3-coder:30b', actor: { id: 'model:qwen3-coder:30b', name: 'qwen3-coder:30b', type: 'model' }, caller: agent, at: at(2), seq: 3 },
  { type: 'span.ended', spanId: 'node:model:0', status: 'success', output: { text: 'Looking at the branch.' }, usage: { inputTokens: 1964, outputTokens: 62 }, at: at(4), seq: 4 },
  { type: 'span.started', spanId: 'node:lead:0/step:call_1', parentSpanId: 'node:lead:0', kind: 'tool', name: 'Bash', actor: agent, input: { command: 'git status' }, at: at(5), seq: 5 },
  { type: 'span.ended', spanId: 'node:lead:0/step:call_1', status: 'success', output: { result: 'clean' }, at: at(6), seq: 6 },
  { type: 'span.ended', spanId: 'node:lead:0', status: 'success', at: at(7), seq: 7 },
  { type: 'span.ended', spanId: 'run', status: 'success', at: at(8), seq: 8 },
] as unknown as JournalEvent[];

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

beforeEach(() => {
  flag.on = false;
});

describe('an agentic run with developer details off', () => {
  const model = foldJournal(events);

  it('the Trace tab names each model call with its tokens, and the tool step', () => {
    const out = html(createElement(Trace, { model, open: () => {} }));
    expect(out).toContain('1,964 in');
    expect(out).toContain('62 out');
    expect(out).toContain('Bash');
  });

  it("an agent's Team card has its model calls and tokens", () => {
    const stats = model.actors.find((a) => a.actor.id === agent.id);
    expect(stats).toBeDefined();
    const out = html(createElement(ActorCard, { s: stats!, open: () => {} }));
    expect(out).toContain('1 model call');
    expect(out).toContain('1,964 in');
  });
});
