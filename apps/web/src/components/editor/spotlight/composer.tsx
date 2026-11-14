'use client';
/** The input at the bottom of the panel, with its bubbles above it. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Loader2, Mic, Sparkles, Square, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { cn } from '@/lib/utils';
import { completeBubbles, idleBubbles, liveMentions, TEST_BUBBLE, type Bubble, type Mention, type SpotlightContext } from '@/lib/shared/spotlight';
import { useBuildFlow } from '../ai-builder';
import { afterReply, testDraft, useAutonomous } from '../autonomous';
import { draft as draftCall, suggestionKey, useAssistant, useSuggestions, useWorking, type ChatItem, type Suggestion } from '../assistant';
import { useEditor } from '../store';
import { usePhone } from '@/lib/client/use-phone';
import { dictationSupported, useDictation } from '../use-dictation';
import { testUntilItRuns } from '../test-session';
import { lastOutcomeOf, lastRunOf, openNeedOf } from '../timeline';

import type { Reply } from './reply';

export const INPUT_ID = 'spotlight-input';

/** ⌘I and the empty canvas's hint: unfold the panel and put the caret in Spotlight. */
export function focusSpotlight() {
  useAssistant.getState().setCollapsed(false);
  requestAnimationFrame(() => document.getElementById(INPUT_ID)?.focus());
}

const latestMain = (runs: { source: string; status: string }[] | undefined) => runs?.filter((r) => r.source === 'main').at(-1);

