'use client';
/**
 * Spotlight in the Brain workbench (docs/second-brain.md#the-brain-page): the editor's Spotlight bar, floating at the
 * bottom of the open file, for asking the brain. Bubbles above it suggest questions about the open file; the
 * conversation opens above the bar, each answer with its page links (which open tabs) and its numbered sources. With a
 * page open, the question is about that page (`about`, the chip in the bar) until the chip is removed. ⌘I focuses it.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles, SquarePen, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { api } from '@/lib/client/api';
import { usePhone } from '@/lib/client/use-phone';
import { cn } from '@/lib/utils';
import { CHAT_ICON_BUTTON, ChatComposer, ChatError, UserBubble, Working } from '../../ui/chat';
import type { WikiAnswer } from '@/lib/shared/brain-wiki';
import { PageLink, WikiText, WorkList, WrittenBy } from './parts';

export const SPOTLIGHT_INPUT = 'brain-spotlight-input';

interface Turn {
  id: string;
  question: string;
  /** The file it was asked from. */
  about?: { ref: string; name: string };
  answer?: WikiAnswer;
  error?: string;
  /** Stopped by the person, not failed. */
  stopped?: boolean;
}

/** The open file, as Spotlight knows it: a page (asked about), or index/log (asked about everything). */
export interface SpotlightFile {
  ref: string;
  name: string;
  page: boolean;
  /** For the bubbles: the busiest shared page, when the file is the index. */
  topShared?: string;
}

function bubblesFor(file?: SpotlightFile): string[] {
  if (file?.page) return [`What is the latest on ${file.name}?`, `Who else works on ${file.name}?`, `Is any team duplicating ${file.name}?`];
  return [file?.topShared ? `Who is working on ${file.topShared}, and from which teams?` : 'Which customers did more than one team work on?', 'What changed this week?', 'Which initiatives have no owner?'];
}

/** `request` asks a question from elsewhere (the quick-open palette's "Ask"); a new `key` asks again. */
export function BrainSpotlight({ file, request }: { file?: SpotlightFile; request?: { question: string; key: number } }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [aboutOff, setAboutOff] = useState(false);
  const [focused, setFocused] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const reading = useRef<AbortController | undefined>(undefined);
  const phone = usePhone();

  // A new file brings its chip back.
  useEffect(() => setAboutOff(false), [file?.ref]);
  // The latest question at the top, so its answer reads from its start; its sources stay folded below.
  const last = turns.at(-1);
  useEffect(() => {
    if (!last) return;
    const el = document.getElementById(`turn-${last.id}`);
    if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
  }, [last?.id, last?.answer, last?.error]);

  const about = file?.page && !aboutOff ? { ref: file.ref, name: file.name } : undefined;

  const ask = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    const turn: Turn = { id: nanoid(8), question, ...(about && { about }) };
    setTurns((all) => [...all, turn]);
    setInput('');
    setOpen(true);
    setBusy(true);
    const controller = new AbortController();
    reading.current = controller;
    try {
      const answer = await api<WikiAnswer>('/api/brain/ask', { method: 'POST', json: { question, ...(about && { about: about.ref }) }, signal: controller.signal });
      setTurns((all) => all.map((t) => (t.id === turn.id ? { ...t, answer } : t)));
    } catch (e) {
      const stopped = controller.signal.aborted;
      setTurns((all) => all.map((t) => (t.id === turn.id ? { ...t, error: stopped ? 'Stopped.' : (e as Error).message, stopped } : t)));
    } finally {
      reading.current = undefined;
      setBusy(false);
    }
  };
  /** Try again: the question of a turn that failed, asked again in its place. */
  const retry = (turn: Turn) => {
    setTurns((all) => all.filter((t) => t.id !== turn.id));
    void ask(turn.question);
  };

  const asker = useRef(ask);
  useEffect(() => {
    asker.current = ask;
  });
  useEffect(() => {
    if (request?.question) void asker.current(request.question);
  }, [request?.key, request?.question]);

  const showBubbles = !open && focused && !input;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-2 px-3 pb-3">
      {open && turns.length > 0 && (
        <div className="pointer-events-auto flex max-h-[min(62vh,560px)] w-full max-w-[720px] flex-col overflow-hidden rounded-2xl border border-bd bg-sf shadow-pop animate-fade-up">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-hair px-3 py-1.5 text-[12px] text-t2">
            <Sparkles className="size-3.5 text-viz-7" aria-hidden />
            <span className="font-medium text-t1">Spotlight</span>
            <span className="text-t3">· asks the brain</span>
            <button type="button" onClick={() => setTurns([])} className={cn(CHAT_ICON_BUTTON, 'ml-auto')} title="New conversation" aria-label="New conversation">
              <SquarePen className="size-3.5" />
            </button>
            <button type="button" onClick={() => setOpen(false)} className={CHAT_ICON_BUTTON} title="Hide the conversation" aria-label="Hide the conversation">
              <ChevronDown className="size-4" />
            </button>
          </div>
          <div ref={scroller} className="relative min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
            {turns.map((t) => (
              <TurnView key={t.id} turn={t} onRetry={busy ? undefined : () => retry(t)} />
            ))}
            {busy && <Working label="Reading the pages, facts and work…" />}
          </div>
        </div>
      )}

      {showBubbles && (
        // On a phone the bubbles sit on a card: floating, they would cross the page's text.
        <div className="pointer-events-auto flex max-w-[720px] flex-wrap justify-center gap-1.5 max-md:rounded-2xl max-md:border max-md:border-hair max-md:bg-sf max-md:p-2 max-md:shadow-pop">
          {bubblesFor(file).map((b) => (
            <button
              key={b}
              type="button"
              // Before the input's blur hides the bubbles.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void ask(b)}
              className="rounded-full border border-hair bg-sf px-3 py-1 text-[12px] text-t2 shadow-pop hover:border-ac hover:text-t1 max-md:min-h-11 max-md:shadow-none"
            >
              {b}
            </button>
          ))}
        </div>
      )}

      <ChatComposer
        id={SPOTLIGHT_INPUT}
        className="pointer-events-auto w-full max-w-[720px] border-bd bg-sf shadow-pop"
        value={input}
        onChange={setInput}
        onSend={(text) => void ask(text)}
        onStop={() => reading.current?.abort()}
        busy={busy}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setOpen(false);
            e.currentTarget.blur();
          }
        }}
        placeholder={about ? `Ask about ${about.name}` : phone ? 'Ask the brain' : 'Ask the brain: who is working on…, what changed…, is anyone else…'}
        label="Ask the brain"
        before={
          <>
            <Sparkles className="mb-[9px] size-4 shrink-0 text-viz-7" aria-hidden />
            {about && (
              <span className="mb-[5px] inline-flex max-w-[40%] shrink-0 items-center gap-1 rounded-md bg-acdim px-1.5 py-0.5 text-[11.5px] text-ac">
                <span className="truncate">@{about.name}</span>
                <button type="button" onClick={() => setAboutOff(true)} aria-label="Ask about everything" title="Ask about everything, not this page" className="grid place-items-center hover:text-t1 max-md:size-9">
                  <X className="size-3" />
                </button>
              </span>
            )}
          </>
        }
        after={
          <>
            {!open && turns.length > 0 && (
              <button type="button" onClick={() => setOpen(true)} className="mb-[2px] min-h-8 shrink-0 rounded-full px-2 text-[11.5px] text-t3 hover:bg-acdim hover:text-t1 max-md:min-h-11">
                {turns.length} answer{turns.length === 1 ? '' : 's'}
              </button>
            )}
            <kbd className="mb-[9px] hidden shrink-0 rounded border border-hair px-1 font-mono text-[10.5px] text-t3 sm:inline">⌘I</kbd>
          </>
        }
      />
    </div>
  );
}

