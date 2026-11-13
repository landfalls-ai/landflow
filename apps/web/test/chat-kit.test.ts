/**
 * The chat kit (docs/assistant.md#chat-surfaces): a provider's raw error reads plainly, with the raw text kept for Details.
 */
import { describe, expect, it } from 'vitest';
import { chatText, plainError } from '@/components/ui/chat';

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
