'use client';
/**
 * Ask the brain (docs/second-brain.md#the-brain-page): the conversation about the brain. It is the body of the shell's Spotlight panel
 * (docs/spotlight.md#one-spotlight): a right column on a desktop, a bottom sheet on a phone; a link in an answer opens the page.
 * The answer streams: first what the brain found ("Found 3 pages · 2 facts"), then its words, then the sources it cited,
 * the model, time and cost. A follow-up carries the last two turns. Built on the chat kit.
 *
 * The conversation is kept per page (docs/assistant.md#conversation-history): opening a page shows its last one under
 * "Earlier" when this visit has no answers yet (following a link keeps the answers on screen), the history button opens any other, and `@` tags pages, people, workflows and runs, each read as a step.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SquarePen, Sparkles, X } from 'lucide-react';
import { usePathname } from 'next/navigation'; // NB08:
import { nanoid } from 'nanoid';
import { api, ApiError } from '@/lib/client/api';
import { useConversation } from '@/lib/client/conversations';
import { useMentionPicker } from '@/lib/client/use-mention-picker';
import { usePhone } from '@/lib/client/use-phone';
import { cn } from '@/lib/utils';
import type { ActivityStep } from '@/lib/shared/activity';
import { createBody } from '@/lib/shared/conversations';
import type { ConversationItem, ConversationItemInput, ConversationPart, ConversationRecord } from '@/lib/shared/conversations';
import type { MentionHit } from '@/lib/shared/mentions';
import { ASK_HISTORY_CHARS, ASK_HISTORY_TURNS, streamingPreview, type AskEvent, type AskTurn, type WikiLink, type WorkItem } from '@/lib/shared/brain-wiki';
import { ActivityTrace } from '../../ui/activity-trace';
import { ConversationHistory } from '../../ui/conversation-history';
import { MentionChips } from '../../ui/mention-picker';
import { CHAT_ICON_BUTTON, ChatComposer, ChatEmpty, ChatError, ModelChip, ReplyMeta, UserBubble, type ReplyInfo } from '../../ui/chat';
import { ChatList, ChatMotion, StatusSwap, StreamingText } from '../../ui/chat-motion';
import { PageLink, WikiText, WorkRow } from './parts';
import { notionBrainAsk, hideNotionKeys, type NotionBrainAsk } from '@/lib/shared/notion-brain-ask'; // NB08:
import { notionBrainReply, type NotionBrainReply } from '../../spotlight/notion-brain-turn'; // NB08:
import { NotionBrainCard } from '../../spotlight/notion-brain-card'; // NB08:
import { useProjectStore } from '../../projects/use-projects'; // NB08:

export const ASK_INPUT = 'brain-ask-input';

/** The page a question is about. */
export interface AskAbout {
  ref: string;
  name: string;
}

/** What a question was tagged with: the shape a conversation keeps (a `mentions` part). */
export interface AskTag {
  type: string;
  id: string;
  workflowId?: string;
  name: string;
}

/** What tells two tags apart (type, workflow and id), so a tag counts once in a turn. */
const tagKey = (tag: AskTag): string => `${tag.type}:${tag.workflowId ?? ''}:${tag.id}`;

/** NB08: a typed message the shell decided is about the Notion brain: shown here, answered without a model, never stored. */
export interface LocalTurn {
  id: string;
  at: number;
  /** The typed text, with any key-shaped string hidden. */
  text: string;
  ask: NotionBrainAsk;
  reply?: NotionBrainReply;
}

