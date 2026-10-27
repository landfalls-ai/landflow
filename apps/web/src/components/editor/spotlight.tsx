'use client';
/**
 * Spotlight in the editor (docs/assistant.md): one bar floating at the bottom of the canvas to build and fix the
 * workflow with the assistant. Bubbles above it suggest what to ask and complete what is typed (`@` a node on the
 * canvas, a node type this workflow may use); the conversation opens above the bar, and proposed changes wait for Apply.
 * On an empty canvas the first message drafts the whole flow.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, Loader2, MessageSquare, Sparkles, Square, SquarePen, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { cn } from '@/lib/utils';
import { completeBubbles, idleBubbles, liveMentions, type Bubble, type Mention, type SpotlightContext } from '@/lib/shared/spotlight';
import { Button } from '../ui/button';
import { useBuildFlow } from './ai-builder';
import { applyChanges, sendFeedback, suggestionKey, useAssistant, useSuggestions, type ChatItem, type Proposal, type Suggestion } from './assistant';
import { useEditor } from './store';
import { OpsDiff, Warnings } from './suggestions-card';

const INPUT_ID = 'spotlight-input';

/** ⌘I and the empty canvas's hint: put the caret in Spotlight. */
export function focusSpotlight() {
  document.getElementById(INPUT_ID)?.focus();
}

type Reply = Extract<ChatItem, { role: 'assistant' }>;

/** After Apply the conversation steps aside so the change shows on the canvas; the toast has Undo. */
function applied(decide: (state: 'applied') => void) {
  decide('applied');
  useAssistant.getState().setOpen(false);
}

function ProposalCard({ itemId, proposal }: { itemId: string; proposal: Proposal }) {
  const decide = (state: 'applied' | 'dismissed') => useAssistant.getState().setProposalState(itemId, proposal.id, state);
  return (
    <div className={cn('animate-fade-up space-y-2 rounded-xl border bg-sf p-2.5', proposal.state === 'applied' ? 'border-gnbd' : 'border-acbd')}>
      <div className="text-[13px] font-semibold leading-snug text-t1">{proposal.summary}</div>
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
            <Button size="sm" variant="primary" onClick={() => applyChanges([{ ops: proposal.ops, kind: 'proposal' }], proposal.summary) && applied(decide)}>
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

/** A reply: its text and proposals. While it streams, one line says what the assistant is doing. */
function ReplyView({ item, live, status }: { item: Reply; live: boolean; status?: string }) {
  const pending = item.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state ? [p.proposal] : []));
  const lastTool = item.parts.findLast((p) => p.kind === 'tool');
  const applyAll = () => {
    if (!applyChanges(pending.map((p) => ({ ops: p.ops, kind: 'proposal' as const })), `Applied ${pending.length} changes`)) return;
    for (const p of pending) useAssistant.getState().setProposalState(item.id, p.id, 'applied');
    useAssistant.getState().setOpen(false);
  };
  const meta = item.done && `${item.done.model} · ${(item.done.durationMs / 1000).toFixed(1)} s · ${item.done.steps} step${item.done.steps === 1 ? '' : 's'}`;
  return (
    <div className="flex animate-in gap-2" title={meta || undefined}>
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-viz-7">{live ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}</span>
      <div className="min-w-0 flex-1 space-y-2">
        {item.parts.map((part, i) =>
          part.kind === 'text' ? (
            <div key={i} className="whitespace-pre-wrap text-[13px] leading-relaxed text-t1 [overflow-wrap:anywhere]">
              {part.text}
            </div>
          ) : part.kind === 'proposal' ? (
            <ProposalCard key={part.proposal.id} itemId={item.id} proposal={part.proposal} />
          ) : null,
        )}
        {live && (
          <div className="animate-pulse-soft truncate text-[12px] text-t3">{status ?? (lastTool?.kind === 'tool' ? `${lastTool.tool.label}…` : 'Thinking…')}</div>
        )}
        {item.error && <div className="rounded-[10px] border border-rdbd bg-rddim px-2.5 py-2 text-[12px] text-rd [overflow-wrap:anywhere]">{item.error}</div>}
        {!live && pending.length > 1 && (
          <Button size="sm" variant="outline" onClick={applyAll}>
            <Check className="size-3.5" /> Apply all ({pending.length})
          </Button>
        )}
      </div>
    </div>
  );
}

