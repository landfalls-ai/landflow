/**
 * Spotlight's bubbles in the editor (lib/shared/spotlight.ts): starters for an empty canvas from the trigger types
 * the workflow may use, what needs attention first, `@` mentions of canvas nodes (names with spaces too), node types
 * by name, keyword or plugin, whole sentences, and mentions that were deleted from the message.
 */
import { describe, expect, it } from 'vitest';
import { completeBubbles, idleBubbles, liveMentions, mentionAt, type SpotlightContext, type SpotlightNode, type SpotlightType } from '@/lib/shared/spotlight';

const type = (t: string, displayName: string, plugin = 'Built in', extra: Partial<SpotlightType> = {}): SpotlightType => ({ type: t, displayName, plugin, trigger: false, keywords: [], ...extra });
const TYPES: SpotlightType[] = [
  type('core.webhook', 'Webhook', 'Built in', { trigger: true }),
  type('core.schedule', 'Schedule Trigger', 'Built in', { trigger: true }),
  type('core.chatTrigger', 'Chat Trigger', 'Built in', { trigger: true }),
  type('core.aiAgent', 'AI Agent'),
  type('core.httpRequest', 'HTTP Request', 'Built in', { keywords: ['api', 'rest'] }),
  type('core.removeDuplicates', 'Remove Duplicates', 'Built in', { keywords: ['dedupe', 'unique'] }),
  type('messaging.slack', 'Slack', 'Messaging'),
  type('messaging.telegram', 'Telegram', 'Messaging'),
];

const node = (id: string, name: string, extra: Partial<SpotlightNode> = {}): SpotlightNode => ({ id, name, type: 'core.set', trigger: false, agent: false, hasModel: false, outgoing: false, failed: false, x: 0, ...extra });

/** Webhook → Format reply, plus an agent without a model further right. */
const flow = (extra: Partial<SpotlightContext> = {}): SpotlightContext => ({
  nodes: [node('a', 'Webhook', { trigger: true, outgoing: true, type: 'core.webhook' }), node('b', 'Format reply', { x: 280 }), node('c', 'Support agent', { agent: true, x: 560, type: 'core.aiAgent' })],
  types: TYPES,
  ...extra,
});

describe('Spotlight bubbles', () => {
  it('starts an empty canvas from the triggers the workflow may use', () => {
    const empty = { nodes: [], types: TYPES };
    expect(idleBubbles(empty).map((b) => [b.label, Boolean(b.send)])).toEqual([
      ['When a webhook is called, ', false],
      ['Every morning at 9, ', false],
      ['Answer chat messages with an AI agent', true],
    ]);
    // Without the chat trigger and the schedule, those starters go.
    const narrow = { nodes: [], types: TYPES.filter((t) => !['core.chatTrigger', 'core.schedule'].includes(t.type)) };
    expect(idleBubbles(narrow).map((b) => b.id)).toEqual(['start-webhook', 'start-api']);
  });

  it('puts what needs attention first, and offers at most three', () => {
    const ctx = flow();
    ctx.nodes[1].failed = true;
    expect(idleBubbles({ ...ctx, selectedId: 'a' }).map((b) => b.label)).toEqual(['Why did “Format reply” fail?', 'Connect a chat model to “Support agent”', 'Explain “Webhook”']);
    // Nothing wrong: where the flow ends, then a question about the whole.
    const calm = flow();
    calm.nodes[2].hasModel = true;
    expect(idleBubbles(calm).map((b) => b.label)).toEqual(['Test it and fix what fails', 'After “Support agent”, ', 'What does this workflow do?']);
    expect(idleBubbles(calm)[0]).toMatchObject({ id: 'test', send: false });
    expect(idleBubbles({ ...calm, nodes: calm.nodes.map((n) => ({ ...n, trigger: false })) })[0].label).toBe('Add a trigger that starts this workflow');
  });

  it('ends the flow at the last step, not at an agent’s tool', () => {
    // A tool connects to its agent, so it has a connection out.
    const ctx: SpotlightContext = {
      nodes: [node('a', 'Chat message', { trigger: true, outgoing: true }), node('b', 'Agent', { agent: true, hasModel: true, outgoing: true, x: 280 }), node('c', 'Reply', { x: 560 }), node('d', 'Slugify', { x: 700, outgoing: true })],
      types: TYPES,
    };
    expect(idleBubbles(ctx).map((b) => b.label)).toContain('After “Reply”, ');
    expect(idleBubbles({ ...ctx, selectedId: 'd' }).map((b) => b.label)).toContain('After “Reply”, ');
  });

  it('completes an @ mention of a node on the canvas, spaces included', () => {
    const ctx = flow();
    const text = 'Why is @form';
    const [bubble] = completeBubbles(text, text.length, ctx);
    expect(bubble).toMatchObject({ label: '@Format reply', kind: 'node', text: 'Why is @Format reply ', mention: { kind: 'node', id: 'b' } });
    expect(bubble.caret).toBe(bubble.text.length);
    // "@Format re" still matches a name with a space; a mid-word @ (an email) does not start a mention.
    expect(mentionAt('see @Format re', 14, ['Format reply'])).toEqual({ start: 4, query: 'Format re' });
    expect(mentionAt('see @Format nothing', 19, ['Format reply'])).toBeUndefined();
    expect(mentionAt('mail me@example', 15, ['Format reply'])).toBeUndefined();
    // A bare @ lists the canvas.
    expect(completeBubbles('@', 1, ctx).map((b) => b.label)).toEqual(['@Format reply', '@Support agent', '@Webhook']);
  });

  it('completes node types by name, keyword or plugin, and offers the whole step', () => {
    const ctx = flow();
    expect(completeBubbles('sla', 3, ctx).map((b) => [b.label, b.kind])).toEqual([
      ['Add Slack after “Support agent”', 'ask'],
      ['Slack', 'type'],
    ]);
    expect(completeBubbles('dedupe the items', 6, ctx)).toContainEqual(expect.objectContaining({ label: 'Remove Duplicates', text: 'Remove Duplicates the items', mention: { kind: 'type', type: 'core.removeDuplicates', label: 'Remove Duplicates' } }));
    // A plugin name finds its nodes.
    expect(completeBubbles('send it with messag', 19, ctx).filter((b) => b.kind === 'type').map((b) => b.label)).toEqual(['Slack', 'Telegram']);
    // With a node selected, the step goes after it.
    expect(completeBubbles('sla', 3, { ...ctx, selectedId: 'b' })[0].label).toBe('Add Slack after “Format reply”');
    // One letter is not enough.
    expect(completeBubbles('s', 1, ctx)).toEqual([]);
  });

  it('finishes a sentence that starts with what was typed', () => {
    const ctx = flow();
    ctx.nodes[1].failed = true;
    const [bubble] = completeBubbles('why', 3, ctx);
    expect(bubble).toMatchObject({ label: 'Why did “Format reply” fail?', send: true });
    expect(completeBubbles('wh', 2, { nodes: [], types: TYPES })[0]).toMatchObject({ label: 'When a webhook is called, ', send: false });
  });

  it('keeps only the mentions still in the message, once each', () => {
    const mentions = [
      { kind: 'node' as const, id: 'b', label: '@Format reply' },
      { kind: 'type' as const, type: 'messaging.slack', label: 'Slack' },
      { kind: 'node' as const, id: 'b', label: '@Format reply' },
    ];
    expect(liveMentions('Send @Format reply to Slack', mentions)).toHaveLength(2);
    expect(liveMentions('Send it to Telegram', mentions)).toEqual([]);
  });
});
