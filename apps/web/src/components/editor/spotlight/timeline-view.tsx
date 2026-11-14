'use client';
/** Every turn of the conversation, in order. */
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, CircleCheck, CircleStop } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAssistant, type ChatItem } from '../assistant';
import { UserBubble } from '../../ui/chat';
import { foldLine, sessionFold } from '../timeline';
import { AgentRow, ReplyView } from './reply';

/** Every turn, in order, with the agents designed after the turn that created them. */
export function Timeline({ live, status }: { live: boolean; status?: string }) {
  const items = useAssistant((s) => s.items);
  const agents = useAssistant((s) => s.agents);
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const lastRole = items.at(-1)?.role;
  useEffect(() => {
    const el = scroller.current;
    // Reading further up: stay there, unless the person just sent something.
    if (el && (atEnd.current || lastRole === 'user')) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items, agents, lastRole]);
  // Sizes change without new items: the bubbles row appears under it, the phone's dock changes height, a card grows.
  useEffect(() => {
    const el = scroller.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;
    const follow = new ResizeObserver(() => {
      if (atEnd.current) el.scrollTop = el.scrollHeight;
    });
    follow.observe(el);
    follow.observe(content);
    return () => follow.disconnect();
  }, []);
  const lastId = items.at(-1)?.id;
  const placed = new Set(items.map((i) => i.id));
  // A finished session folds to one line; the person opens it. The one running stays open.
  const runningTest = useAssistant((s) => s.testingId);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const folds = new Map<string, ReturnType<typeof sessionFold>>();
  for (const item of items) if (item.testId && !folds.has(item.testId)) folds.set(item.testId, sessionFold(items, item.testId, item.testId === runningTest));
  const folded = (item: ChatItem) => Boolean(item.testId && folds.get(item.testId) && !opened.has(item.testId));
  const firstOf = new Set([...folds.keys()].map((id) => items.find((i) => i.testId === id)?.id));
  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
    >
      <div className="space-y-3">
      {/* A test-and-fix session's own requests ("Test run 2 failed at …") say what its run row says: left out. */}
      {items.map((item) => (
        <div key={item.id} className={cn('space-y-3', ((item.role === 'user' && item.auto && !agents.some((a) => a.after === item.id)) || (folded(item) && !firstOf.has(item.id))) && 'hidden')}>
          {item.testId && firstOf.has(item.id) && folds.get(item.testId) && (
            <button
              type="button"
              aria-expanded={!folded(item)}
              onClick={() => setOpened((o) => { const next = new Set(o); if (next.has(item.testId!)) next.delete(item.testId!); else next.add(item.testId!); return next; })}
              className="flex min-h-7 w-full items-center gap-1.5 rounded-md text-left text-[12.5px] leading-snug text-t2 hover:bg-acdim"
            >
              {folds.get(item.testId)!.state === 'passed' ? <CircleCheck className="size-3.5 shrink-0 text-gn" /> : <CircleStop className="size-3.5 shrink-0 text-t3" />}
              <span className="min-w-0 flex-1 truncate">{foldLine(folds.get(item.testId)!)}</span>
              <ChevronRight className={cn('size-3.5 shrink-0 text-t3 transition-transform', !folded(item) && 'rotate-90')} />
            </button>
          )}
          {folded(item) ? null : item.role === 'user' && item.auto ? null : item.role === 'user' ? (
            <UserBubble>{item.text}</UserBubble>
          ) : (
            <ReplyView item={item} live={live && item.id === lastId} status={status} />
          )}
          {agents
            .filter((a) => a.after === item.id)
            .map((a) => (
              <AgentRow key={a.nodeId} agent={a} />
            ))}
        </div>
      ))}
      {agents
        .filter((a) => !a.after || !placed.has(a.after))
        .map((a) => (
          <AgentRow key={a.nodeId} agent={a} />
        ))}
      </div>
    </div>
  );
}
