import { askKind } from '@/lib/shared/ask-kind';
import type { ChatItem } from '../assistant';

/** The first sentence of the answer to the person's last typed message when that was a question; else nothing. */
export function answeredQuestion(items: ChatItem[]): string | undefined {
  const reply = items.at(-1);
  if (reply?.role !== 'assistant' || !reply.done || reply.error || reply.testId || reply.parts.some((p) => p.kind === 'proposal')) return undefined;
  const asked = items.at(-2);
  if (asked?.role !== 'user' || asked.auto || asked.testId || askKind(asked.text) !== 'question' || !/fail|error|broke|wrong|stuck|didn'?t work|not work|40\d|50\d/i.test(asked.text)) return undefined; // Fix it only follows a question about something that went wrong
  const words = (reply.text ?? reply.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join(' ')).replace(/\s+/g, ' ').trim();
  const first = words.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? words;
  return first.slice(0, 200) || undefined;
}
