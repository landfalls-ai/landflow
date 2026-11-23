/**
 * The hosted chat widget's motion (docs/features/ai.md#hosted-chat): bubbles rise in, the typing indicator is three dots,
 * and Reduce motion turns both off.
 */
import { describe, expect, it } from 'vitest';
import { CHAT_CLIENT_JS } from '@/lib/server/chat-client';

describe('the hosted widget’s style', () => {
  it('rises a bubble in and shows three typing dots', () => {
    expect(CHAT_CLIENT_JS).toContain('@keyframes lf-rise');
    expect(CHAT_CLIENT_JS).toContain('@keyframes lf-dot');
    expect(CHAT_CLIENT_JS).toContain('.typing i:nth-child(3)');
    expect(CHAT_CLIENT_JS).toContain("[el('i'), el('i'), el('i')]");
  });
  it('stops moving under Reduce motion', () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([^}]*\{[^}]*\})+[^}]*\}/.exec(CHAT_CLIENT_JS);
    expect(block).not.toBeNull();
    expect(block![0]).toContain('.msg');
    expect(block![0]).toContain('.typing i');
    expect(block![0]).toContain('animation: none');
  });
  it('still parses as a script', () => {
    expect(() => new Function(CHAT_CLIENT_JS)).not.toThrow();
  });
});
