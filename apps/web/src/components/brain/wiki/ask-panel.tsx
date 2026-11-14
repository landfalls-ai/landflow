'use client';
/**
 * Ask the brain (docs/second-brain.md#the-brain-page): the conversation beside the page. On a desktop it is the right
 * column of the workbench (the page narrows, a link in an answer opens the page next to it); on a phone, a bottom sheet.
 * The answer streams: first what the brain found ("Found 3 pages · 2 facts"), then its words, then the sources it cited,
 * the model, time and cost. A follow-up carries the last two turns. Built on the chat kit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SquarePen, Sparkles, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { ApiError } from '@/lib/client/api';
import { usePhone } from '@/lib/client/use-phone';
import { cn } from '@/lib/utils';
import type { ActivityKind, ActivityStep } from '@/lib/shared/activity';
import { ASK_HISTORY_CHARS, ASK_HISTORY_TURNS, streamingPreview, type AskEvent, type AskTurn, type WikiLink, type WorkItem } from '@/lib/shared/brain-wiki';
import { ActivityTrace } from '../../ui/activity-trace';
import { CHAT_ICON_BUTTON, ChatComposer, ChatEmpty, ChatError, ModelChip, ReplyMeta, UserBubble, type ReplyInfo } from '../../ui/chat';
import { ChatList, ChatMotion, StatusSwap, StreamingText } from '../../ui/chat-motion';
import { PageLink, WikiText, WorkRow } from './parts';

export const ASK_INPUT = 'brain-ask-input';

/** The page a question is about. */
export interface AskAbout {
  ref: string;
  name: string;
}

export interface AskItem {
  id: string;
  question: string;
  about?: AskAbout;
  found?: { pages: Array<{ id: string; name: string }>; facts: number; work: number };
  steps: ActivityStep[];
  /** The words so far, while they stream. */
  streamed: string;
  /** The checked answer. */
  answer?: string;
  links: WikiLink[];
  sources: WorkItem[];
  cited: number[];
  info?: ReplyInfo;
  note?: string;
  error?: string;
  /** Stopped by the person, not failed. */
  stopped?: boolean;
  status: 'working' | 'done';
}

const newItem = (question: string, about?: AskAbout): AskItem => ({ id: nanoid(8), question, ...(about && { about }), steps: [], streamed: '', links: [], sources: [], cited: [], status: 'working' });

