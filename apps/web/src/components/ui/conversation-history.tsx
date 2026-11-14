'use client';
/**
 * The history button every chat mounts (docs/assistant.md#conversation-history): a clock that opens the person's earlier
 * conversations, in a popover on a desktop and a sheet on a phone. A search box, then the conversations about this
 * subject (when one is given), then everywhere. Each row opens the conversation; ⋯ renames or deletes it. When the person
 * keeps nothing, it says so and offers the switch.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Brain, Clock, Ellipsis, MessageSquare, Sparkles, type LucideIcon } from 'lucide-react';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { setPreference, usePreference } from '@/lib/client/preferences';
import type { ConversationRecord, ConversationSurface } from '@/lib/shared/conversations';
import { cn } from '@/lib/utils';
import { CHAT_ICON_BUTTON } from './chat';
import { confirmAction } from './confirm';
import { SearchInput } from './inputs';
import { Popover } from './popover';

const SURFACE_ICON: Record<ConversationSurface, LucideIcon> = { spotlight: Sparkles, brain: Brain, architect: Bot, 'agent-test': MessageSquare };
const SURFACE_LABEL: Record<ConversationSurface, string> = { spotlight: 'Spotlight', brain: 'Ask the brain', architect: 'Agent architect', 'agent-test': 'Agent test chat' };
const PAGE = 50;

export interface ConversationHistoryProps {
  surface: ConversationSurface;
  subjectType?: string;
  subjectId?: string;
  /** The heading of the conversations about this subject: "This workflow" or "This page". */
  subjectLabel?: string;
  onOpen: (id: string) => void;
  onNew: () => void;
}

/** The query of one request: the subject group asks for its subject, "Everywhere" for none. Pure, so it is tested without a DOM. */
export function historyParams(text: string, subject?: { subjectType: string; subjectId: string }, cursor?: string | null): URLSearchParams {
  const params = new URLSearchParams({ limit: String(PAGE) });
  if (subject) {
    params.set('subjectType', subject.subjectType);
    params.set('subjectId', subject.subjectId);
  }
  if (text.trim()) params.set('q', text.trim());
  if (cursor) params.set('cursor', cursor);
  return params;
}

/** "Everywhere" without the conversations the subject group already shows. */
export function leaveOut(list: ConversationRecord[], shown: ConversationRecord[]): ConversationRecord[] {
  const ids = new Set(shown.map((c) => c.id));
  return list.filter((c) => !ids.has(c.id));
}

interface Page {
  list: ConversationRecord[];
  next: string | null;
}

export function ConversationHistory(props: ConversationHistoryProps) {
  return (
    <Popover title="Conversation history" label="Conversation history" align="end" className="w-[340px] p-0" trigger={({ toggle, open }) => (
      <button type="button" onClick={toggle} aria-label="Conversation history" aria-expanded={open} title="Conversation history" className={CHAT_ICON_BUTTON}>
        <Clock className="size-4" />
      </button>
    )}>
      {(close) => <HistoryList {...props} onOpen={(id) => { close(); props.onOpen(id); }} onNew={() => { close(); props.onNew(); }} />}
    </Popover>
  );
}

