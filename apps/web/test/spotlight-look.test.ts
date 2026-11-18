/**
 * Spotlight's look (docs/assistant.md#the-spotlight-panel): a session reads as a ledger. Runs are one row each, *Run 3 ·
 * “Post to Slack” · No Bearer Auth credential selected*, numbered on through the conversation, and a finished session
 * folds to *Tested 3× · 2 fixes · stopped*.
 */
import { describe, expect, it } from 'vitest';
import { foldLine, lastOutcomeOf, logRead, nextRound, runRow, sessionFold, stepsOf } from '@/components/editor/timeline';
type ChatItem = import('@/components/editor/assistant').ChatItem;

describe('a run as one row', () => {
  it('names the node and the first clause of why', () => {
    expect(runRow({ round: 1, state: 'failed', summary: "failed at “Post to Slack”: No Bearer Auth credential selected — choose one in the node's parameters" })).toEqual({ node: 'Post to Slack', reason: 'No Bearer Auth credential selected' });
    expect(runRow({ round: 2, state: 'failed', summary: 'failed at “Prepare”: Expression error. Parameter "fields" broke' })).toEqual({ node: 'Prepare', reason: 'Expression error' });
    expect(runRow({ round: 3, state: 'passed', summary: '4 steps' })).toEqual({ reason: 'passed · 4 steps' });
    expect(runRow({ round: 4, state: 'running' })).toEqual({ reason: 'running…' });
    expect(runRow({ round: 5, state: 'failed', summary: `failed at “X”: ${'a'.repeat(120)}` }).reason).toHaveLength(89);
  });
});

const session = (testId: string, first: number, last: 'passed' | 'failed', fixes = 1): ChatItem[] => [
  { id: `${testId}r1`, role: 'assistant', testId, parts: [{ kind: 'run', run: { round: first, state: 'failed', summary: 'failed at “Post”: timeout' } }] },
  ...Array.from({ length: fixes }, (_, i): ChatItem => ({ id: `${testId}f${i}`, role: 'assistant', testId, parts: [{ kind: 'proposal', proposal: { id: `${testId}p${i}`, summary: 'Retry', ops: [], dropped: [], warnings: [], state: 'applied' } }] })),
  { id: `${testId}r2`, role: 'assistant', testId, parts: [{ kind: 'run', run: { round: first + 1, state: last, summary: last === 'passed' ? '3 steps' : 'failed at “Post”: timeout' } }] },
];

describe('the session as a ledger', () => {
  it('numbers runs on through the conversation', () => {
    expect(nextRound([])).toBe(1);
    expect(nextRound([...session('a', 1, 'failed'), ...session('b', 3, 'passed')])).toBe(5);
  });

  it('folds a finished session to one line, not the one running', () => {
    const items = session('a', 1, 'failed', 2);
    expect(sessionFold(items, 'a', false)).toEqual({ testId: 'a', runs: 2, fixes: 2, state: 'failed' });
    expect(foldLine(sessionFold(items, 'a', false)!)).toBe('Tested 2× · 2 fixes · stopped');
    expect(foldLine(sessionFold(session('b', 1, 'passed', 0), 'b', false)!)).toBe('Tested 2× · passed');
    expect(sessionFold(items, 'a', true)).toBeUndefined();
  });

 it('counts an agent fix the session made as a fix too: two flow fixes and one agent fix are three', () => {
    const items = session('a', 1, 'failed', 2);
    items.splice(2, 0, { id: 'ac', role: 'assistant', testId: 'a', parts: [{ kind: 'agentCard', card: { name: 'Short writer', state: 'created' } as never }] } as ChatItem);
    items.splice(3, 0, { id: 'ad', role: 'assistant', testId: 'a', parts: [{ kind: 'agentCard', card: { name: 'Other', state: 'designed' } as never }] } as ChatItem);
    expect(foldLine(sessionFold(items, 'a', false)!)).toBe('Tested 2× · 3 fixes · stopped');
  });

  it('calls a pass the review said no to stopped, in the fold and as the last outcome', () => {
    const items: ChatItem[] = [
      { id: 'u', role: 'user', text: 'Shape the headline' },
      ...session('a', 1, 'passed'),
      { id: 'o', role: 'assistant', parts: [{ kind: 'outcome', outcome: { text: 'It runs, but doesn’t do all you asked yet.', fixes: [], edits: 4 } }] },
    ];
    expect(sessionFold(items, 'a', false)?.state).toBe('failed');
    expect(lastOutcomeOf(items)?.text).toMatch(/It runs/);
    // A new message, or a run after it, and that outcome no longer holds.
    expect(lastOutcomeOf([...items, { id: 'u2', role: 'user', text: 'Again' }])).toBeUndefined();
    expect(sessionFold([...items, { id: 'u2', role: 'user', text: 'Again' }], 'a', false)?.state).toBe('failed');
    expect(sessionFold(session('b', 1, 'passed'), 'b', false)?.state).toBe('passed');
  });

  it('writes the run rows and the outcome in the same words', () => {
    const items: ChatItem[] = [
      { id: 'u', role: 'user', text: 'Post tickets to Slack' },
      ...session('a', 1, 'failed'),
      { id: 'o', role: 'assistant', parts: [{ kind: 'outcome', outcome: { text: 'The last fix didn’t change the error at “Post”, so I undid it.', node: 'Post', fixes: [], edits: 3 } }] },
    ];
    expect(stepsOf(items).steps.map((s) => s.text)).toEqual(['Run 1 · “Post” · timeout', 'Fixed · Changed nothing', 'Run 2 · “Post” · timeout', 'Stopped · The last fix didn’t change the error at “Post”, so I undid it.']);
  });
});