export interface AskItem {
  id: string;
  question: string;
  about?: AskAbout;
  /** Tagged with @ (not counting the page it was asked from). */
  mentions?: AskTag[];
  /** From a conversation kept earlier: under the "Earlier" divider. */
  earlier?: boolean;
  /** Links (and tags) a reopened turn lost because the reader may no longer open them. */
  hidden?: number;
  found?: { pages: Array<{ id: string; name: string }>; facts: number; work: number; knowledge?: number };
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

const newItem = (question: string, about?: AskAbout, mentions?: AskTag[]): AskItem => ({
  id: nanoid(8),
  question,
  ...(about && { about }),
  ...(mentions?.length && { mentions }),
  steps: [],
  streamed: '',
  links: [],
  sources: [],
  cited: [],
  status: 'working',
});

const MODEL_STEP = 'Writing the answer';

/** The turn after one event of the stream: pure, so the order of events is what the screen shows. */
export function applyAskEvent(item: AskItem, event: AskEvent): AskItem {
  switch (event.type) {
    case 'found':
      return { ...item, found: { pages: event.pages, facts: event.facts, work: event.work, ...(event.knowledge && { knowledge: event.knowledge }) } };
    case 'step.start':
      return { ...item, steps: [...item.steps, { id: `s${event.step}`, label: event.label, kind: event.label === MODEL_STEP ? 'model' : 'read', status: 'running' }] };
    case 'tool': {
      const done: Partial<ActivityStep> = {
        label: event.label,
        ...(event.name === 'search_facts' && { kind: 'search' as const }),
        status: event.ok ? 'ok' : 'failed',
        durationMs: event.durationMs,
        ...(event.detail && { detail: event.detail }),
      };
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
        info: {
          ...(event.model && { model: event.model }),
          local: event.local,
          durationMs: event.durationMs,
          steps: event.steps,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.costUsd !== undefined && { costUsd: event.costUsd }),
        },
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

const splitRef = (ref: string) => {
  const cut = ref.indexOf('/');
  return { type: ref.slice(0, cut), id: ref.slice(cut + 1) };
};

/** The tags a turn kept: the page it was asked from, then what was tagged (once each). */
export function turnTags(item: Pick<AskItem, 'about' | 'mentions'>): AskTag[] {
  const tags: AskTag[] = [...(item.about ? [{ type: 'brainPage', id: item.about.ref, name: item.about.name }] : []), ...(item.mentions ?? [])];
  const seen = new Set<string>();
  return tags.filter((t) => !seen.has(tagKey(t)) && seen.add(tagKey(t)));
}

/**
 * A finished turn as the two conversation items it is kept as: the question (text and the tags: names only, never what
 * was read from them) and the answer (its words, the links, the sources it cited) with its steps and what it cost.
 */
export function turnItems(item: AskItem): ConversationItemInput[] {
  const tags = turnTags(item);
  const user: ConversationItemInput = { role: 'user', parts: [{ type: 'text', text: item.question }, ...(tags.length ? [{ type: 'mentions' as const, refs: tags }] : [])] };
  const parts: ConversationPart[] = [];
  if (item.answer) {
    const sources = item.cited.flatMap((n) =>
      item.sources[n - 1]
        ? [{ n, title: (item.sources[n - 1]!.title ?? item.sources[n - 1]!.summary ?? item.sources[n - 1]!.kind).slice(0, 500), ...(item.sources[n - 1]!.url && { url: item.sources[n - 1]!.url }) }]
        : [],
    );
    parts.push({ type: 'answer', text: item.answer, links: item.links.map((l) => ({ ...splitRef(l.ref), name: l.name })), ...(sources.length && { sources }) });
  }
  if (item.steps.length)
    parts.push({ type: 'steps', steps: item.steps.map((s) => ({ id: s.id, label: s.label, kind: s.kind, status: s.status, ...(s.durationMs !== undefined && { durationMs: s.durationMs }) })) });
  if (item.error) parts.push({ type: 'error', message: item.error });
  else if (!item.answer) parts.push({ type: 'text', text: item.note ?? '' });
  const i = item.info;
  return [
    user,
    {
      role: 'assistant',
      parts,
      ...(i && {
        meta: {
          ...(i.model && { model: i.model }),
          ...(i.durationMs !== undefined && { durationMs: i.durationMs }),
          ...(i.steps !== undefined && { steps: i.steps }),
          ...(i.inputTokens !== undefined && { inputTokens: i.inputTokens }),
          ...(i.outputTokens !== undefined && { outputTokens: i.outputTokens }),
          ...(i.costUsd !== undefined && { costUsd: i.costUsd }),
          ...(i.local && { local: true }),
        },
      }),
    },
  ];
}

/** `[[type/id|Name]]` for a page that is not in `links` (the reader may no longer open it) as the plain name. */
export function dropHiddenLinks(text: string, links: WikiLink[]): string {
  const allowed = new Set(links.map((l) => l.ref));
  return text.replace(/\[\[([a-z]+\/[a-z0-9][a-z0-9_.-]{0,63})(?:\|([^\]]*))?\]\]/g, (whole, ref: string, name?: string) => (allowed.has(ref) ? whole : name || ref.split('/')[1]!));
}

/** A kept conversation as turns (under "Earlier"): each question with the answer that followed it. */
export function restoreAsk(items: ConversationItem[]): AskItem[] {
  const out: AskItem[] = [];
  let open: AskItem | undefined;
  for (const item of items) {
    if (item.role === 'user') {
      const question = item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n');
      const tags = item.parts.flatMap((p) => (p.type === 'mentions' ? p.refs : [])).map((r): AskTag => ({ type: r.type, id: r.id, name: r.name, ...(r.workflowId && { workflowId: r.workflowId }) }));
      open = { ...newItem(question, undefined, tags), earlier: true, status: 'done', ...(item.meta?.hidden && { hidden: item.meta.hidden }) };
      out.push(open);
      continue;
    }
    const target = open ?? (out[out.push({ ...newItem(''), earlier: true, status: 'done' }) - 1] as AskItem);
    open = undefined;
    const answer = item.parts.find((p) => p.type === 'answer');
    const links = answer?.type === 'answer' ? answer.links.map((l): WikiLink => ({ ref: `${l.type}/${l.id}`, name: l.name })) : [];
    const failure = item.parts.find((p) => p.type === 'error');
    const note = item.parts.find((p) => p.type === 'text');
    const steps = item.parts
      .flatMap((p) => (p.type === 'steps' ? p.steps : []))
      .map((s): ActivityStep => ({
        id: s.id,
        label: s.label,
        kind: (s.kind as ActivityStep['kind']) || 'tool',
        status: s.status === 'failed' ? 'failed' : 'ok',
        ...(s.durationMs !== undefined && { durationMs: s.durationMs }),
      }));
    const m = item.meta;
    Object.assign(target, {
      links,
      steps,
      ...(answer?.type === 'answer' && { answer: dropHiddenLinks(answer.text, links), streamed: answer.text }),
      ...(failure?.type === 'error' && { error: failure.message, stopped: failure.message === 'Stopped.' }),
      ...(note?.type === 'text' && note.text && !answer && { note: note.text }),
      ...((target.hidden || m?.hidden) && { hidden: (target.hidden ?? 0) + (m?.hidden ?? 0) }),
      ...(m && { info: { model: m.model, durationMs: m.durationMs, steps: m.steps, inputTokens: m.inputTokens, outputTokens: m.outputTokens, costUsd: m.costUsd, local: m.local } }),
    });
  }
  return out;
}

/**
 * What a change of page does to the turns on screen. A turn from this visit (not `earlier`) is never dropped by moving to
 * another page, so following a link in an answer keeps the answer: `keep` leaves everything where it is and the page's own
 * conversation is not resumed. Only a panel that holds nothing of this visit resumes the page's last conversation.
 */
export function subjectChange(items: readonly Pick<AskItem, 'earlier'>[]): 'keep' | 'resume' {
  return items.some((i) => !i.earlier) ? 'keep' : 'resume';
}

/** "1 link hidden" / "3 links hidden": under a reopened turn that lost links the reader may no longer open. */
export const hiddenLine = (n: number) => `${n} ${n === 1 ? 'link' : 'links'} hidden`;

/**
 * The conversation: kept by whoever shows the panel, so closing it and opening it again brings the answers back. It is
 * also kept on the server, per page (`setSubject`): the page's last conversation comes back under "Earlier", and what is
 * said is stored as it finishes (nothing when the person keeps no conversations). Following a link to another page keeps
 * this visit's turns on screen (a running one finishes and is stored in the page it began on); see `subjectChange`.
 */
export function useAskConversation() {
  const [items, setItems] = useState<AskItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [subject, setSubject] = useState<string>();
  // NB08: Notion-brain turns are local: never sent to Ask, never stored in the conversation. `at` is how many Ask turns came before.
  const [local, setLocal] = useState<LocalTurn[]>([]);
  const kept = useConversation(subject ? { surface: 'brain', subjectType: 'brainPage', subjectId: subject } : { surface: 'brain' });
  const keptRef = useRef(kept);
  const itemsRef = useRef(items);
  const reading = useRef<AbortController | undefined>(undefined);
  // Moving to another page or conversation: a turn still finishing must not be stored in the new one.
  const epoch = useRef(0);
  // A page's own conversation was asked for: a question asked before it arrives cancels the resume.
  const resumeToken = useRef(0);
  const askedFrom = useRef<string | undefined>(undefined);
  askedFrom.current = subject;
  // A conversation was asked for: its items are shown when they arrive (a new array, not the one there was then).
  const want = useRef<{ before: ConversationItem[]; force: boolean } | null>(null);
  useEffect(() => {
    itemsRef.current = items;
    keptRef.current = kept;
  });
  // Closing the panel does not stop an answer coming in: the conversation lives in the always-mounted ShellSpotlight, so
  // the answer finishes in the background and is there when the panel reopens. Only unmounting this view aborts the read.
  useEffect(() => () => reading.current?.abort(), []);

  const awaitItems = (force: boolean) => {
    want.current = { before: keptRef.current.items, force };
  };
  useEffect(() => {
    const asked = want.current;
    if (!asked || kept.items === asked.before) return;
    want.current = null;
    // The person has already asked something here: theirs stays, and what they say next goes to a new conversation.
    if (!asked.force && itemsRef.current.length) return keptRef.current.startNew();
    setItems(restoreAsk(kept.items));
  }, [kept.items]);

  const lastSubject = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lastSubject.current === subject) return;
    lastSubject.current = subject;
    want.current = null;
    // This visit's turns stay (and a running one finishes); only a panel with none resumes the page's conversation.
    if (subjectChange(itemsRef.current) === 'keep') return;
    epoch.current += 1;
    setItems([]);
    if (!subject) return;
    const token = ++resumeToken.current;
    const params = new URLSearchParams({ surface: 'brain', subjectType: 'brainPage', subjectId: subject, limit: '1' });
    void api<{ conversations: ConversationRecord[] }>(`/api/conversations?${params}`, { background: true })
      .then(({ conversations }) => {
        // The person moved to another page while it loaded.
        if (lastSubject.current !== subject || resumeToken.current !== token || !conversations[0]) return;
        awaitItems(false);
        return keptRef.current.open(conversations[0].id).catch(() => {
          want.current = null;
        });
      })
      .catch(() => undefined);
  }, [subject]);

  const ask = useCallback(async (text: string, about?: AskAbout, tags?: AskTag[]) => {
    const question = text.trim();
    if (!question || reading.current) return;
    const item = newItem(question, about, tags);
    const history = historyOf(itemsRef.current);
    setItems((all) => [...all, item]);
    setBusy(true);
    const controller = new AbortController();
    reading.current = controller;
    const started = epoch.current;
    // The page and conversation it began in: a turn that finishes after a link was followed is stored there.
    const beganAt = askedFrom.current;
    const beganIn = keptRef.current.id;
    resumeToken.current++;
    want.current = null;
    let current = item;
    const update = (change: (i: AskItem) => AskItem) => {
      current = change(current);
      const shown = current;
      setItems((all) => all.map((i) => (i.id === item.id ? shown : i)));
    };
    try {
      await readAsk(
        {
          question,
          ...(about && { about: about.ref }),
          ...(tags?.length && { mentions: { refs: tags.map((t) => ({ type: t.type, id: t.id, ...(t.workflowId && { workflowId: t.workflowId }), name: t.name })) } }),
          ...(history.length && { history }),
        },
        (event) => update((i) => applyAskEvent(i, event)),
        controller.signal,
      );
      // A stream that ended without `done` (the connection dropped) is not left spinning.
      update((i) => (i.status === 'done' ? i : applyAskEvent(i, { type: 'error', kind: 'internal', message: 'The answer stopped before it finished.' })));
    } catch (caught) {
      const stopped = controller.signal.aborted;
      update((i) => ({ ...i, status: 'done', steps: i.steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed' } : s)), error: stopped ? 'Stopped.' : (caught as Error).message, stopped }));
    } finally {
      reading.current = undefined;
      setBusy(false);
    }
    if (epoch.current !== started) return;
    if (askedFrom.current === beganAt) void keptRef.current.append(turnItems(current)).catch(() => undefined);
    else void storeElsewhere(beganAt, beganIn, current).catch(() => undefined);
  }, []);
  const stop = useCallback(() => reading.current?.abort(), []);
  // NB08:
  const askNotion = useCallback((text: string, ask: NotionBrainAsk, ctx: { projectId?: string }) => {
    const id = nanoid(8);
    setLocal((all) => [...all, { id, at: itemsRef.current.length, text: hideNotionKeys(text), ask }]);
    void (async () => {
      let projects = useProjectStore.getState().projects;
      if (!projects && ask.kind !== 'key') {
        await useProjectStore.getState().refresh();
        projects = useProjectStore.getState().projects;
      }
      const reply = await notionBrainReply(ask, { ...ctx, projects: (projects ?? []).map((p) => ({ id: p.id, name: p.name, ...(p.role && { role: p.role }) })) });
      setLocal((all) => all.map((t) => (t.id === id ? { ...t, reply } : t)));
    })();
  }, []);
  const clear = useCallback(() => {
    setLocal([]); // NB08:
    epoch.current += 1;
    reading.current?.abort();
    want.current = null;
    keptRef.current.startNew();
    setItems([]);
  }, []);
  /** Show a kept conversation (from the history button). */
  const open = useCallback((id: string) => {
    if (reading.current) return;
    setLocal([]); // NB08:
    epoch.current += 1;
    awaitItems(true);
    void keptRef.current.open(id).catch(() => {
      want.current = null;
    });
  }, []);
  const retry = useCallback(
    (item: AskItem) => {
      setItems((all) => all.filter((i) => i.id !== item.id));
      void ask(item.question, item.about, item.mentions);
    },
    [ask],
  );
  return { items, busy, ask, stop, clear, retry, open, setSubject, local, askNotion };
}
/** A turn that finished on another page than the panel is on now: stored in the conversation it began in (or a new one for that page). */
async function storeElsewhere(subject: string | undefined, id: string | undefined, item: AskItem): Promise<void> {
  const target =
    id ??
    (await api<{ conversation: ConversationRecord | null }>('/api/conversations', { method: 'POST', json: createBody({ surface: 'brain', ...(subject && { subjectType: 'brainPage', subjectId: subject }) }, item.question) })).conversation?.id;
  if (target) await api(`/api/conversations/${target}/items`, { method: 'POST', json: { items: turnItems(item) } });
}
export type AskConversation = ReturnType<typeof useAskConversation>;

/** `request` asks a question from elsewhere; a new `key` asks again. */
export function AskPanel({
  about,
  onClose,
  conversation,
  model,
  starters,
  request,
  subject,
  onSubjectOff,
  heading,
}: {
  about?: AskAbout;
  /** Asked about one thing that is not a brain page (a run, a workflow): a chip like `about`, sent as a tag (docs/spotlight.md#one-spotlight). */
  subject?: AskTag;
  /** The subject chip was removed: the question goes to everything. */
  onSubjectOff?: () => void;
  /** Replaces the header's title: the shell's mode chip. */
  heading?: ReactNode;
  onClose: () => void;
  conversation?: AskConversation;
  model?: string;
  starters?: string[];
  request?: { question: string; key: number };
}) {
  const own = useAskConversation();
  // NB08: a conversation made by a test or an older caller may not carry the local turns: the panel's own then.
  const kept = (conversation as Partial<AskConversation> | undefined)?.askNotion ? conversation! : own;
  const { items, busy, ask, stop, clear, retry, open, setSubject } = conversation ?? own;
  const { local: notionTurns, askNotion } = kept;
  const projectPage = /^\/projects\/([^/?#]+)/.exec(usePathname() ?? '')?.[1];
  const [input, setInput] = useState('');
  const [aboutOff, setAboutOff] = useState(false);
  const [subjectOff, setSubjectOff] = useState(false);
  const phone = usePhone();
  const box = useRef<HTMLTextAreaElement>(null);
  // A new page brings its chip back, and its own conversation (the last one comes back under "Earlier").
  useEffect(() => setAboutOff(false), [about?.ref]);
  useEffect(() => setSubjectOff(false), [subject?.type, subject?.id]);
  useEffect(() => setSubject(about?.ref), [about?.ref, setSubject]);
  const chip = about && !aboutOff ? about : undefined;
  const subjectChip = subject && !subjectOff ? subject : undefined;
  // "On this page" in the picker: the page, and the pages the last answers linked to.
  const local = useMemo(() => {
    const linked = items
      .slice(-2)
      .flatMap((i) => i.links)
      .filter((l) => l.ref !== about?.ref);
    const hits: MentionHit[] = [
      ...(about ? [{ type: 'brainPage' as const, id: about.ref, name: about.name, hint: 'This page' }] : []),
      ...linked.map((l) => ({ type: 'brainPage' as const, id: l.ref, name: l.name, hint: 'Linked' })),
    ];
    const seen = new Set<string>();
    return hits.filter((h) => !seen.has(h.id) && seen.add(h.id)).slice(0, 6);
  }, [items, about]);
  const picker = useMentionPicker({ value: input, onChange: setInput, inputRef: box, scope: { local } });
  const send = (text: string) => {
    setInput('');
    const picked = picker.chips.map((c): AskTag => ({ type: c.type, id: c.id, name: c.name, ...(c.workflowId && { workflowId: c.workflowId }) }));
    // The thing it was sent about goes first, once.
    const tags = subjectChip && !picked.some((t) => tagKey(t) === tagKey(subjectChip)) ? [subjectChip, ...picked] : picked;
    picker.clear();
    // NB08: a Notion-brain ask never goes to Ask or the conversation store: it becomes a local turn.
    const notion = notionBrainAsk(text);
    if (notion) return askNotion(text, notion, projectPage ? { projectId: decodeURIComponent(projectPage) } : {});
    void ask(text, chip, tags.slice(0, 8));
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
  const history = <ConversationHistory surface="brain" ownSurfaceOnly {...(about && { subjectType: 'brainPage', subjectId: about.ref })} subjectLabel="This page" onOpen={open} onNew={clear} />;

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
          {!heading && <Sparkles className="size-3.5 text-viz-7" aria-hidden />}
          {heading ?? <span className="font-medium text-t1">Ask the brain</span>}
          <span className="ml-auto">{history}</span>
          <button type="button" onClick={clear} disabled={!items.length} className={cn(CHAT_ICON_BUTTON, 'disabled:opacity-30')} title="New conversation" aria-label="New conversation">
            <SquarePen className="size-3.5" />
          </button>
          <button type="button" onClick={onClose} className={CHAT_ICON_BUTTON} title="Close (⌘K)" aria-label="Close Ask">
            <X className="size-3.5" />
          </button>
        </div>

        {items.length === 0 && notionTurns.length === 0 ? ( // NB08: local turns count
          <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto py-6">
            <ChatEmpty title="Ask the brain" help="It answers from the pages, facts and work you can open, and says where each answer comes from." starters={starters} onStarter={(s) => send(s)} />
          </div>
        ) : (
          <ChatList className="min-h-0 flex-1 space-y-4 px-3 py-3">
            {items.map((item, i) => (
              <Fragment key={item.id}>
                {notionTurns.filter((t) => Math.min(t.at, items.length) === i).map((t) => <LocalTurnView key={t.id} turn={t} />) /* NB08: */}
                {item.earlier && !items[i - 1]?.earlier && (
                  <div role="separator" className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
                    <span className="h-px flex-1 bg-hair" />
                    Earlier
                    <span className="h-px flex-1 bg-hair" />
                  </div>
                )}
                <AskTurnView item={item} onRetry={busy ? undefined : () => retry(item)} />
              </Fragment>
            ))}
            {notionTurns.filter((t) => t.at >= items.length).map((t) => <LocalTurnView key={t.id} turn={t} />) /* NB08: */}
          </ChatList>
        )}

        <div className="shrink-0 border-t border-hair p-2.5 max-md:border-0 max-md:pt-1">
          {phone && (
            <div className="mb-1 flex items-center gap-1">
              {history}
              {items.length > 0 && (
                <button type="button" onClick={clear} className="flex min-h-11 items-center gap-1 rounded-full px-2 text-[12px] text-t3 hover:text-t1">
                  <SquarePen className="size-3.5" aria-hidden /> New conversation
                </button>
              )}
            </div>
          )}
          <div className="relative">
            {picker.listbox}
            <ChatComposer
              id={ASK_INPUT}
              inputRef={box}
              className="border-bd bg-sf"
              value={input}
              onChange={setInput}
              onSend={send}
              onStop={stop}
              busy={busy}
              placeholder={chip || subjectChip ? `Ask about ${(chip ?? subjectChip)!.name}` : 'Who is working on…, what changed…'}
              label="Ask the brain"
              onKeyDown={(e) => {
                picker.onKeyDown(e);
                if (e.defaultPrevented) return;
                if (e.key === 'Escape') {
                  e.preventDefault();
                  onClose();
                }
              }}
              top={
                (chip || subjectChip || picker.chips.length > 0) && (
                  <div className="flex flex-wrap items-start gap-x-1.5">
                    {chip && (
                      <span className="mb-1 inline-flex max-w-full items-center gap-1 rounded-md bg-acdim px-1.5 py-0.5 text-[11.5px] text-ac">
                        <span className="truncate">@{chip.name}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setAboutOff(true);
                            onSubjectOff?.();
                          }}
                          aria-label="Ask about everything"
                          title="Ask about everything, not this page"
                          className="grid place-items-center hover:text-t1 max-md:size-9"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    )}
                    {subjectChip && (
                      <span className="mb-1 inline-flex max-w-full items-center gap-1 rounded-md bg-acdim px-1.5 py-0.5 text-[11.5px] text-ac">
                        <span className="truncate">@{subjectChip.name}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setSubjectOff(true);
                            onSubjectOff?.();
                          }}
                          aria-label="Ask about everything"
                          title="Ask about everything, not this"
                          className="grid place-items-center hover:text-t1 max-md:size-9"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    )}
                    <MentionChips chips={picker.chips} onRemove={picker.remove} />
                  </div>
                )
              }
              chip={modelName ? <ModelChip model={modelName} local={modelName.startsWith('ollama/')} /> : undefined}
            />
          </div>
        </div>
      </div>
    </ChatMotion>
  );
}

