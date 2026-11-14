'use client';
/** "Test agent": a slide-over chat with the draft, streaming tool calls and approvals as they happen. */
import { useEffect, useRef, useState } from 'react';
import { Bot, SquarePen, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '../ui/badge';
import { AssistantRow, CHAT_ICON_BUTTON, ChatComposer, ChatEmpty, Working } from '../ui/chat';
import { isAnalyst, sourcesOf } from '@/lib/shared/analyst-chart';
import type { AgentToolConfig } from '@/lib/shared/agents';
import { AnalystTimeline, SUGGEST_FIX_MESSAGE, SourceChips } from './analyst-view';
import { AgentAvatar, type AvatarSource } from './avatar';
import { TimelineView, TraceChip, type ToolEntry } from './timeline';
import { REASON_LABEL, useAgentRun } from './use-agent-run';

export function TestChat({
  agentId,
  agentName,
  look,
  onClose,
  beforeSend,
  childHref,
  onSessionChange,
  tools,
}: {
  agentId: string;
  agentName: string;
  /** The agent's avatar, shown when the chat is empty. */
  look?: AvatarSource;
  onClose: () => void;
  /** Saves the draft first, so the run uses what's on screen. */
  beforeSend: () => Promise<void>;
  childHref?: (entry: ToolEntry) => string | undefined;
  onSessionChange?: () => void;
  /** The agent's tools: the Platform analyst is drawn with source chips and an answer card in the new look. */
  tools?: AgentToolConfig[];
}) {
  const analyst = isAnalyst(tools);
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

  const sendText = async (text: string) => {
    if (!text || run.running || run.awaitingApproval) return;
    await beforeSend().catch(() => {});
    await run.send(text);
    onSessionChange?.();
  };
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    return sendText(text);
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

  return (
    <aside
      className="z-40 flex h-screen w-[380px] shrink-0 animate-panel flex-col border-l border-hair bg-sf max-md:fixed max-md:inset-0 max-md:h-dvh max-md:w-full max-md:pt-[env(safe-area-inset-top)]"
      aria-label="Test agent"
    >
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-hair px-3">
        <span className="text-[13px] font-semibold text-t1">Test agent</span>
        <Badge tone="muted">Draft</Badge>
        <button
          title={run.sessionId ? `New conversation (this one is ${run.sessionId}, under Sessions)` : 'New conversation'}
          aria-label="New conversation"
          onClick={run.reset}
          className={cn(CHAT_ICON_BUTTON, 'ml-auto')}
        >
          <SquarePen className="size-3.5" />
        </button>
        <button onClick={onClose} aria-label="Close test chat" className={CHAT_ICON_BUTTON}>
          <X className="size-4" />
        </button>
      </div>

      {analyst && <SourceChips sources={sourcesOf((tools ?? []).map((t) => ('name' in t ? String(t.name) : '')))} />}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {run.entries.length === 0 && (
          <ChatEmpty
            className="mt-8"
            mark={look ? <AgentAvatar agent={look} size={40} round /> : undefined}
            title={`Talk to ${agentName || 'your agent'}`}
            help="Messages run the current draft. Tool calls show up here as they happen, and the conversation is saved under Sessions."
          />
        )}
        {analyst ? (
          <AnalystTimeline
            entries={run.entries}
            running={run.running}
            childHref={childHref}
            onDecide={(callId, approved) => void decide(callId, approved)}
            deciding={deciding}
            onSuggest={() => void sendText(SUGGEST_FIX_MESSAGE)}
          />
        ) : (
          <TimelineView entries={run.entries} childHref={childHref} onDecide={(callId, approved) => void decide(callId, approved)} deciding={deciding} />
        )}
        {thinking && (
          <AssistantRow mark={<Bot className="size-3.5" />} className="mt-3">
            <Working />
          </AssistantRow>
        )}
      </div>

      <div className="border-t border-hair p-2.5 max-md:pb-[max(10px,env(safe-area-inset-bottom))]">
        {/* Tokens are under each reply; here, the run's trace and how it ended. */}
        {(run.traceIds.length > 0 || (run.reason && run.reason !== 'completed' && !run.running)) && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-t3">
            {run.traceIds.length > 0 && (
              <TraceChip traceId={run.traceIds[run.traceIds.length - 1]} url={run.traceUrls[run.traceIds[run.traceIds.length - 1]]} />
            )}
            {run.reason && run.reason !== 'completed' && !run.running && (
              <span className={cn('w-full', run.reason === 'error' ? 'text-rd' : 'text-warn')}>{REASON_LABEL[run.reason]}</span>
            )}
          </div>
        )}
        <ChatComposer
          inputRef={input}
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          onStop={run.stop}
          busy={run.running}
          canSend={!run.awaitingApproval}
          placeholder={run.awaitingApproval ? 'Approve or deny the tool call first…' : 'Message the agent'}
          label="Message the agent"
        />
      </div>
    </aside>
  );
}