/** The turn after one event of the stream: pure, so the order of events is what the screen shows. */
export function applyAskEvent(item: AskItem, event: AskEvent): AskItem {
  switch (event.type) {
    case 'found':
      return { ...item, found: { pages: event.pages, facts: event.facts, work: event.work } };
    case 'step.start':
      return { ...item, steps: [...item.steps, { id: `s${event.step}`, label: event.label, kind: event.step > 3 ? 'model' : 'read', status: 'running' }] };
    case 'tool': {
      const kind: ActivityKind = event.name === 'search_facts' ? 'search' : 'read';
      const done: Partial<ActivityStep> = { label: event.label, kind: event.step > 3 ? 'model' : kind, status: event.ok ? 'ok' : 'failed', durationMs: event.durationMs, ...(event.detail && { detail: event.detail }) };
      return { ...item, steps: item.steps.map((s) => (s.id === `s${event.step}` ? { ...s, ...done } : s)) };
    }
    case 'text.delta':
      return { ...item, streamed: item.streamed + event.text };
    case 'text':
      return { ...item, answer: event.text, streamed: event.text };
    case 'done':
      return {
        ...item,
        status: 'done',
        links: event.links,
        sources: event.sources,
        cited: event.cited,
        steps: item.steps.map((s) => (s.status === 'running' ? { ...s, status: 'ok' } : s)),
        ...(event.note && { note: event.note }),
        info: { ...(event.model && { model: event.model }), local: event.local, durationMs: event.durationMs, steps: event.steps, inputTokens: event.inputTokens, outputTokens: event.outputTokens, ...(event.costUsd !== undefined && { costUsd: event.costUsd }) },
      };
    case 'error':
      return { ...item, status: 'done', error: event.message, steps: item.steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed' } : s)) };
  }
}

/** The last two answered turns, as the server takes them: each part 1,500 characters at most. */
export function historyOf(items: AskItem[]): AskTurn[] {
  return items
    .filter((i) => i.answer && !i.error)
    .slice(-ASK_HISTORY_TURNS)
    .map((i) => ({ question: i.question.slice(0, ASK_HISTORY_CHARS), answer: (i.answer ?? '').slice(0, ASK_HISTORY_CHARS) }));
}

/** POST and read the SSE answer. Its own reader: the route streams only when asked with `Accept: text/event-stream`. */
async function readAsk(body: unknown, onEvent: (event: AskEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch('/api/brain/ask', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal });
  if (!response.ok || !response.body) {
    const text = await response.text();
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {}
    if (response.status === 401) window.location.assign(`/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
    throw new ApiError(message || `${response.status} ${response.statusText}`, response.status);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = chunk
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (data) onEvent(JSON.parse(data) as AskEvent);
    }
  }
}

/** The conversation: kept by whoever shows the panel, so closing it and opening it again brings the answers back. */
export function useAskConversation() {
  const [items, setItems] = useState<AskItem[]>([]);
  const [busy, setBusy] = useState(false);
  const itemsRef = useRef(items);
  const reading = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    itemsRef.current = items;
  });

  const ask = useCallback(async (text: string, about?: AskAbout) => {
    const question = text.trim();
    if (!question || reading.current) return;
    const item = newItem(question, about);
    const history = historyOf(itemsRef.current);
    setItems((all) => [...all, item]);
    setBusy(true);
    const controller = new AbortController();
    reading.current = controller;
    const update = (change: (i: AskItem) => AskItem) => setItems((all) => all.map((i) => (i.id === item.id ? change(i) : i)));
    try {
      await readAsk({ question, ...(about && { about: about.ref }), ...(history.length && { history }) }, (event) => update((i) => applyAskEvent(i, event)), controller.signal);
      // A stream that ended without `done` (the connection dropped) is not left spinning.
      update((i) => (i.status === 'done' ? i : applyAskEvent(i, { type: 'error', kind: 'internal', message: 'The answer stopped before it finished.' })));
    } catch (caught) {
      const stopped = controller.signal.aborted;
      update((i) => ({ ...i, status: 'done', steps: i.steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed' } : s)), error: stopped ? 'Stopped.' : (caught as Error).message, stopped }));
    } finally {
      reading.current = undefined;
      setBusy(false);
    }
  }, []);
  const stop = useCallback(() => reading.current?.abort(), []);
  const clear = useCallback(() => {
    reading.current?.abort();
    setItems([]);
  }, []);
  const retry = useCallback(
    (item: AskItem) => {
      setItems((all) => all.filter((i) => i.id !== item.id));
      void ask(item.question, item.about);
    },
    [ask],
  );
  return { items, busy, ask, stop, clear, retry };
}
export type AskConversation = ReturnType<typeof useAskConversation>;

/** `request` asks a question from elsewhere; a new `key` asks again. */
export function AskPanel({ about, onClose, conversation, model, starters, request }: { about?: AskAbout; onClose: () => void; conversation?: AskConversation; model?: string; starters?: string[]; request?: { question: string; key: number } }) {
  const own = useAskConversation();
  const { items, busy, ask, stop, clear, retry } = conversation ?? own;
  const [input, setInput] = useState('');
  const [aboutOff, setAboutOff] = useState(false);
  const phone = usePhone();
  // A new page brings its chip back.
  useEffect(() => setAboutOff(false), [about?.ref]);
  const chip = about && !aboutOff ? about : undefined;
  const send = (text: string) => {
    setInput('');
    void ask(text, chip);
  };
  const asker = useRef(send);
  useEffect(() => {
    asker.current = send;
  });
  useEffect(() => {
    if (request?.question) asker.current(request.question);
  }, [request?.key, request?.question]);
  useEffect(() => document.getElementById(ASK_INPUT)?.focus(), []);
  const modelName = model ?? items.findLast((i) => i.info?.model)?.info?.model;

  return (
    <ChatMotion>
      <div
        className="flex h-full min-h-0 flex-col"
        // On a phone a link opens the page behind the sheet: the sheet steps aside and comes back from the Ask button.
        onClickCapture={(e) => {
          if (phone && (e.target as HTMLElement).closest('a[href^="/brain/"]')) setTimeout(onClose, 0);
        }}
      >
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-hair px-3 text-[12px] text-t2 max-md:hidden">
          <Sparkles className="size-3.5 text-viz-7" aria-hidden />
          <span className="font-medium text-t1">Ask the brain</span>
          <button type="button" onClick={clear} disabled={!items.length} className={cn(CHAT_ICON_BUTTON, 'ml-auto disabled:opacity-30')} title="New conversation" aria-label="New conversation">
            <SquarePen className="size-3.5" />
          </button>
          <button type="button" onClick={onClose} className={CHAT_ICON_BUTTON} title="Close (⌘I)" aria-label="Close Ask">
            <X className="size-3.5" />
          </button>
        </div>

        {items.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto py-6">
            <ChatEmpty title="Ask the brain" help="It answers from the pages, facts and work you can open, and says where each answer comes from." starters={starters} onStarter={(s) => send(s)} />
          </div>
        ) : (
          <ChatList className="min-h-0 flex-1 space-y-4 px-3 py-3">
            {items.map((item) => (
              <AskTurnView key={item.id} item={item} onRetry={busy ? undefined : () => retry(item)} />
            ))}
          </ChatList>
        )}

        <div className="shrink-0 border-t border-hair p-2.5 max-md:border-0 max-md:pt-1">
          {phone && items.length > 0 && (
            <button type="button" onClick={clear} className="mb-1 flex min-h-11 items-center gap-1 rounded-full px-2 text-[12px] text-t3 hover:text-t1">
              <SquarePen className="size-3.5" aria-hidden /> New conversation
            </button>
          )}
          <ChatComposer
            id={ASK_INPUT}
            className="border-bd bg-sf"
            value={input}
            onChange={setInput}
            onSend={send}
            onStop={stop}
            busy={busy}
            placeholder={chip ? `Ask about ${chip.name}` : 'Who is working on…, what changed…'}
            label="Ask the brain"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            top={
              chip && (
                <span className="mb-1 inline-flex max-w-full items-center gap-1 rounded-md bg-acdim px-1.5 py-0.5 text-[11.5px] text-ac">
                  <span className="truncate">@{chip.name}</span>
                  <button type="button" onClick={() => setAboutOff(true)} aria-label="Ask about everything" title="Ask about everything, not this page" className="grid place-items-center hover:text-t1 max-md:size-9">
                    <X className="size-3" />
                  </button>
                </span>
              )
            }
            chip={modelName ? <ModelChip model={modelName} local={modelName.startsWith('ollama/')} /> : undefined}
          />
        </div>
      </div>
    </ChatMotion>
  );
}

function AskTurnView({ item, onRetry }: { item: AskItem; onRetry?: () => void }) {
  const [cited, setCited] = useState<number>();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const live = item.status === 'working';
  const words = streamingPreview(item.streamed);
  const names = useMemo(() => new Map([...(item.found?.pages ?? []).map((p) => [p.id, p.name] as const), ...item.links.map((l) => [l.ref, l.name] as const)]), [item.found, item.links]);
  const prefix = `ans-${item.id}`;
  const shown = item.cited.map((n) => ({ n, work: item.sources[n - 1] })).filter((s): s is { n: number; work: WorkItem } => Boolean(s.work));
  const foundLine = item.found && [`${item.found.pages.length} ${item.found.pages.length === 1 ? 'page' : 'pages'}`, `${item.found.facts} ${item.found.facts === 1 ? 'fact' : 'facts'}`, ...(item.found.work ? [`${item.found.work} work ${item.found.work === 1 ? 'item' : 'items'}`] : [])].join(' · ');
  return (
    <div id={`turn-${item.id}`} className="space-y-2.5">
      <UserBubble>
        {item.about && <span className="mr-1 text-[11.5px] text-ac">@{item.about.name}</span>}
        {item.question}
      </UserBubble>
      {foundLine && (
        <div className="space-y-1 text-[12px]">
          <p className="text-t3">Found {foundLine}</p>
          {item.found!.pages.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {item.found!.pages.map((p) => (
                <PageLink key={p.id} refId={p.id} name={p.name} />
              ))}
            </div>
          )}
        </div>
      )}
      {(live || item.steps.length > 0) && <ActivityTrace steps={item.steps} live={live && !item.streamed} durationMs={item.info?.durationMs} />}
      {item.error &&
        (item.stopped ? <p className="text-[12px] text-t3">Stopped.</p> : <ChatError message={item.error} onRetry={onRetry} />)}
      {!item.error && (live || item.answer || item.note) && (
        <StatusSwap working={live && !item.streamed}>
          {item.answer && !live ? (
            <div className="space-y-2">
              <WikiText
                text={item.answer}
                links={item.links}
                onCite={(n) => {
                  setSourcesOpen(true);
                  setCited(n);
                  setTimeout(() => document.getElementById(`${prefix}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
                }}
              />
              <ReplyMeta info={item.info} copy={item.answer.replace(/\[\[[a-z]+\/[a-z0-9_.-]+\|([^\]]*)\]\]/g, '$1')} />
            </div>
          ) : words ? (
            <StreamingText text={words} streaming={live} />
          ) : item.note ? (
            <p className="text-[12px] text-t3">{item.note}</p>
          ) : null}
        </StatusSwap>
      )}
      {!item.error && item.status === 'done' && !item.answer && !item.note && <p className="text-[12px] text-t3">The brain found nothing to answer from.</p>}
      {shown.length > 0 && !live && (
        <div className="space-y-1.5">
          <button type="button" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((v) => !v)} className="flex min-h-7 items-center text-[11.5px] font-medium text-t3 hover:text-t1 max-md:min-h-11">
            {sourcesOpen ? '▾' : '▸'} {shown.length} source{shown.length === 1 ? '' : 's'}
          </button>
          {sourcesOpen && (
            <ol className="divide-y divide-hair overflow-hidden rounded-xl border border-hair">
              {shown.map(({ n, work }) => (
                <WorkRow key={work.id} item={work} number={n} names={names} idPrefix={prefix} highlight={cited === n} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