/** NB08: a Notion-brain turn: what was typed (a key hidden), then the words or the card. */
function LocalTurnView({ turn }: { turn: LocalTurn }) {
  const reply = turn.reply;
  return (
    <div className="space-y-2.5" data-testid="notion-turn">
      <UserBubble>{turn.text}</UserBubble>
      {!reply ? (
        <p className="text-[12px] text-t3" role="status">
          Looking…
        </p>
      ) : (
        <div className="space-y-2">
          {reply.kind === 'card' && reply.text ? <p className="text-[13px] text-t1">{reply.text}</p> : null}
          {reply.kind === 'text' || reply.kind === 'key' ? <p className="text-[13px] leading-relaxed text-t1 [overflow-wrap:anywhere]">{reply.text}</p> : null}
          {reply.kind === 'text' && reply.fix ? (
            <a href={reply.fix.href} className="inline-block text-[12px] font-medium text-accent underline" data-testid="notion-fix-link">
              {reply.fix.label}: open the Brain card
            </a>
          ) : null}
          {reply.kind !== 'text' && <NotionBrainCard reply={reply} />}
        </div>
      )}
    </div>
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
  const foundLine =
    item.found &&
    [
      `${item.found.pages.length} ${item.found.pages.length === 1 ? 'page' : 'pages'}`,
      `${item.found.facts} ${item.found.facts === 1 ? 'fact' : 'facts'}`,
      ...(item.found.work ? [`${item.found.work} work ${item.found.work === 1 ? 'item' : 'items'}`] : []),
      ...(item.found.knowledge ? [`${item.found.knowledge} Notion ${item.found.knowledge === 1 ? 'page' : 'pages'}`] : []), // NB06:
    ].join(' · ');
  return (
    <div id={`turn-${item.id}`} className="space-y-2.5">
      <UserBubble>
        {item.about && <span className="mr-1 text-[11.5px] text-ac">@{item.about.name}</span>}
        {(item.mentions ?? []).map((t) => (
          <span key={`${t.type}:${t.id}`} className="mr-1 text-[11.5px] text-ac">
            @{t.name}
          </span>
        ))}
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
      {item.error && (item.stopped ? <p className="text-[12px] text-t3">Stopped.</p> : <ChatError message={item.error} onRetry={onRetry} />)}
      {!item.error && (live || item.answer || item.note) && (
        <StatusSwap working={live && !item.streamed}>
          {item.answer && !live ? (
            <div className="space-y-2">
              <WikiText
                text={item.answer}
                links={item.links}
                onCite={
                  item.earlier
                    ? undefined
                    : (n) => {
                        setSourcesOpen(true);
                        setCited(n);
                        setTimeout(() => document.getElementById(`${prefix}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
                      }
                }
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
      {item.hidden ? <p className="text-[12px] text-t3">{hiddenLine(item.hidden)}</p> : null}
      {!item.error && item.status === 'done' && !item.answer && !item.note && <p className="text-[12px] text-t3">The brain found nothing to answer from.</p>}
      {shown.length > 0 && !live && (
        <div className="space-y-1.5">
          <button
            type="button"
            aria-expanded={sourcesOpen}
            onClick={() => setSourcesOpen((v) => !v)}
            className="flex min-h-7 items-center text-[11.5px] font-medium text-t3 hover:text-t1 max-md:min-h-11"
          >
            {sourcesOpen ? '▾' : '▸'} {shown.length} source
            {shown.length === 1 ? '' : 's'}
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
