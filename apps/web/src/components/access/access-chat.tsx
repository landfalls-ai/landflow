'use client';
/**
 * The chat on the Ask tab: say what you need and the assistant reads the request back and files it once you say yes. It can only file a
 * request; an approver decides. The session id is kept for the tab. Without a chat flow (no model at set-up) it says so and the form stays.
 */
import { useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { accessApi, requestProblem } from '@/lib/client/access';
import { AssistantRow, ChatError, UserBubble, Working } from '../ui/chat';
import { Card } from '../shell/page-header';
import { EmptyState } from '../ui/empty-state';
import { Textarea } from '../ui/inputs';
import { Button } from '../ui/button';
import { ChatMarkdown } from '../ui/chat';

interface Line {
  who: 'me' | 'bot';
  text: string;
  requestId?: string;
}

export function AccessChat({ available, onFiled }: { available: boolean; onFiled?: (requestId: string) => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const session = useRef<string>('');
  if (!session.current) session.current = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s-${Date.now()}`;

  if (!available) {
    return (
      <Card>
        <EmptyState title="Ask an admin to connect a model for the chat" hint="The form works in the meantime." />
      </Card>
    );
  }

  const send = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setText('');
    setError(undefined);
    setLines((l) => [...l, { who: 'me', text: message }]);
    setBusy(true);
    try {
      const reply = await accessApi.chat(message, session.current);
      setLines((l) => [...l, { who: 'bot', text: reply.reply, requestId: reply.requestId }]);
      if (reply.requestId) onFiled?.(reply.requestId);
    } catch (e) {
      setError(requestProblem(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex max-w-[720px] flex-col gap-3 max-md:min-h-[60dvh]">
      <p className="text-[12.5px] text-t3">It can only file a request; an approver decides.</p>
      <div data-testid="access-chat-log" className="flex min-h-40 flex-1 flex-col gap-3" aria-live="polite">
        {lines.length === 0 && <p className="text-[13px] text-t2">Try: “I need the platform team for 4 hours, I am on call.”</p>}
        {lines.map((line, i) =>
          line.who === 'me' ? (
            <UserBubble key={i}>{line.text}</UserBubble>
          ) : (
            <AssistantRow key={i}>
              <ChatMarkdown text={line.text} />
              {line.requestId && <p className="text-[12px] text-t3">Filed. See it under My requests.</p>}
            </AssistantRow>
          ),
        )}
        {busy && <Working />}
        {error && <ChatError message={error} />}
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Textarea
          aria-label="Message"
          data-testid="access-chat-input"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="What do you need?"
          className="min-h-11 flex-1"
        />
        <Button type="submit" variant="primary" size="icon" aria-label="Send" disabled={busy || !text.trim()} data-testid="access-chat-send" className="max-md:size-11"><ArrowUp className="size-4" /></Button>
      </form>
    </Card>
  );
}
