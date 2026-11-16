import { describe, expect, it } from 'vitest';
import { answeredQuestion } from '@/components/editor/spotlight/answered-question';
import type { ChatItem } from '@/components/editor/assistant';

const done = { model: 'test', durationMs: 1, steps: 1 };
const user = (text: string, extra: object = {}) => ({ id: 'u', role: 'user', text, ...extra }) as ChatItem;
const reply = (text: string, extra: object = {}) => ({ id: 'r', role: 'assistant', done, text, parts: [{ kind: 'text', text }], ...extra }) as unknown as ChatItem;

describe('answeredQuestion (the Fix it bubble)', () => {
  it('offers the answer’s first sentence after a question about a failure', () => {
    expect(answeredQuestion([user('why did the last run fail?'), reply('The HTTP step got a 401. Check the token.')])).toBe('The HTTP step got a 401.');
  });
  it('offers nothing after a question that is not about something that went wrong', () => {
    expect(answeredQuestion([user('what does Check total do?'), reply('It checks the total.')])).toBeUndefined();
    expect(answeredQuestion([user('why not retry?'), reply('It could.')])).toBeUndefined();
  });
  it('offers nothing after a change, a reply with a proposal, or a session reply', () => {
    expect(answeredQuestion([user('fix the error'), reply('Done.')])).toBeUndefined();
    const withProposal = { ...reply('x'), parts: [{ kind: 'proposal', proposal: {} }] } as unknown as ChatItem;
    expect(answeredQuestion([user('why did it fail?'), withProposal])).toBeUndefined();
    expect(answeredQuestion([user('why did it fail?'), reply('Because.', { testId: 't' })])).toBeUndefined();
    expect(answeredQuestion([user('why did it fail?', { auto: true }), reply('Because.')])).toBeUndefined();
  });
});