function HistoryList({ subjectType, subjectId, subjectLabel, onOpen, onNew }: ConversationHistoryProps) {
  const keeping = usePreference('keepConversations');
  const [query, setQuery] = useState('');
  const subject = subjectType && subjectId ? { subjectType, subjectId } : undefined;
  const [here, setHere] = useState<Page>();
  const [everywhere, setEverywhere] = useState<Page>();
  const [failed, setFailed] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [menu, setMenu] = useState<string>();
  const subjectSeq = useRef(0);
  const everywhereSeq = useRef(0);

  // Each group is its own request and pages on its own; a newer search or a later page of an older one is dropped.
  const load = useCallback(
    async (text: string, which: 'here' | 'everywhere', cursor?: string) => {
      const mine = which === 'here' ? subjectSeq : everywhereSeq;
      const token = ++mine.current;
      const set = which === 'here' ? setHere : setEverywhere;
      try {
        const body = await api<{ conversations: ConversationRecord[]; nextCursor: string | null }>(`/api/conversations?${historyParams(text, which === 'here' ? subject : undefined, cursor)}`, { background: true });
        if (token !== mine.current) return;
        setFailed(false);
        set((before) => ({ list: cursor && before ? [...before.list, ...body.conversations] : body.conversations, next: body.nextCursor }));
      } catch {
        if (token === mine.current) setFailed(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subjectType, subjectId],
  );

  // 250 ms after the last key.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (subject) void load(query, 'here');
      void load(query, 'everywhere');
    }, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (fn: (list: ConversationRecord[]) => ConversationRecord[]) => {
    setHere((before) => before && { ...before, list: fn(before.list) });
    setEverywhere((before) => before && { ...before, list: fn(before.list) });
  };

  const rename = async (c: ConversationRecord, title: string) => {
    setEditing(undefined);
    const clean = title.trim();
    if (!clean || clean === c.title) return;
    try {
      const body = await api<{ conversation: ConversationRecord }>(`/api/conversations/${c.id}`, { method: 'PATCH', json: { title: clean } });
      setProblem(undefined);
      patch((list) => list.map((x) => (x.id === c.id ? body.conversation : x)));
    } catch {
      setProblem("Couldn't rename it.");
    }
  };
  const remove = async (c: ConversationRecord) => {
    setMenu(undefined);
    if (!(await confirmAction(`Delete “${c.title}”? It can't be brought back.`, { action: 'Delete', danger: true }))) return;
    try {
      await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
      setProblem(undefined);
      patch((list) => list.filter((x) => x.id !== c.id));
    } catch {
      setProblem("Couldn't delete it.");
    }
  };

  const hereList = here?.list ?? [];
  const elsewhere = leaveOut(everywhere?.list ?? [], hereList);
  const loaded = everywhere && (!subject || here);
  const hereLabel = subjectLabel ?? (subjectType === 'workflow' ? 'This workflow' : 'This page');

  const row = (c: ConversationRecord) => {
    const Icon = SURFACE_ICON[c.surface];
    return (
      <li key={c.id} className="rounded-lg">
        <div className="flex items-center gap-1 rounded-lg hover:bg-acdim">
          {editing === c.id ? (
            <input
              autoFocus
              defaultValue={c.title}
              aria-label="Conversation name"
              maxLength={200}
              onBlur={(e) => void rename(c, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setEditing(undefined);
                }
              }}
              className="mx-1 h-8 min-w-0 flex-1 rounded-md border border-bd bg-wl px-2 text-[13px] text-t1 outline-none focus:border-ac2 max-md:h-11 max-md:text-[16px]"
            />
          ) : (
            <button type="button" onClick={() => onOpen(c.id)} className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left max-md:min-h-11">
              <Icon className="size-3.5 shrink-0 text-t3" aria-label={SURFACE_LABEL[c.surface]} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-t1 max-md:text-[15px]">{c.title}</span>
                <span className="flex items-center gap-1.5 text-[11px] text-t3">
                  {c.subjectType && <span className="rounded bg-wl px-1 py-px">{c.subjectType === 'workflow' ? 'Workflow' : c.subjectType}</span>}
                  <span>{timeAgo(c.updatedAt)}</span>
                </span>
              </span>
            </button>
          )}
          <button type="button" aria-label={`More for ${c.title}`} aria-expanded={menu === c.id} onClick={() => setMenu(menu === c.id ? undefined : c.id)} className={cn(CHAT_ICON_BUTTON, 'mr-1')}>
            <Ellipsis className="size-4" />
          </button>
        </div>
        {menu === c.id && (
          <div className="flex gap-1 px-2 pb-1.5 text-[12px]">
            <button type="button" onClick={() => { setMenu(undefined); setEditing(c.id); }} className="rounded-md px-2 py-1 text-t2 hover:bg-acdim hover:text-t1 max-md:min-h-11">
              Rename
            </button>
            <button type="button" onClick={() => void remove(c)} className="rounded-md px-2 py-1 text-rd hover:bg-acdim max-md:min-h-11">
              Delete
            </button>
          </div>
        )}
      </li>
    );
  };

  const group = (label: string | undefined, rows: ConversationRecord[]) =>
    rows.length > 0 && (
      <section aria-label={label ?? 'Everywhere'}>
        {label && <h3 className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-t3">{label}</h3>}
        <ul>{rows.map(row)}</ul>
      </section>
    );

  return (
    <div className="flex max-h-[70dvh] flex-col gap-1 p-2 text-[13px]">
      <div className="flex items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder="Search conversations" label="Search conversations" className="min-w-0 flex-1" />
        <button type="button" onClick={onNew} className="shrink-0 rounded-md px-2 py-1 text-t2 hover:bg-acdim hover:text-t1 max-md:min-h-11">
          New conversation
        </button>
      </div>
      {!keeping && (
        <p className="rounded-lg bg-wl px-2 py-1.5 text-[12px] text-t2">
          Your conversations aren't being kept.{' '}
          <button type="button" onClick={() => void setPreference('keepConversations', true).catch(() => {})} className="text-ac2 underline">
            Turn it on
          </button>
        </p>
      )}
      <div className="min-h-0 overflow-y-auto">
        {failed && <p className="px-2 py-3 text-t3">Couldn't load your conversations.</p>}
        {problem && <p role="alert" className="px-2 py-1.5 text-rd">{problem}</p>}
        {!failed && loaded && hereList.length === 0 && elsewhere.length === 0 && <p className="px-2 py-3 text-t3">{query.trim() ? 'No matching conversations' : 'No earlier conversations'}</p>}
        {group(hereLabel, hereList)}
        {group(hereList.length ? 'Everywhere' : undefined, elsewhere)}
        {here?.next && (
          <button type="button" onClick={() => void load(query, 'here', here.next!)} className="w-full rounded-md px-2 py-1.5 text-t2 hover:bg-acdim max-md:min-h-11">
            Show more of {hereLabel.toLowerCase()}
          </button>
        )}
        {everywhere?.next && (
          <button type="button" onClick={() => void load(query, 'everywhere', everywhere.next!)} className="w-full rounded-md px-2 py-1.5 text-t2 hover:bg-acdim max-md:min-h-11">
            Show more
          </button>
        )}
      </div>
    </div>
  );
}
