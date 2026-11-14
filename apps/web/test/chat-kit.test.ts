/**
 * The chat kit (docs/assistant.md#chat-surfaces): a provider's raw error reads plainly, with the raw text kept for Details.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatError, ModelChip, ReplyMeta, chatText, firstSentences, plainError } from '@/components/ui/chat';
import { nextPinned } from '@/components/ui/chat-motion';
import { ActivityTrace } from '@/components/ui/activity-trace';
import { formatSeconds, summarizeSteps, type ActivityStep } from '@/lib/shared/activity';

describe('a reply’s error', () => {
  it('says a provider’s raw error plainly and keeps the raw text', () => {
    expect(plainError('Ollama error 500: {"error":"XML syntax error on line 26: unexpected EOF"}')).toEqual({
      text: 'The model returned an error.',
      details: 'Ollama error 500: {"error":"XML syntax error on line 26: unexpected EOF"}',
    });
    expect(plainError('Anthropic error 401: invalid x-api-key').text).toBe('The model refused the request: check its credential.');
    expect(plainError('OpenAI status 429 rate limited').text).toBe('The model is busy or over its limit. Try again in a moment.');
  });
  it('leaves a message written for a person as it is', () => {
    expect(plainError('No model is set for Spotlight. Pick one in Settings → AI.')).toEqual({ text: 'No model is set for Spotlight. Pick one in Settings → AI.' });
  });
});

describe('a reply’s text', () => {
  it('reads “•” bullets as a list and keeps single line breaks', () => {
    expect(chatText('Steps:\n• **Start** begins\n• Merge joins')).toBe('Steps:\n- **Start** begins\n- Merge joins');
    expect(chatText('One line\nNext line\n\nNew paragraph')).toBe('One line  \nNext line\n\nNew paragraph');
  });
  it('leaves code blocks, lists and tables alone', () => {
    const code = '```js\nconst a = 1\nconst b = 2\n```';
    expect(chatText(code)).toBe(code);
    expect(chatText('- a\n- b')).toBe('- a\n- b');
    expect(chatText('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('| a | b |\n|---|---|\n| 1 | 2 |');
  });
});

describe('activity steps', () => {
  const step = (id: string, status: ActivityStep['status'] = 'ok'): ActivityStep => ({ id, label: `Step ${id}`, kind: 'read', status });
  it('says how long in seconds', () => {
    expect(formatSeconds(0)).toBe('0.0 s');
    expect(formatSeconds(400)).toBe('0.4 s');
    expect(formatSeconds(14_500)).toBe('14.5 s');
    expect(formatSeconds(125_000)).toBe('2 min 5 s');
    expect(formatSeconds(120_000)).toBe('2 min');
  });
  it('sums the steps up', () => {
    expect(summarizeSteps(Array.from({ length: 10 }, (_, i) => step(String(i))), 14_500)).toBe('10 steps · 14.5 s');
    expect(summarizeSteps([step('a')], 800)).toBe('1 step · 0.8 s');
    expect(summarizeSteps([step('a')])).toBe('1 step');
  });
  it('draws a closed trace as one button', () => {
    const html = renderToStaticMarkup(createElement(ActivityTrace, { steps: [step('a'), step('b'), step('c')], live: false, durationMs: 1200 }));
    expect(html).toContain('3 steps · 1.2 s');
    expect(html).not.toContain('Step a');
  });
  it('draws an open trace with a failed row and a detail button', () => {
    const steps: ActivityStep[] = [step('a'), { ...step('b', 'failed'), kind: 'tool', detail: 'It timed out.' }, step('c')];
    const html = renderToStaticMarkup(createElement(ActivityTrace, { steps, live: false, durationMs: 1200, defaultOpen: true, traceUrl: '/runs/1' }));
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Failed"');
    expect(html).toContain('text-rd');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>(?:(?!<\/button>).)*Step b/s);
    expect(html).toContain('Open trace');
  });
  it('draws a live trace as one line', () => {
    const html = renderToStaticMarkup(createElement(ActivityTrace, { steps: [step('a'), step('b', 'running')], live: true }));
    expect(html).toContain('Step b');
    expect(html).toContain('step 2');
  });
});

describe('short replies', () => {
  it('cuts after the sentences asked for', () => {
    expect(firstSentences('One. Two. Three.', 2)).toEqual({ text: 'One. Two.', more: true });
    expect(firstSentences('One. Two.', 2)).toEqual({ text: 'One. Two.', more: false });
    expect(firstSentences('Only one', 2)).toEqual({ text: 'Only one', more: false });
  });
  it('does not cut after an abbreviation or inside a quoted name', () => {
    expect(firstSentences('Use tools, e.g. Slack. Then wait. Done.', 1).text).toBe('Use tools, e.g. Slack.');
    expect(firstSentences('Open “Step 2. Send” now. Next one.', 1).text).toBe('Open “Step 2. Send” now.');
  });
  it('leaves a code block whole', () => {
    const code = '```js\nconst a = 1. 2. 3.\n```';
    expect(firstSentences(`Here it is. ${code} Done. More.`, 2)).toEqual({ text: `Here it is. ${code} Done.`, more: true });
  });
  it('counts a list as its items', () => {
    expect(firstSentences('Steps:\n1. First.\n2. Second.\n3. Third.', 2).more).toBe(true);
  });
});

describe('the reply footer', () => {
  it('shows model, time, steps, tokens and cost', () => {
    const html = renderToStaticMarkup(createElement(ReplyMeta, { info: { model: 'claude-sonnet', durationMs: 14_500, steps: 10, inputTokens: 1000, outputTokens: 600, costUsd: 0.004 } }));
    expect(html).toContain('claude-sonnet · 14.5 s · 10 steps · 1,600 tokens · ≈$0.004');
  });
  it('says local instead of a cost for a local model', () => {
    const html = renderToStaticMarkup(createElement(ReplyMeta, { info: { model: 'llama3', local: true, durationMs: 800, costUsd: 0.01 } }));
    expect(html).toContain('llama3 · 0.8 s · local');
    expect(html).not.toContain('$');
  });
  it('keeps parts working and leaves out what is unknown', () => {
    expect(renderToStaticMarkup(createElement(ReplyMeta, { parts: ['gpt-x', false, '2.0 s'] }))).toContain('gpt-x · 2.0 s');
    expect(renderToStaticMarkup(createElement(ReplyMeta, { info: {} }))).toBe('');
  });
  it('names the model in a chip', () => {
    const html = renderToStaticMarkup(createElement(ModelChip, { model: 'ollama/llama3', local: true }));
    expect(html).toContain('llama3');
    expect(html).toContain('local');
  });
});

describe('an error with actions', () => {
  it('shows Try again and each action, the primary one filled', () => {
    const html = renderToStaticMarkup(
      createElement(ChatError, { message: 'No model is set.', onRetry: () => {}, actions: [{ label: 'Open settings', onClick: () => {}, primary: true }, { label: 'Use another model', onClick: () => {} }] }),
    );
    expect(html).toContain('Try again');
    expect(html).toContain('Open settings');
    expect(html).toContain('Use another model');
    expect(html).toMatch(/bg-rd[^"]*"[^>]*>Open settings/);
  });
});

describe('a chat list’s pin', () => {
  it('stays pinned near the bottom and unpins when the reader scrolls up', () => {
    expect(nextPinned({ gap: 10, prevTop: 0, top: 5, programmatic: false })).toBe(true);
    expect(nextPinned({ gap: 300, prevTop: 500, top: 400, programmatic: false })).toBe(false);
  });
  it('keeps the pin through a programmatic glide unless the list moves up', () => {
    expect(nextPinned({ gap: 300, prevTop: 100, top: 150, programmatic: true })).toBe(true);
    expect(nextPinned({ gap: 300, prevTop: 150, top: 100, programmatic: true })).toBe(false);
  });
});
