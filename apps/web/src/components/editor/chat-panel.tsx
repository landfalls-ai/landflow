'use client';
import { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, RotateCcw, SendHorizontal, User, Wrench, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { cn } from '@/lib/utils';
import { NodeIcon } from '../ui/icon';
import { useEditor } from './store';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  tools?: Array<{ nodeId: string; name: string; ok: boolean }>;
}

export function ChatPanel({ open, onClose, onSend }: { open: boolean; onClose: () => void; onSend: (message: string, sessionId: string) => Promise<string | undefined> }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sessionId, setSessionId] = useState(() => `chat_${nanoid(6)}`);
  const [pending, setPending] = useState(false);
  const log = useEditor((s) => s.log);
  const nodes = useEditor((s) => s.nodes);
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const scroller = useRef<HTMLDivElement>(null);
  const runStart = useRef(0);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages, log.length]);

  // Live tool activity of the current run.
  const activity = pending ? log.slice(runStart.current).filter((l) => l.kind !== 'log' && (l.source === 'tool' || l.source === 'model')) : [];
  const liveTools = activity.filter((l) => l.source === 'tool' && l.kind !== 'start');
  const thinking = activity.length > 0 && activity[activity.length - 1].kind === 'start';

  const send = async () => {
    const text = draft.trim();
    if (!text || pending) return;
    setDraft('');
    setMessages((m) => [...m, { id: nanoid(), role: 'user', text }]);
    setPending(true);
    runStart.current = useEditor.getState().log.length;
    try {
      const reply = await onSend(text, sessionId);
      const tools = useEditor
        .getState()
        .log.slice(runStart.current)
        .filter((l) => l.source === 'tool' && (l.kind === 'finish' || l.kind === 'error'))
        .map((l) => ({ nodeId: l.nodeId!, name: l.nodeName ?? 'tool', ok: l.kind === 'finish' }));
      setMessages((m) => [...m, { id: nanoid(), role: reply === undefined ? 'error' : 'assistant', text: reply ?? 'The workflow did not produce a reply — check the execution log.', tools }]);
    } catch (error) {
      setMessages((m) => [...m, { id: nanoid(), role: 'error', text: (error as Error).message }]);
    } finally {
      setPending(false);
    }
  };

  const iconOf = (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    return node ? nodeTypes[node.data.wf.type]?.descriptor.icon : undefined;
  };

  if (!open) return null;
  return (
    <aside className="z-30 flex w-[380px] shrink-0 animate-panel flex-col border-l border-hair bg-sf">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hair px-3">
        <span className="text-[13px] font-semibold text-t1">Chat</span>
        <span className="font-mono text-[11px] text-t3">{sessionId}</span>
        <button title="New session" aria-label="New session" onClick={() => { setMessages([]); setSessionId(`chat_${nanoid(6)}`); }} className="ml-auto grid size-7 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
          <RotateCcw className="size-3.5" />
        </button>
        <button onClick={onClose} aria-label="Close chat" className="grid size-7 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
          <X className="size-4" />
        </button>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="mt-8 text-center">
            <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full border border-acbd bg-acdim">
              <Bot className="size-5 text-ac" strokeWidth={1.6} />
            </div>
            <div className="text-[15px] font-semibold text-t1">Talk to your workflow</div>
            <div className="mx-auto mt-1 max-w-[260px] text-[13px] text-t2">Messages enter through the Chat Message trigger. Tool nodes light up on the canvas as the agent works.</div>
            <div className="mt-5 space-y-1.5">
              {['Hash the word "landflow" with sha256', 'What is the sentiment of "I love polyglot plugins"?', 'Slugify "Hello Plugin World" and compute 42 * 17'].map((s) => (
                <button key={s} onClick={() => setDraft(s)} className="block w-full rounded-[10px] border border-hair bg-wl px-3 py-2 text-left text-[12px] text-t2 transition-colors hover:border-acbd hover:text-t1">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={cn('flex animate-in gap-2.5', m.role === 'user' && 'flex-row-reverse')}>
            <div className={cn('grid size-[26px] shrink-0 place-items-center rounded-full border', m.role === 'user' ? 'border-hair bg-wl text-t2' : m.role === 'error' ? 'border-rdbd bg-rddim text-rd' : 'border-acbd bg-acdim text-ac')}>
              {m.role === 'user' ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
            </div>
            <div className="max-w-[290px] space-y-1.5">
              {m.tools && m.tools.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {m.tools.map((t, i) => (
                    <span key={i} className={cn('flex items-center gap-1 rounded-full border px-2 py-px text-[11px]', t.ok ? 'border-hair text-t2' : 'border-rdbd bg-rddim text-rd')}>
                      <NodeIcon icon={iconOf(t.nodeId)} size={11} /> {t.name}
                    </span>
                  ))}
                </div>
              )}
              <div className={cn('whitespace-pre-wrap [overflow-wrap:anywhere] rounded-xl px-3 py-2 text-[13px] leading-relaxed', m.role === 'user' ? 'bg-ac2 text-on-ac' : m.role === 'error' ? 'border border-rdbd bg-rddim text-rd' : 'border border-hair bg-wl text-t1')}>
                {m.text}
              </div>
            </div>
          </div>
        ))}
        {pending && (
          <div className="flex gap-2.5">
            <div className="grid size-[26px] shrink-0 place-items-center rounded-full border border-acbd bg-acdim text-ac">
              <Loader2 className="size-3.5 animate-spin" />
            </div>
            <div className="space-y-1.5">
              <div className="animate-pulse-soft text-[13px] text-t2">{thinking ? 'Thinking…' : liveTools.length ? 'Using tools…' : 'Working…'}</div>
              <div className="flex flex-wrap gap-1">
                {liveTools.map((t) => (
                  <span key={t.id} className="flex animate-in items-center gap-1 rounded-full border border-hair px-2 py-px text-[11px] text-t2">
                    <Wrench className="size-2.5" /> {t.nodeName}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-hair p-3">
        <div className="flex items-end gap-2 rounded-[10px] border border-hair bg-wl p-1.5 focus-within:border-ac">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Message the agent…"
            aria-label="Message"
            className="max-h-32 min-h-[32px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] text-t1 outline-none placeholder:text-t3"
          />
          <button onClick={() => void send()} disabled={!draft.trim() || pending} aria-label="Send" className="grid size-8 place-items-center rounded-full bg-ac2 text-on-ac transition-colors hover:bg-ac2-hover disabled:opacity-40">
            <SendHorizontal className="size-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
