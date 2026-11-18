// @vitest-environment happy-dom
/** Final live run, item 3: the note's "(now)" marks the mode in effect, not "Autonomous" while Asks first is selected. */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
const { AutonomousExplainer } = await import('@/components/editor/spotlight/proposal');
const { useAutonomyFacts } = await import('@/components/editor/spotlight-autonomy');
const { useEditor } = await import('@/components/editor/store');

function note(facts: { switchOn: boolean; bornEmpty: boolean; published: boolean }): string {
  useEditor.setState({ workflowId: 'wf1' } as never);
  useAutonomyFacts.setState({ switchOn: facts.switchOn, workflows: { wf1: { bornEmpty: facts.bornEmpty, published: facts.published } } });
  const el = document.createElement('div');
  document.body.append(el);
  act(() => createRoot(el).render(createElement(AutonomousExplainer, { onClose: () => {} })));
  return el.textContent ?? '';
}

describe('the Autonomous or Asks first note', () => {
  it('marks Asks first as now when the switch is off, and Autonomous only on a new draft with the switch on', () => {
    expect(note({ switchOn: false, bornEmpty: true, published: false })).toMatch(/Asks first \(now\)/);
    expect(note({ switchOn: false, bornEmpty: true, published: false })).not.toMatch(/Autonomous \(now\)/);
    expect(note({ switchOn: true, bornEmpty: true, published: false })).toMatch(/Autonomous \(now\)/);
    // Switch on, but the workflow is saved: Spotlight asks first anyway.
    expect(note({ switchOn: true, bornEmpty: false, published: false })).toMatch(/Asks first \(now\)/);
  });
});
