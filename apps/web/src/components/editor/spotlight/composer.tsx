'use client';
/** The input at the bottom of the panel, with its bubbles above it. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Mic, Sparkles, Square, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { cn } from '@/lib/utils';
import { ChatComposer, ModelChip } from '../../ui/chat';
import { MentionChips } from '../../ui/mention-picker';
import { useMentionPicker } from '@/lib/client/use-mention-picker';
import { scopeLabel, scopeOf, type SpotlightScope } from '@/lib/shared/spotlight-scope'; // SB07:
import { mentionQueryAt, type MentionHit } from '@/lib/shared/mentions';
import { completeBubbles, idleBubbles, liveMentions, TEST_BUBBLE, type Bubble, type Mention, type SpotlightContext } from '@/lib/shared/spotlight';
import { useBuildFlow } from '../ai-builder';
import { afterReply, typedSession } from '../autonomous';
import { answeredQuestion } from './answered-question';
import { draftWholeFlow } from './draft-flow';
import { suggestionKey, useAssistant, useSuggestions, useWorking, type ChatItem, type KeptMention, type Suggestion } from '../assistant';
import { useEditor } from '../store';
import { usePhone } from '@/lib/client/use-phone';
import { dictationSupported, useDictation } from '../use-dictation';
import { testUntilItRuns } from '../test-session';
import { lastOutcomeOf, lastRunOf, openNeedOf } from '../timeline';


export const INPUT_ID = 'spotlight-input';

/** ⌘I and the empty canvas's hint: unfold the panel and put the caret in Spotlight. */
export function focusSpotlight() {
  useAssistant.getState().setCollapsed(false);
  requestAnimationFrame(() => document.getElementById(INPUT_ID)?.focus());
}

const latestMain = (runs: { source: string; status: string }[] | undefined) => runs?.filter((r) => r.source === 'main').at(-1);

/** The model of the latest reply that says one, and whether it runs locally. */
function lastModel(items: ChatItem[]): { name: string; local: boolean } | undefined {
  const turn = items.findLast((i) => i.role === 'assistant' && (i.meta?.model ?? i.done?.model));
  return turn?.role === 'assistant' ? { name: (turn.meta?.model ?? turn.done?.model)!, local: Boolean(turn.meta?.local) } : undefined;
}

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

