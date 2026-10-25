'use client';
/**
 * The builder chat, docked on the right of the editor: ask for changes or
 * explanations; the assistant researches the node catalog, the workflow and
 * the last run, and proposes changes shown as diffs to apply or dismiss.
 */
import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Database, Loader2, Search, SendHorizontal, Sparkles, Square, SquarePen, User, Workflow, X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { applyChanges, sendFeedback, useAssistant, type ChatItem, type Proposal, type ToolActivity } from './assistant';
import { useEditor } from './store';
import { OpsDiff, Warnings } from './suggestions-card';

const TOOL_ICONS: Record<string, LucideIcon> = {
  search_nodes: Search,
  get_node_docs: BookOpen,
  get_workflow: Workflow,
  get_run_data: Database,
  propose_changes: Sparkles,
};

function ToolLine({ tool }: { tool: ToolActivity }) {
  const Icon = TOOL_ICONS[tool.name] ?? Search;
  return (
    <div className={cn('flex animate-in items-center gap-1.5 text-[11.5px]', tool.ok ? 'text-t3' : 'text-rd')}>
      <Icon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{tool.label}</span>
    </div>
  );
}

function ProposalCard({ itemId, proposal }: { itemId: string; proposal: Proposal }) {
  const decide = (state: 'applied' | 'dismissed') => useAssistant.getState().setProposalState(itemId, proposal.id, state);
  return (
    <div className={cn('animate-fade-up space-y-2 rounded-xl border bg-sf p-2.5', proposal.state === 'applied' ? 'border-gnbd' : 'border-acbd')}>
      <div className="flex items-start gap-1.5">
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-viz-7" />
        <span className="text-[13px] font-semibold leading-snug text-t1">{proposal.summary}</span>
      </div>
      <OpsDiff ops={proposal.ops} />
      <Warnings warnings={proposal.warnings} />
      {proposal.dropped.length > 0 && (
        <p className="text-[11px] text-t3" title={proposal.dropped.join('\n')}>
          {proposal.dropped.length} part{proposal.dropped.length === 1 ? '' : 's'} left out (hover for why)
        </p>
      )}
      <div className="flex items-center gap-1.5">
        {proposal.state === 'applied' ? (
          <span className="flex animate-pop items-center gap-1 text-[12px] font-semibold text-gn">
            <Check className="size-3.5" /> Applied
          </span>
        ) : proposal.state === 'dismissed' ? (
          <span className="text-[12px] text-t3">Dismissed</span>
        ) : (
          <>
            <Button size="sm" variant="primary" onClick={() => applyChanges([{ ops: proposal.ops, kind: 'proposal' }], proposal.summary) && decide('applied')}>
              Apply
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                decide('dismissed');
                sendFeedback('proposal', 'dismissed');
              }}
            >
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function Reply({ item, live }: { item: Extract<ChatItem, { role: 'assistant' }>; live: boolean }) {
  const pending = item.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state ? [p.proposal] : []));
  const applyAll = () => {
    if (!applyChanges(pending.map((p) => ({ ops: p.ops, kind: 'proposal' as const })), `Applied ${pending.length} changes`)) return;
    for (const p of pending) useAssistant.getState().setProposalState(item.id, p.id, 'applied');
  };
  return (
    <div className="flex animate-in gap-2.5">
      <div className="grid size-[26px] shrink-0 place-items-center rounded-full border border-acbd bg-acdim text-ac">
        {live ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {item.parts.map((part, i) =>
          part.kind === 'text' ? (
            <div key={i} className="whitespace-pre-wrap text-[13px] leading-relaxed text-t1 [overflow-wrap:anywhere]">
              {part.text}
            </div>
          ) : part.kind === 'tool' ? (
            <ToolLine key={i} tool={part.tool} />
          ) : (
            <ProposalCard key={part.proposal.id} itemId={item.id} proposal={part.proposal} />
          ),
        )}
        {live && <div className="animate-pulse-soft text-[12px] text-t3">{item.parts.length ? 'Working…' : 'Thinking…'}</div>}
        {item.error && <div className="rounded-[10px] border border-rdbd bg-rddim px-2.5 py-2 text-[12px] text-rd [overflow-wrap:anywhere]">{item.error}</div>}
        {!live && pending.length > 1 && (
          <Button size="sm" variant="outline" onClick={applyAll}>
            <Check className="size-3.5" /> Apply all ({pending.length})
          </Button>
        )}
        {item.done && (
          <div className="font-mono text-[10.5px] text-t3">
            {item.done.model} · {(item.done.durationMs / 1000).toFixed(1)} s · {item.done.steps} step{item.done.steps === 1 ? '' : 's'}
          </div>
        )}
      </div>
    </div>
  );
}

const STARTERS_EMPTY = ['Build a flow that fetches a JSON API, keeps items with a score over 0.5 and sorts them', 'Start with a webhook that slugifies a title and replies with it'];
const STARTERS = ['Why did the last run fail?', 'What does this workflow do?', 'Remove duplicate items before the last step'];

export function AssistantPanel() {
  const open = useAssistant((s) => s.open);
  const items = useAssistant((s) => s.items);
  const pending = useAssistant((s) => s.pending);
  const empty = useEditor((s) => s.nodes.length === 0);
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [items]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  if (!open) return null;
  const { send, stop, reset, setOpen } = useAssistant.getState();
  const submit = () => {
    if (!draft.trim() || pending) return;
    void send(draft);
    setDraft('');
  };

  return (
    <aside className="z-30 flex w-[400px] shrink-0 animate-panel flex-col border-l border-hair bg-sf">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hair px-3">
        <Sparkles className="size-3.5 text-viz-7" />
        <span className="text-[13px] font-semibold text-t1">Assistant</span>
        <button title="New chat" aria-label="New chat" onClick={reset} className="ml-auto grid size-7 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
          <SquarePen className="size-3.5" />
        </button>
        <button onClick={() => setOpen(false)} title="Close (⌘I)" aria-label="Close assistant" className="grid size-7 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
          <X className="size-4" />
        </button>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {items.length === 0 && (
          <div className="mt-8 text-center">
            <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-[color-mix(in_oklab,var(--viz-7)_14%,var(--sf))]">
              <Sparkles className="size-5 text-viz-7" strokeWidth={1.6} />
            </div>
            <div className="text-[15px] font-semibold text-t1">Build with the assistant</div>
            <div className="mx-auto mt-1 max-w-[290px] text-[13px] text-t2">
              It reads the node catalog, this workflow and its last run, and proposes changes you review before they touch the canvas.
            </div>
            <div className="mt-5 space-y-1.5">
              {(empty ? STARTERS_EMPTY : STARTERS).map((s) => (
                <button key={s} onClick={() => void send(s)} className="block w-full rounded-[10px] border border-hair bg-wl px-3 py-2 text-left text-[12px] text-t2 transition-colors hover:border-acbd hover:text-t1">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((item, i) =>
          item.role === 'user' ? (
            <div key={item.id} className="flex animate-in flex-row-reverse gap-2.5">
              <div className="grid size-[26px] shrink-0 place-items-center rounded-full border border-hair bg-wl text-t2">
                <User className="size-3.5" />
              </div>
              <div className="max-w-[300px] whitespace-pre-wrap rounded-xl bg-ac2 px-3 py-2 text-[13px] leading-relaxed text-on-ac [overflow-wrap:anywhere]">{item.text}</div>
            </div>
          ) : (
            <Reply key={item.id} item={item} live={pending && i === items.length - 1} />
          ),
        )}
      </div>

      <div className="border-t border-hair p-3">
        <div className="flex items-end gap-2 rounded-[10px] border border-hair bg-wl p-1.5 focus-within:border-ac">
          <textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={empty ? 'Describe the workflow to build…' : 'Ask for a change, or why something failed…'}
            aria-label="Message the assistant"
            className="max-h-32 min-h-[32px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] text-t1 outline-none placeholder:text-t3"
          />
          {pending ? (
            <button onClick={stop} aria-label="Stop" title="Stop" className="grid size-8 place-items-center rounded-full border border-bd text-t2 transition-colors hover:border-rd hover:text-rd">
              <Square className="size-3" fill="currentColor" />
            </button>
          ) : (
            <button onClick={submit} disabled={!draft.trim()} aria-label="Send" className="grid size-8 place-items-center rounded-full bg-ac2 text-on-ac transition-colors hover:bg-ac2-hover disabled:opacity-40">
              <SendHorizontal className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