function Conversation({ live, status }: { live: boolean; status?: string }) {
  const items = useAssistant((s) => s.items);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [items]);
  const { reset, setOpen } = useAssistant.getState();
  return (
    <div className="pointer-events-auto flex max-h-[min(44vh,440px)] animate-fade-up flex-col overflow-hidden rounded-2xl border border-hair bg-sf/95 shadow-pop backdrop-blur">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hair pl-3 pr-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Spotlight</span>
        <button title="New conversation" aria-label="New conversation" onClick={reset} className="ml-auto grid size-6 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
          <SquarePen className="size-3.5" />
        </button>
        <button title="Hide (esc)" aria-label="Hide the conversation" onClick={() => setOpen(false)} className="grid size-6 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
          <ChevronDown className="size-4" />
        </button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {items.map((item, i) =>
          item.role === 'user' ? (
            <div key={item.id} className="ml-auto w-fit max-w-[85%] animate-in whitespace-pre-wrap rounded-xl bg-ac2 px-3 py-1.5 text-[13px] leading-relaxed text-on-ac [overflow-wrap:anywhere]">
              {item.text}
            </div>
          ) : (
            <ReplyView key={item.id} item={item} live={live && i === items.length - 1} status={status} />
          ),
        )}
      </div>
    </div>
  );
}

const latestMain = (runs: { source: string; status: string }[] | undefined) => runs?.filter((r) => r.source === 'main').at(-1);

/** What Spotlight knows of the canvas and the catalog, for its bubbles. */
function useSpotlightContext(): SpotlightContext {
  const nodes = useEditor((s) => s.nodes);
  const edges = useEditor((s) => s.edges);
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const runs = useEditor((s) => s.runs);
  const selectedId = useEditor((s) => s.openNodeId ?? s.nodes.find((n) => n.selected)?.id);
  return useMemo(
    () => ({
      nodes: nodes.map((n) => {
        const { id, name, type } = n.data.wf;
        const descriptor = nodeTypes[type]?.descriptor;
        const agent = Boolean(descriptor?.inputs.some((p) => p.type === 'ai_languageModel'));
        return {
          id,
          name,
          type,
          trigger: descriptor?.kind === 'trigger',
          agent,
          hasModel: agent && edges.some((e) => e.target === id && e.data?.connectionType === 'ai_languageModel'),
          outgoing: edges.some((e) => e.source === id && (e.data?.connectionType ?? 'main') === 'main'),
          failed: latestMain(runs[id])?.status === 'error',
          x: n.position.x,
        };
      }),
      types: Object.values(nodeTypes)
        .filter((t) => t.available && !t.blocked)
        .map((t) => ({ type: t.type, displayName: t.descriptor.displayName, plugin: t.pluginId === 'core' ? 'Built in' : t.pluginName, trigger: t.descriptor.kind === 'trigger', keywords: t.descriptor.keywords ?? [] })),
      selectedId,
    }),
    [nodes, edges, nodeTypes, runs, selectedId],
  );
}

/** The top after-run fix for a node that just failed, once the assistant has one (see prefetchFailure), unless offered already. */
function useFailureFix(offered: Set<string>): { nodeName: string; suggestion: Suggestion } | undefined {
  const entries = useSuggestions((s) => s.entries);
  const runs = useEditor((s) => s.runs);
  const nodes = useEditor((s) => s.nodes);
  const workflowId = useEditor((s) => s.workflowId);
  return useMemo(() => {
    for (const node of nodes) {
      const run = runs[node.id]?.filter((r) => r.source === 'main').at(-1);
      if (run?.status !== 'error') continue;
      const entry = entries[suggestionKey(workflowId, node.id, run)];
      const suggestion = entry?.result?.suggestions.find((s) => s.ops.length && !entry.handled[s.id] && !offered.has(s.id));
      if (suggestion) return { nodeName: node.data.wf.name, suggestion };
    }
    return undefined;
  }, [entries, runs, nodes, workflowId, offered]);
}