describe('undoing all of a session’s fixes', () => {
  it('counts edits, and undoing a replaced graph is an edit of its own', async () => {
    const { useEditor } = await import('@/components/editor/store');
    const before = useEditor.getState().edits;
    const undo = useEditor.getState().replaceGraph({ ...useEditor.getState().toWorkflow(), nodes: [], connections: [] });
    const applied = useEditor.getState().edits;
    expect(applied).toBe(before + 1);
    undo();
    // Changed since the fix: an outcome card holding `applied` no longer offers Undo all.
    expect(useEditor.getState().edits).toBe(applied + 1);
  });
});

describe('a fix that read the run log (AG20)', () => {
  const fixReply = (steps: Array<{ id: string; label: string; kind: 'tool'; status: 'ok' }>): ChatItem => ({
    id: 'fx',
    role: 'assistant',
    testId: 't1',
    steps,
    parts: [
      { kind: 'text', text: '“Post report” sent no report_text. The rest is explained here.' },
      { kind: 'proposal', proposal: { id: 'fxp', summary: 'Send the body as report_text', ops: [{ op: 'setParameters', node: 'Post report', parameters: { body: { report_text: 'x' } } }], dropped: [], warnings: [], state: 'applied' } },
    ],
  } as never);

  it('reads as a row, with the cause in one clause under Fixed', () => {
    const item = fixReply([{ id: 's1', label: 'Read the run log (failed at “Post report”)', kind: 'tool', status: 'ok' }]);
    expect(logRead(item)).toEqual({ label: 'Read the run log (failed at “Post report”)', cause: '“Post report” sent no report_text.' });
    const { steps } = stepsOf([{ id: 'u', role: 'user', text: 'fix it' } as never, item]);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.text).toBe('Read the run log (failed at “Post report”)');
    expect(steps[1]!.text).toMatch(/^Fixed · .+ · “Post report” sent no report_text\.$/);
  });

  it('the Fixed row shows the cause under it', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { ProposalRow } = await import('@/components/editor/spotlight/proposal');
    const proposal = { id: 'fxp', summary: 's', ops: [{ op: 'setParameters', node: 'Post report', parameters: { body: 1 } }], dropped: [], warnings: [], state: 'applied' } as never;
    const html = renderToStaticMarkup(createElement(ProposalRow, { proposal, fix: true, cause: '“Post report” sent no report_text.' }));
    expect(html).toContain('Fixed');
    expect(html).toMatch(/data-testid="fix-cause"[^>]*>“Post report” sent no report_text\./);
    expect(renderToStaticMarkup(createElement(ProposalRow, { proposal, fix: true }))).not.toContain('fix-cause');
  });

  it('is none for a reply that read nothing, or one that is not a session’s', () => {
    expect(logRead(fixReply([]))).toBeUndefined();
    expect(logRead({ ...fixReply([{ id: 's1', label: 'Read the run log', kind: 'tool', status: 'ok' }]), testId: undefined } as never)).toBeUndefined();
  });
});
