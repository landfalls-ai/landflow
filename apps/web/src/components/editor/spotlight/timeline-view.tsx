'use client';
/** Every turn of the conversation, in order. */
import { useState } from 'react';
import { ChevronRight, CircleCheck, CircleStop } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAssistant, type ChatItem } from '../assistant';
import { ChatList } from '../../ui/chat-motion';
import { UserBubble } from '../../ui/chat';
import { foldLine, sessionFold } from '../timeline';
import { dividerBefore } from '../spotlight-history';
import { AgentRow, ReplyView } from './reply';

/** Every turn, in order, with the agents designed after the turn that created them. */
export function Timeline({ live, status }: { live: boolean; status?: string }) {
  const items = useAssistant((s) => s.items);
  const agents = useAssistant((s) => s.agents);
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
    // The kit's list: it stays at the bottom while a reply grows, and "Jump to latest" shows when you have scrolled up.
    <ChatList className="px-3 py-3">
      {/* A test-and-fix session's own requests ("Test run 2 failed at …") say what its run row says: left out. */}
      {items.map((item, index) => {
        const hidden = (item.role === 'user' && item.auto && !agents.some((a) => a.after === item.id)) || (folded(item) && !firstOf.has(item.id));
        if (hidden) return null;
        return (
          <div key={item.id} className="space-y-3">
            {/* Kept from an earlier visit: the conversation so far, then what is said now. */}
            {dividerBefore(items, index) && (
              <div role="separator" className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
                <span className="h-px flex-1 bg-hair" />
                Earlier
                <span className="h-px flex-1 bg-hair" />
              </div>
            )}
            {item.testId && firstOf.has(item.id) && folds.get(item.testId) && (
              <button
                type="button"
                aria-expanded={!folded(item)}
                onClick={() => setOpened((o) => { const next = new Set(o); if (next.has(item.testId!)) next.delete(item.testId!); else next.add(item.testId!); return next; })}
                className="flex min-h-7 w-full items-center gap-1.5 rounded-md text-left text-[12.5px] leading-snug text-t2 hover:bg-acdim max-md:min-h-11"
              >
                {folds.get(item.testId)!.state === 'passed' ? <CircleCheck className="size-3.5 shrink-0 text-gn" /> : <CircleStop className="size-3.5 shrink-0 text-t3" />}
                <span className="min-w-0 flex-1 truncate">{foldLine(folds.get(item.testId)!)}</span>
                <ChevronRight className={cn('size-3.5 shrink-0 text-t3 transition-transform', !folded(item) && 'rotate-90')} />
              </button>
            )}
            {folded(item) ? null : item.role === 'user' && item.auto ? null : (
              // Earlier turns are dimmed; a click or the keyboard on one brings it back to full strength.
              <div className={cn(item.earlier && 'opacity-70 transition-opacity focus-within:opacity-100 hover:opacity-100 motion-reduce:transition-none')}>
                {item.role === 'user' ? (
                  <>
                    <UserBubble>{item.text}</UserBubble>
                    {item.mentions?.length ? (
                      <ul aria-label="Tagged" className="mt-1 flex flex-wrap justify-end gap-1">
                        {item.mentions.map((m) => (
                          <li key={`${m.type}:${m.workflowId ?? ''}:${m.id}`} className="max-w-full truncate rounded-full border border-hair bg-sf px-2 py-0.5 text-[11.5px] text-t2">
                            @{m.name}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                ) : (
                  <ReplyView item={item} live={live && item.id === lastId} status={status} />
                )}
              </div>
            )}
            {agents
              .filter((a) => a.after === item.id)
              .map((a) => (
                <AgentRow key={a.nodeId} agent={a} />
              ))}
          </div>
        );
      })}
      {agents
        .filter((a) => !a.after || !placed.has(a.after))
        .map((a) => (
          <AgentRow key={`agent-${a.nodeId}`} agent={a} />
        ))}
    </ChatList>
  );
}
