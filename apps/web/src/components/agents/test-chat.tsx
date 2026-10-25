'use client';
/** "Test agent": a slide-over chat with the draft, streaming tool calls and approvals as they happen. */
import { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, RotateCcw, SendHorizontal, Square, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '../ui/badge';
import { TimelineView, TraceChip, type ToolEntry } from './timeline';
import { REASON_LABEL, useAgentRun } from './use-agent-run';

export function TestChat({
  agentId,
  agentName,
  onClose,
  beforeSend,
  childHref,
  onSessionChange,
}: {
  agentId: string;
  agentName: string;
  onClose: () => void;
  /** Saves the draft first, so the run uses what's on screen. */
  beforeSend: () => Promise<void>;
  childHref?: (entry: ToolEntry) => string | undefined;
  onSessionChange?: () => void;
}) {
  const run = useAgentRun(agentId);
  const [draft, setDraft] = useState('');
  const [deciding, setDeciding] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({
      top: scroller.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [run.entries, run.running]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Escape closes the panel unless a dialog or menu is open over it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"],[role="menu"]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async () => {
    const text = draft.trim();
    if (!text || run.running || run.awaitingApproval) return;
    setDraft('');
    await beforeSend().catch(() => {});
    await run.send(text);
    onSessionChange?.();
  };

  const decide = async (callId: string, approved: boolean) => {
    setDeciding(true);
    try {
      await run.decide(callId, approved);
      onSessionChange?.();
    } finally {
      setDeciding(false);
    }
  };

  const last = run.entries[run.entries.length - 1];
  const thinking = run.running && !(last?.type === 'tool' && last.status === 'running');
  const used = run.usage.inputTokens + run.usage.outputTokens;

  return (
    <aside
      className="z-40 flex h-screen w-[380px] shrink-0 animate-panel flex-col border-l border-hair bg-sf max-md:fixed max-md:inset-0 max-md:w-full"
      aria-label="Test agent"
    >
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-hair px-3">
        <span className="text-[13px] font-semibold text-t1">Test agent</span>
        <Badge tone="muted">Draft</Badge>
        {run.sessionId && (
          <span className="min-w-0 truncate font-mono text-[11px] text-t3" title={run.sessionId}>
            {run.sessionId}
          </span>
        )}
        <button
          title="New session"
          aria-label="New session"
          onClick={run.reset}
          className="ml-auto grid size-7 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1"
        >
          <RotateCcw className="size-3.5" />
        </button>
        <button
          onClick={onClose}
          aria-label="Close test chat"
          className="grid size-7 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1"
        >
          <X className="size-4" />
        </button>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {run.entries.length === 0 && (
          <div className="mt-8 animate-fade-up text-center">
            <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full border border-acbd bg-acdim">
              <Bot className="size-5 text-ac" strokeWidth={1.6} />
            </div>
            <div className="text-[15px] font-semibold text-t1">Talk to {agentName || 'your agent'}</div>
            <div className="mx-auto mt-1 max-w-[270px] text-[13px] text-t2">
              Messages run the current draft. Tool calls show up here as they happen, and the conversation is saved under Sessions.
            </div>
          </div>
        )}
        <TimelineView entries={run.entries} childHref={childHref} onDecide={(callId, approved) => void decide(callId, approved)} deciding={deciding} />
        {thinking && (
          <div className="mt-3 flex items-center gap-2.5">
            <div className="grid size-[26px] shrink-0 place-items-center rounded-full border border-acbd bg-acdim text-ac">
              <Loader2 className="size-3.5 animate-spin" />
            </div>
            <div className="animate-pulse-soft text-[13px] text-t2">Thinking…</div>
          </div>
        )}
      </div>

      <div className="border-t border-hair p-3">
        {(run.traceIds.length > 0 || used > 0 || (run.reason && run.reason !== 'completed')) && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-t3">
            {used > 0 && (
              <span className="font-mono" title="Tokens reported by the last run (input · output)">
                {run.usage.inputTokens.toLocaleString()} in · {run.usage.outputTokens.toLocaleString()} out
              </span>
            )}
            {run.traceIds.length > 0 && (
              <TraceChip traceId={run.traceIds[run.traceIds.length - 1]} url={run.traceUrls[run.traceIds[run.traceIds.length - 1]]} />
            )}
            {run.reason && run.reason !== 'completed' && !run.running && (
              <span className={cn('w-full', run.reason === 'error' ? 'text-rd' : 'text-warn')}>{REASON_LABEL[run.reason]}</span>
            )}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-[10px] border border-hair bg-wl p-1.5 focus-within:border-ac">
          <textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={run.awaitingApproval ? 'Approve or deny the tool call first…' : 'Message the agent…'}
            aria-label="Message"
            className="max-h-32 min-h-[32px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] text-t1 outline-none placeholder:text-t3"
          />
          {run.running ? (
            <button
              onClick={run.stop}
              aria-label="Stop"
              title="Stop reading the reply"
              className="grid size-8 place-items-center rounded-full border border-bd text-t2 transition-colors hover:border-ac hover:text-ac"
            >
              <Square className="size-3" fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!draft.trim() || run.awaitingApproval}
              aria-label="Send"
              className="grid size-8 place-items-center rounded-full bg-ac2 text-on-ac transition-colors hover:bg-ac2-hover disabled:opacity-40"
            >
              <SendHorizontal className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