export function Spotlight() {
  const open = useAssistant((s) => s.open);
  const hasItems = useAssistant((s) => s.items.length > 0);
  const pending = useAssistant((s) => s.pending);
  const waiting = useAssistant((s) => s.items.reduce((n, item) => n + (item.role === 'assistant' ? item.parts.filter((p) => p.kind === 'proposal' && !p.proposal.state).length : 0), 0));
  const empty = useEditor((s) => s.nodes.length === 0);
  const selectedName = useEditor((s) => {
    const id = s.openNodeId ?? s.nodes.find((n) => n.selected)?.id;
    return id ? s.nodes.find((n) => n.id === id)?.data.wf.name : undefined;
  });
  const ctx = useSpotlightContext();
  const [offered, setOffered] = useState<Set<string>>(() => new Set());
  const fix = useFailureFix(offered);
  const { build, busy } = useBuildFlow();
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [withoutSelection, setWithoutSelection] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const live = pending || busy;
  const showConversation = open && hasItems;

  // A new selection is back in the context.
  useEffect(() => setWithoutSelection(false), [selectedName]);

  const bubbles = useMemo<Bubble[]>(() => {
    if (live) return [];
    if (draft.trim()) return focused ? completeBubbles(draft, caret, ctx) : [];
    if (showConversation) return [];
    const offer: Bubble[] = fix ? [{ id: `fix:${fix.suggestion.id}`, label: `Fix: ${fix.suggestion.title}`, kind: 'ask', text: '', caret: 0 }] : [];
    const idle = idleBubbles(ctx);
    // Unfocused, only what needs attention (a failure) or a start on an empty canvas.
    const quiet = focused || empty ? idle : idle.filter((b) => b.id.startsWith('why-'));
    return [...offer, ...quiet].slice(0, 3);
  }, [live, draft, caret, focused, ctx, showConversation, fix, empty]);

  useEffect(() => setActive(-1), [bubbles]);

  const resize = () => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };
  useEffect(resize, [draft]);

  const setText = (text: string, at = text.length) => {
    setDraft(text);
    setCaret(at);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(at, at);
    });
  };

  const submit = async (text: string, extra: Mention[] = []) => {
    const message = text.trim();
    if (!message || live) return;
    const tagged = liveMentions(message, [...mentions, ...extra]);
    setDraft('');
    setCaret(0);
    setMentions([]);
    if (!useEditor.getState().nodes.length) {
      // An empty canvas: the builder drafts the whole flow in one go, with test data on the trigger.
      const reply: ChatItem = { id: nanoid(8), role: 'assistant', parts: [] };
      useAssistant.getState().append([{ id: nanoid(8), role: 'user', text: message }, reply]);
      const patch = (fields: Partial<Reply>) => useAssistant.setState((s) => ({ items: s.items.map((i) => (i.id === reply.id ? { ...(i as Reply), ...fields } : i)) }));
      try {
        const flow = await build(message);
        const skipped = flow.dropped ? ` I left out ${flow.dropped} part${flow.dropped === 1 ? '' : 's'} that didn’t fit.` : '';
        const next = flow.pinned ? 'Test data is pinned on the trigger: press Execute workflow to see it work.' : 'Press Execute workflow to try it.';
        patch({ parts: [{ kind: 'text', text: `Built “${flow.name}” with ${flow.nodes} nodes.${skipped} ${next} ⌘Z undoes it.` }], done: { model: flow.model, durationMs: flow.durationMs, steps: 1 } });
      } catch (e) {
        patch({ error: `Couldn’t build the flow: ${(e as Error).message}` });
      }
      return;
    }
    await useAssistant.getState().send(message, {
      withoutSelection,
      ...(tagged.length && {
        mentions: {
          nodes: tagged.flatMap((m) => (m.kind === 'node' ? [m.id] : [])),
          types: tagged.flatMap((m) => (m.kind === 'type' ? [m.type] : [])),
        },
      }),
    });
  };

  const choose = (bubble: Bubble) => {
    if (bubble.id.startsWith('fix:') && fix) {
      const { suggestion, nodeName } = fix;
      setOffered((o) => new Set(o).add(suggestion.id));
      useAssistant.getState().append([
        { id: nanoid(8), role: 'user', text: `Fix “${nodeName}”` },
        {
          id: nanoid(8),
          role: 'assistant',
          parts: [
            { kind: 'text', text: suggestion.detail },
            { kind: 'proposal', proposal: { id: suggestion.id, summary: suggestion.title, ops: suggestion.ops, dropped: suggestion.dropped ?? [], warnings: suggestion.warnings ?? [] } },
          ],
        },
      ]);
      return;
    }
    if (bubble.send) {
      void submit(bubble.text, bubble.mention ? [bubble.mention] : []);
      return;
    }
    if (bubble.mention) setMentions((m) => [...m, bubble.mention!]);
    setText(bubble.text, bubble.caret);
  };

  /** Keys Spotlight handles stay here; the rest (⌘S, ⌘↵) still reach the editor. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (bubbles.length && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !draft.includes('\n')) {
      handled();
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % bubbles.length : (a - 1 + bubbles.length) % bubbles.length));
    } else if (e.key === 'Tab' && !e.shiftKey && bubbles.length && draft.trim()) {
      handled();
      choose(bubbles[Math.max(0, active)]);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      handled();
      if (active >= 0 && bubbles[active]) choose(bubbles[active]);
      else void submit(draft);
    } else if (e.key === 'Escape') {
      handled();
      if (showConversation) useAssistant.getState().setOpen(false);
      else if (draft) setText('');
      else input.current?.blur();
    }
  };

  const placeholder = empty ? 'Describe the workflow you want…' : 'Ask, or describe a change…  @ tags a node';

  return (
    <div className="pointer-events-auto relative w-full min-w-0 max-w-[540px]">
      <div className="pointer-events-none absolute inset-x-0 bottom-full mb-2 flex flex-col gap-2">
        {showConversation && <Conversation live={live} status={busy ? 'Drafting the flow from the node catalog…' : undefined} />}
        {bubbles.length > 0 && (
          <div role="listbox" aria-label="Suggestions" className="flex flex-wrap justify-center gap-1.5">
            {bubbles.map((b, i) => (
              <button
                key={b.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(b)}
                style={{ animationDelay: `${i * 40}ms` }}
                className={cn(
                  'pointer-events-auto flex max-w-full animate-fade-up items-center gap-1.5 rounded-full border bg-sf/95 px-3 py-1 text-[12.5px] text-t1 shadow-[0_6px_18px_rgba(0,0,0,0.08)] backdrop-blur transition-colors hover:border-acbd',
                  i === active ? 'border-ac' : 'border-hair',
                )}
              >
                {b.kind === 'ask' && <Sparkles className="size-3 shrink-0 text-viz-7" />}
                <span className="truncate">{b.label}</span>
                {b.hint && <span className="shrink-0 text-[11px] text-t3">{b.hint}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        className={cn(
          'flex items-end gap-2 rounded-2xl border bg-sf/95 px-2.5 py-1.5 shadow-pop backdrop-blur transition-colors',
          focused ? 'border-[color-mix(in_oklab,var(--viz-7)_45%,var(--bd))]' : 'border-hair',
        )}
      >
        <Sparkles className="mb-[9px] size-4 shrink-0 text-viz-7" />
        {selectedName && !withoutSelection && !empty && (
          <span className="mb-[5px] flex max-w-[150px] shrink-0 items-center gap-0.5 rounded-md border border-hair bg-wl py-0.5 pl-1.5 pr-0.5 text-[11.5px] text-t2" title="The selected node is part of what Spotlight sees">
            <span className="truncate">{selectedName}</span>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => setWithoutSelection(true)} aria-label={`Leave ${selectedName} out`} className="grid size-4 place-items-center rounded text-t3 hover:text-t1">
              <X className="size-3" />
            </button>
          </span>
        )}
        <textarea
          id={INPUT_ID}
          ref={input}
          rows={1}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Ask Spotlight"
          aria-autocomplete="list"
          className="max-h-[120px] min-h-[32px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-5 text-t1 outline-none placeholder:text-t3"
        />
        {hasItems && !showConversation && (
          <button
            onClick={() => useAssistant.getState().setOpen(true)}
            title="Show the conversation"
            aria-label="Show the conversation"
            className="mb-[3px] flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[12px] text-t2 hover:bg-acdim hover:text-t1"
          >
            <MessageSquare className="size-3.5" />
            {waiting > 0 && <span className="rounded-full bg-viz-7 px-1.5 text-[10.5px] font-semibold leading-4 text-bg">{waiting}</span>}
          </button>
        )}
        {!focused && !draft && !hasItems && <kbd className="mb-[9px] shrink-0 rounded border border-hair px-1 font-mono text-[10.5px] text-t3">⌘I</kbd>}
        {live ? (
          <button
            onClick={() => useAssistant.getState().stop()}
            disabled={busy}
            aria-label="Stop"
            title="Stop"
            className="mb-[2px] grid size-8 shrink-0 place-items-center rounded-full border border-bd text-t2 transition-colors hover:border-rd hover:text-rd disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3" fill="currentColor" />}
          </button>
        ) : (
          <button
            onClick={() => void submit(draft)}
            disabled={!draft.trim()}
            aria-label="Send"
            className="mb-[2px] grid size-8 shrink-0 place-items-center rounded-full bg-ac2 text-on-ac transition-all hover:scale-105 disabled:opacity-30 disabled:hover:scale-100"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