/** What Spotlight knows of the canvas and the catalog, for its bubbles. */
function useSpotlightContext(): SpotlightContext {
  const nodes = useEditor((s) => s.nodes);
  const edges = useEditor((s) => s.edges);
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const runs = useEditor((s) => s.runs);
  const selectedId = useEditor((s) => s.openNodeId ?? s.nodes.find((n) => n.selected)?.id);
  // How the last session ended, since the person last asked: what to offer next follows from it.
  const outcome = useAssistant((s) => {
    if (s.testing || s.pending) return undefined;
    if (openNeedOf(s.items)) return 'needs' as const;
    const run = lastRunOf(s.items.slice(s.items.findLastIndex((i) => i.role === 'user' && !i.auto) + 1));
    if (lastOutcomeOf(s.items)) return 'stopped' as const;
    return run?.state === 'passed' ? ('passed' as const) : run?.state === 'failed' ? ('stopped' as const) : undefined;
  });
  return useMemo(
    () => ({
      nodes: nodes.map((n) => {
        const { id, name, type } = n.data.wf;
        const descriptor = nodeTypes[type]?.descriptor;
        // An AI Agent needs a chat model; Run an Agent and Run a Team run on the agent's own (their model port is optional).
        const agent = type !== 'core.messageAgent' && type !== 'core.runTeam' && Boolean(descriptor?.inputs.some((p) => p.type === 'ai_languageModel'));
        return {
          id,
          name,
          type,
          trigger: descriptor?.kind === 'trigger',
          agent,
          hasModel: agent && edges.some((e) => e.target === id && e.data?.connectionType === 'ai_languageModel'),
          // A tool, model or memory connects to its agent: not where the flow ends.
          outgoing: edges.some((e) => e.source === id),
          failed: latestMain(runs[id])?.status === 'error',
          x: n.position.x,
        };
      }),
      types: Object.values(nodeTypes)
        .filter((t) => t.available && !t.blocked)
        .map((t) => ({ type: t.type, displayName: t.descriptor.displayName, plugin: t.pluginId === 'core' ? 'Built-in' : t.pluginName, trigger: t.descriptor.kind === 'trigger', keywords: t.descriptor.keywords ?? [] })),
      selectedId,
      ...(outcome && { outcome }),
    }),
    [nodes, edges, nodeTypes, runs, selectedId, outcome],
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

/** The input at the bottom of the panel, with its bubbles above it. */
export function Composer() {
  const hasItems = useAssistant((s) => s.items.length > 0);
  const pending = useAssistant((s) => s.pending || Boolean(s.testing));
  const drafting = useAssistant((s) => s.drafting);
  const phone = usePhone();
  const working = useWorking();
  const empty = useEditor((s) => s.nodes.length === 0);
  const selectedName = useEditor((s) => {
    const id = s.openNodeId ?? s.nodes.find((n) => n.selected)?.id;
    return id ? s.nodes.find((n) => n.id === id)?.data.wf.name : undefined;
  });
  const ctx = useSpotlightContext();
  const [offered, setOffered] = useState<Set<string>>(() => new Set());
  const fix = useFailureFix(offered);
  const { build } = useBuildFlow();
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(blurTimer.current), []);
  const [active, setActive] = useState(-1);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [withoutSelection, setWithoutSelection] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const live = pending || drafting;
  // Speech lands in the box to edit, appended to what's typed; it is never sent by voice alone.
  const dictation = useDictation((spoken) => {
    const typed = inputValue.current.trim();
    setText(typed ? `${typed} ${spoken}` : spoken);
  });
  const [canDictate, setCanDictate] = useState(false);
  useEffect(() => setCanDictate(dictationSupported()), []);
  const inputValue = useRef('');
  inputValue.current = draft;

  // A new selection is back in the context.
  useEffect(() => setWithoutSelection(false), [selectedName]);

  const bubbles = useMemo<Bubble[]>(() => {
    if (live) return [];
    if (draft.trim()) return focused ? completeBubbles(draft, caret, ctx) : [];
    if (working) return [];
    const offer: Bubble[] = fix ? [{ id: `fix:${fix.suggestion.id}`, label: /^fix\b/i.test(fix.suggestion.title) ? fix.suggestion.title : `Fix: ${fix.suggestion.title}`, kind: 'ask', text: '', caret: 0 }] : [];
    const idle = idleBubbles(ctx);
    // Unfocused, only what needs attention (a failure) or a start on an empty canvas.
    const quiet = focused || empty ? idle : idle.filter((b) => b.id.startsWith('why-'));
    return [...offer, ...quiet].slice(0, 3);
  }, [live, draft, caret, focused, ctx, working, fix, empty]);

  useEffect(() => setActive(-1), [bubbles]);

  const resize = () => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };
  useEffect(resize, [draft]);
  // Also when the box changes width (a side panel opens, the dock wraps): the wrapped placeholder counts in scrollHeight.
  useEffect(() => {
    const el = input.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      resize();
    });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      useAssistant.setState({ drafting: true });
      const abort = (draftCall.request = new AbortController());
      try {
        const flow = await build(message, abort.signal);
        const auto = useAutonomous.getState().on;
        const skipped = flow.dropped ? ` I left out ${flow.dropped} part${flow.dropped === 1 ? '' : 's'} that didn’t fit.` : '';
        const pinned = flow.pinned ? ' Test data is pinned on the trigger.' : '';
        patch({
          parts: [{ kind: 'text', text: `Built “${flow.name}” with ${flow.nodes} nodes.${skipped}${pinned} ⌘Z undoes it.${auto ? ' Testing it now.' : ''}` }, { kind: 'action', action: 'test', goal: message }],
          done: { model: flow.model, durationMs: flow.durationMs, steps: 1 },
        });
        // Autonomous: no "Test and fix" click. It starts once the drafting card is gone (finally, below).
        if (auto) queueMicrotask(() => testDraft(reply.id, message));
      } catch (e) {
        if (abort.signal.aborted) patch({ parts: [{ kind: 'text', text: 'Stopped: nothing was drafted.' }] });
        else patch({ error: `Couldn’t build the flow: ${(e as Error).message}` });
      } finally {
        if (draftCall.request === abort) draftCall.request = undefined;
        useAssistant.setState({ drafting: false });
      }
      return;
    }
    await useAssistant.getState().send(message, {
      withoutSelection,
      // Autonomous: the model hears that its proposal is applied and tested as it ends, so it never says "click Apply".
      ...(useAutonomous.getState().on && { session: 'auto' as const }),
      ...(tagged.length && {
        mentions: {
          nodes: tagged.flatMap((m) => (m.kind === 'node' ? [m.id] : [])),
          types: tagged.flatMap((m) => (m.kind === 'type' ? [m.type] : [])),
        },
      }),
    });
    // Autonomous: what the reply proposed is applied and the flow tested, without Apply or Test and fix.
    await afterReply(message);
  };

  const choose = (bubble: Bubble) => {
    if (bubble.id === TEST_BUBBLE) {
      // Busy already: no message left behind without a session.
      if (useAssistant.getState().pending || useAssistant.getState().testing) return;
      useAssistant.getState().append([{ id: nanoid(8), role: 'user', text: bubble.label }]);
      void testUntilItRuns(useEditor.getState().description?.trim() || undefined);
      return;
    }
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
    } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
      handled();
      if (active >= 0 && bubbles[active]) choose(bubbles[active]);
      else void submit(draft);
    } else if (e.key === 'Escape') {
      handled();
      if (draft) setText('');
      else input.current?.blur();
    }
  };

    const placeholder = drafting || pending ? 'Spotlight is working on the flow…' : empty ? 'Describe the workflow you want…' : 'Ask or describe a change';

  return (
    <div className="shrink-0 space-y-2 border-t border-hair p-2.5">
      <div className="flex flex-col gap-2">
        {bubbles.length > 0 && (
          <div role="listbox" aria-label="Suggestions" className="flex flex-wrap gap-1.5">
            {bubbles.map((b, i) => (
              <button
                key={b.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(b)}
                style={{ animationDelay: `${i * 40}ms` }}
                className={cn(
                  'flex max-w-full animate-fade-up items-center gap-1.5 rounded-full border bg-sf px-3 py-1 text-[12.5px] text-t1 transition-colors hover:border-acbd',
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
          'rounded-2xl border bg-wl px-2.5 py-1.5 transition-colors',
          focused ? 'border-[color-mix(in_oklab,var(--viz-7)_45%,var(--bd))]' : 'border-hair',
        )}
      >
        {selectedName && !withoutSelection && !empty && (
          <span className="mb-1 flex w-fit max-w-full items-center gap-0.5 rounded-md border border-hair bg-wl py-0.5 pl-1.5 pr-0.5 text-[11.5px] text-t2" title="The selected node is part of what Spotlight sees">
            <span className="truncate">{selectedName}</span>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => setWithoutSelection(true)} aria-label={`Leave ${selectedName} out`} className="grid size-4 place-items-center rounded text-t3 hover:text-t1 max-md:size-9">
              <X className="size-3" />
            </button>
          </span>
        )}
        <div className="flex items-end gap-2">
        <Sparkles className="mb-[9px] size-4 shrink-0 text-viz-7" />
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
          onFocus={() => {
            clearTimeout(blurTimer.current);
            setFocused(true);
          }}
          // The bubbles fold a moment after the input loses focus: folding at once moves the timeline under a tap, which
          // then lands on nothing (a phone's first tap on a row after typing).
          onBlur={() => {
            if (phone) blurTimer.current = setTimeout(() => setFocused(false), 250);
            else setFocused(false);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Ask Spotlight"
          aria-autocomplete="list"
          className="max-h-[120px] min-h-[32px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-5 text-t1 max-md:text-base outline-none placeholder:text-t3"
        />
        {!focused && !draft && !hasItems && <kbd className="mb-[9px] shrink-0 max-md:hidden rounded border border-hair px-1 font-mono text-[10.5px] text-t3">⌘I</kbd>}
        {canDictate && !live && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (dictation.state === 'recording' ? dictation.stop() : void dictation.start())}
            disabled={dictation.state === 'transcribing'}
            aria-label={dictation.state === 'recording' ? 'Stop recording' : 'Dictate'}
            aria-pressed={dictation.state === 'recording'}
            title={dictation.error || (dictation.state === 'recording' ? 'Stop and transcribe' : 'Dictate (speech goes into the box to edit)')}
            className={cn(
              'mb-[2px] flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-t2 transition-colors hover:bg-acdim hover:text-t1 disabled:opacity-60 max-md:h-11 max-md:min-w-11 max-md:justify-center',
              dictation.state === 'recording' && 'bg-rd/15 text-rd hover:bg-rd/20 hover:text-rd',
              dictation.error && 'text-rd',
            )}
          >
            {dictation.state === 'transcribing' ? <Loader2 className="size-4 animate-spin" /> : dictation.state === 'recording' ? <Square className="size-3.5 animate-pulse" fill="currentColor" /> : <Mic className="size-4" />}
            {dictation.state === 'recording' && <span className="font-mono text-[11.5px] tabular-nums">{Math.floor(dictation.seconds / 60)}:{String(dictation.seconds % 60).padStart(2, '0')}</span>}
          </button>
        )}
        {live ? (
          <button
            onClick={() => useAssistant.getState().stop()}
            aria-label="Stop"
            title="Stop"
            className="mb-[2px] grid size-8 shrink-0 place-items-center rounded-full border border-bd text-t2 transition-colors hover:border-rd hover:text-rd disabled:opacity-50 max-md:size-11"
          >
            <Square className="size-3" fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={() => void submit(draft)}
            disabled={!draft.trim()}
            aria-label="Send"
            className="mb-[2px] grid size-8 shrink-0 place-items-center rounded-full bg-ac2 text-on-ac transition-all hover:scale-105 disabled:opacity-30 disabled:hover:scale-100 max-md:size-11"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
        </div>
      </div>
    </div>
  );
}