// SB04: the bubble after a question's answer.
const FIX_ANSWER = 'fix-answer';

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
  const answered = useAssistant((s) => answeredQuestion(s.items)); // SB04:
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
  const workflowId = useEditor((s) => s.workflowId);
  // The `@` picker (docs/spotlight.md): the canvas's nodes first ("On this page"), then everything else the caller may tag.
  const canvasHits = useMemo<MentionHit[]>(() => ctx.nodes.map((n) => ({ type: 'node', id: n.id, workflowId, name: n.name, hint: 'on the canvas' })), [ctx.nodes, workflowId]);
  const picker = useMentionPicker({ value: draft, onChange: (next) => setDraft(next), inputRef: input, scope: { workflowId: workflowId || undefined, local: canvasHits } });
  const live = pending || drafting;
  // The model that answered last: no route says which one answers before the first reply.
  const model = useAssistant((s) => lastModel(s.items)?.name);
  const local = useAssistant((s) => lastModel(s.items)?.local);
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

  // SB07: what the message may change, as it is typed: the selected step, steps tagged with @ or named with "only", or where a new step goes.
  // The chip's × lifts it for this message (the chip then disappears and the send says `scope: null`); it comes back with an empty box or a new selection.
  const [scopeLifted, setScopeLifted] = useState(false);
  const selectedId = useEditor((s) => (withoutSelection ? undefined : (s.openNodeId ?? s.nodes.find((n) => n.selected)?.id)));
  const scopeFor = (message: string): SpotlightScope | undefined =>
    scopeOf({
      message,
      nodes: ctx.nodes,
      selectedId,
      taggedIds: picker.chips.filter((c) => c.type === 'node' && c.workflowId === workflowId).map((c) => c.id),
    });
  const scope = useMemo(
    () => (scopeLifted || empty || !draft.trim() ? undefined : scopeFor(draft)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeLifted, empty, draft, ctx.nodes, selectedId, picker.chips, workflowId],
  );
  useEffect(() => setScopeLifted(false), [selectedName, draft === '']);

  const bubbles = useMemo<Bubble[]>(() => {
    if (live) return [];
    // While an @ is being typed, the picker answers, not the bubbles.
    if (draft.trim()) return focused && !mentionQueryAt(draft, Math.min(caret, draft.length)) ? completeBubbles(draft, caret, ctx) : [];
    if (working) return [];
    const offer: Bubble[] = fix ? [{ id: `fix:${fix.suggestion.id}`, label: /^fix\b/i.test(fix.suggestion.title) ? fix.suggestion.title : `Fix: ${fix.suggestion.title}`, kind: 'ask', text: '', caret: 0 }] : [];
    // SB04: after a question's answer, one bubble turns the answer into a change.
    if (answered) offer.unshift({ id: FIX_ANSWER, label: 'Fix it', kind: 'ask', text: `Fix it: ${answered}`, caret: 0, send: true });
    const idle = idleBubbles(ctx);
    // Unfocused, only what needs attention (a failure) or a start on an empty canvas.
    const quiet = focused || empty ? idle : idle.filter((b) => b.id.startsWith('why-'));
    return [...offer, ...quiet].slice(0, 3);
  }, [live, draft, caret, focused, ctx, working, fix, empty, answered]);

  useEffect(() => setActive(-1), [bubbles]);

  // The caret follows the arrow keys and clicks too: the bubbles complete what is at it.
  useEffect(() => {
    const follow = () => {
      if (document.activeElement === input.current) setCaret(input.current?.selectionStart ?? 0);
    };
    document.addEventListener('selectionchange', follow);
    return () => document.removeEventListener('selectionchange', follow);
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
    // The picker's chips, then node types chosen from the bubbles still in the message.
    const scoped = scopeLifted ? null : (scopeFor(message) ?? null); // SB07: no chip shown, no scope for the server to apply
    const typed: KeptMention[] = liveMentions(message, [...mentions, ...extra]).flatMap((m) => (m.kind === 'type' ? [{ type: 'nodeType' as const, id: m.type, name: m.label }] : []));
    const tagged: KeptMention[] = [...picker.chips.map((c) => ({ type: c.type, id: c.id, ...(c.workflowId && { workflowId: c.workflowId }), name: c.name })), ...typed];
    picker.clear();
    setScopeLifted(false); // SB07:
    setDraft('');
    setCaret(0);
    setMentions([]);
    if (!useEditor.getState().nodes.length) {
      // An empty canvas: the builder drafts the whole flow in one go, with test data on the trigger.
      await draftWholeFlow(message, build);
      return;
    }
    await useAssistant.getState().send(message, {
      withoutSelection,
      ...(scoped !== undefined && { scope: scoped }), // SB07:
      // SB04: autonomous only on a brand-new draft and only for a change: the model hears that its proposal is applied and tested as it ends. A question is answered, never applied.
      ...typedSession(message),
      ...(tagged.length && { mentions: tagged.slice(0, 8) }),
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
    // The picker, when it is open, takes the arrows, Enter, Tab and Escape.
    picker.onKeyDown(e);
    if (e.defaultPrevented) return;
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

      <div className="relative">
        {picker.listbox}
        <ChatComposer
          value={draft}
          onChange={(text) => {
            setDraft(text);
            setCaret(input.current?.selectionStart ?? text.length);
          }}
          onSend={(text) => void submit(text)}
          onStop={() => useAssistant.getState().stop()}
          busy={live}
          placeholder={placeholder}
          label="Ask Spotlight"
          id={INPUT_ID}
          inputRef={input}
          onKeyDown={onKeyDown}
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
          top={
            picker.chips.length || scope || (selectedName && !withoutSelection && !empty) || (model && !drafting && !pending) ? (
              <>
                {/* The tags chosen with @: each is read for Spotlight when the message is sent. */}
                <MentionChips chips={picker.chips} onRemove={picker.remove} />
                {scope || (selectedName && !withoutSelection && !empty) || (model && !drafting && !pending) ? (
                  // The model chip sits with the selected node: a 360 px column has no room for it beside the text.
                  <div className="mb-1 flex items-center justify-between gap-2">
                    {(scope && !empty) || (selectedName && !withoutSelection && !empty) ? (
                      <span className="flex min-w-0 flex-wrap items-center gap-1">
                    {scope && !empty ? (
                      // SB07: the scope; it takes the selection chip's place when the scope is the selection (one chip, not two).
                      <span className="flex w-fit min-w-0 max-w-full items-center gap-0.5 rounded-md border border-hair bg-wl py-0.5 pl-1.5 pr-0.5 text-[11.5px] text-t2" title="Spotlight changes only this; the × lifts it for this message">
                        <span className="truncate">{scopeLabel(scope, ctx.nodes)}</span>
                        <button onMouseDown={(e) => e.preventDefault()} onClick={() => setScopeLifted(true)} aria-label={`Lift: ${scopeLabel(scope, ctx.nodes)}`} className="grid size-4 place-items-center rounded text-t3 hover:text-t1 max-md:size-9">
                          <X className="size-3" />
                        </button>
                      </span>
                    ) : null}
                    {selectedName && !withoutSelection && !empty && !(scope && scope.nodes.length === 1 && scope.nodes[0] === selectedId) ? (
                      <span className="flex w-fit min-w-0 max-w-full items-center gap-0.5 rounded-md border border-hair bg-wl py-0.5 pl-1.5 pr-0.5 text-[11.5px] text-t2" title="The selected node is part of what Spotlight sees">
                        <span className="truncate">{selectedName}</span>
                        <button onMouseDown={(e) => e.preventDefault()} onClick={() => setWithoutSelection(true)} aria-label={`Leave ${selectedName} out`} className="grid size-4 place-items-center rounded text-t3 hover:text-t1 max-md:size-9">
                          <X className="size-3" />
                        </button>
                      </span>
                    ) : null}
                      </span>
                    ) : (
                      <span />
                    )}
                    {model && !drafting && !pending && <ModelChip model={model} local={local} />}
                  </div>
                ) : null}
              </>
            ) : undefined
          }
          before={<Sparkles className="mb-[9px] size-4 shrink-0 text-viz-7" />}
          after={
            <>
              {!focused && !draft && !hasItems && <kbd className="mb-[9px] shrink-0 rounded border border-hair px-1 font-mono text-[10.5px] text-t3 max-md:hidden">⌘K</kbd>}
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
            </>
          }
        />
      </div>
    </div>
  );
}