function TurnView({ turn, onRetry }: { turn: Turn; onRetry?: () => void }) {
  const [cited, setCited] = useState<number>();
  const [sources, setSources] = useState(false);
  const { answer } = turn;
  const names = new Map([...(answer?.pages ?? []).map((p) => [`${p.type}/${p.id}`, p.name] as const), ...(answer?.links ?? []).map((l) => [l.ref, l.name] as const)]);
  const prefix = `ans-${turn.id}`;
  return (
    <div id={`turn-${turn.id}`} className="space-y-2.5">
      <UserBubble>
        {turn.about && <span className="mr-1 text-[11.5px] text-ac">@{turn.about.name}</span>}
        {turn.question}
      </UserBubble>
      {turn.error && (turn.stopped ? <p className="text-[12px] text-t3">Stopped.</p> : <ChatError message={turn.error} onRetry={onRetry} />)}
      {answer && (
        <div className="space-y-2.5">
          {answer.answer ? (
            <>
              <WrittenBy model={answer.model} />
              <WikiText
                text={answer.answer}
                links={answer.links}
                onCite={(n) => {
                  setSources(true);
                  setCited(n);
                  setTimeout(() => document.getElementById(`${prefix}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
                }}
              />
            </>
          ) : (
            <p className="text-[12px] text-t3">{answer.note ?? (answer.model ? 'The brain found nothing to answer from.' : 'No model is set for the brain (LANDFLOW_BRAIN_MODEL), so here is what it found.')}</p>
          )}
          {answer.pages.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
              <span className="text-t3">Pages</span>
              {answer.pages.map((p) => (
                <PageLink key={`${p.type}/${p.id}`} refId={`${p.type}/${p.id}`} name={p.name} />
              ))}
            </div>
          )}
          {answer.work.length > 0 && (
            <div className="space-y-1.5">
              <button type="button" onClick={() => setSources((v) => !v)} className="flex items-center gap-1 text-[11.5px] font-medium text-t3 hover:text-t1">
                {sources ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {answer.work.length} source{answer.work.length === 1 ? '' : 's'}
              </button>
              {sources && <WorkList items={answer.work} names={names} numbered highlight={cited} idPrefix={prefix} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Put the caret in Spotlight. */
export function focusBrainSpotlight() {
  document.getElementById(SPOTLIGHT_INPUT)?.focus();
}
