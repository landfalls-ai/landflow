/**
 * Spotlight's hand-offs and voice (docs/assistant.md#test-and-fix, #the-spotlight-panel): a failure only the person can
 * fix is never sent to the model, a test asks before it sends for real, a fix that changes nothing is caught, fix rows
 * say what was done, and replies drop narration and leaked tool-call markup.
 */
import { describe, expect, it } from 'vitest';
import { needsPerson, sameFailure, sendingSteps } from '@/lib/shared/run-check';
import { opsTitle } from '@/lib/shared/assistant-ops';
import { firstSentence } from '@/components/editor/timeline';

const { wastedFix, withoutLeakedMarkup, withoutNarration } = await import('@/lib/server/assistant/chat');

describe('what only the person can fix', () => {
  it('reads credentials, refusals, missing agents and a flow with no start from the error', () => {
    expect(needsPerson("No Header Auth credential selected — choose one in the node's parameters")).toBe('credential');
    expect(needsPerson('Request failed with status code 401')).toBe('credential');
    expect(needsPerson('slack: invalid_auth')).toBe('credential');
    expect(needsPerson('Workflow has no start node')).toBe('trigger');
    expect(needsPerson('No agent selected')).toBe('agent');
    expect(needsPerson("Cannot read properties of undefined (reading 'description')")).toBeUndefined();
    expect(needsPerson(undefined)).toBeUndefined();
  });

  it('tells the same failure apart from a new one, whatever the numbers', () => {
    expect(sameFailure('failed at “Post”: timeout after 3012 ms')).toBe(sameFailure('failed at “Post”: timeout after 2990 ms'));
    expect(sameFailure('failed at “Post”: no credential')).not.toBe(sameFailure('failed at “Triage”: no credential'));
  });

  it('lists the steps a test would run for real', () => {
    expect(
      sendingSteps([
        { name: 'Fetch', type: 'core.httpRequest', parameters: { method: 'GET' } },
        { name: 'Post to Slack', type: 'core.httpRequest', parameters: { method: 'POST' } },
        { name: 'Notify', type: 'slack.slack', parameters: { operation: 'sendMessage' } },
        { name: 'Read', type: 'slack.slack', parameters: { operation: 'getHistory' } },
        { name: 'Shape', type: 'core.set', parameters: {} },
      ]),
    ).toEqual(['Post to Slack', 'Notify']);
  });
});

describe('fix rows and wasted fixes', () => {
  it('titles a change by what it did', () => {
    expect(opsTitle([{ op: 'setParameters', node: 'Post to Slack', parameters: { channel: '#a' } }])).toBe('Set channel on “Post to Slack”');
    expect(opsTitle([{ op: 'addNode', type: 'core.set', name: 'Format', before: 'Post' }])).toBe('Added “Format” before “Post”');
    expect(opsTitle([{ op: 'connect', from: 'A', to: 'B' }])).toBe('Connected “A” to “B”');
    expect(
      opsTitle([
        { op: 'setParameters', node: 'Post', parameters: { a: 1 } },
        { op: 'setNodeSettings', node: 'Post', settings: { retryOnFail: true } },
      ]),
    ).toBe('Changed 2 things at “Post”');
  });

  const workflow = {
    id: 'w',
    name: 'w',
    nodes: [
      { id: 't', name: 'Webhook', type: 'core.webhook', position: [0, 0], parameters: {} },
      { id: 'a', name: 'Triage', type: 'core.set', position: [280, 0], parameters: {} },
      { id: 'p', name: 'Post', type: 'core.httpRequest', position: [560, 0], parameters: {} },
      { id: 'x', name: 'Archive', type: 'core.set', position: [560, 200], parameters: {} },
    ],
    connections: [
      { source: 't', target: 'a', type: 'main', sourceIndex: 0, targetIndex: 0 },
      { source: 'a', target: 'p', type: 'main', sourceIndex: 0, targetIndex: 0 },
      { source: 'a', target: 'x', type: 'main', sourceIndex: 0, targetIndex: 0 },
    ],
  } as never;

  it('sends back a fix that misses the failing step, or removes and re-adds it', () => {
    expect(wastedFix([{ op: 'setParameters', node: 'Archive', parameters: { a: 1 } }], workflow, 'p')).toMatch(/failed at “Post”/);
    expect(wastedFix([{ op: 'setParameters', node: 'Triage', parameters: { a: 1 } }], workflow, 'p')).toBeUndefined();
    expect(wastedFix([{ op: 'removeNode', node: 'Post' }, { op: 'addNode', type: 'core.httpRequest', name: 'Post 2', after: 'Triage' }], workflow, 'p')).toMatch(/changes nothing/);
    expect(wastedFix([{ op: 'addNode', type: 'core.noOp', name: 'Pass', after: 'Triage' }], workflow, 'p')).toMatch(/No Operation/);
  });
});

describe('the reply voice', () => {
  it('drops narration but keeps the answer', () => {
    expect(withoutNarration('Let me check the run data. “Triage” got an empty message. I set it to read the body.')).toBe('“Triage” got an empty message. I set it to read the body.');
    expect(withoutNarration('Let me check.')).toBe('Let me check.');
  });

  it('drops leaked tool-call markup, closed or not', () => {
    expect(withoutLeakedMarkup('Fixed it.<function=propose_changes><parameter=ops>[]</parameter></function>')).toBe('Fixed it.');
    expect(withoutLeakedMarkup('Done. <function=get_run_data><parameter=node>Post')).toBe('Done.');
    expect(withoutLeakedMarkup('<think>hmm</think>Set the channel.')).toBe('Set the channel.');
  });

  it('cuts the first sentence where a sentence ends', () => {
    expect(firstSentence('Use a filter, e.g. on status. Then post.')).toBe('Use a filter, e.g. on status.');
    expect(firstSentence('It stopped at “Step 2. Send” again. More here.')).toBe('It stopped at “Step 2. Send” again.');
  });
});
