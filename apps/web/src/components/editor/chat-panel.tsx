'use client';
import { useEffect, useRef, useState } from 'react';
import { Ban, Bot, Check, ChevronRight, FileText, Loader2, Paperclip, ShieldAlert, SquarePen, Wrench, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { ExecutionEvent } from '@/lib/shared/types';
import { Button } from '../ui/button';
import { AssistantRow, CHAT_ICON_BUTTON, ChatComposer, ChatEmpty, ChatError, ChatMarkdown, UserBubble, Working } from '../ui/chat';
import { NodeIcon } from '../ui/icon';
import { useEditor } from './store';

/** What AI Agent and chain nodes stream while the run goes on (node.chunk events of the run route SSE). */
export type ChatChunk = Extract<ExecutionEvent, { type: 'node.chunk' }>['chunk'];

/** A tool call the agent made, as streamed: running, done, failed, or waiting for a person. */
export interface ChatTool {
  id: string;
  name: string;
  status: 'started' | 'finished' | 'failed' | 'approval';
  input?: unknown;
  output?: string;
}

/** `result.approval` of a run waiting for tool approvals (AI Agent → Require Approval). */
export interface ChatApproval {
  nodeName: string;
  channel: 'chat' | 'slack';
  calls: Array<{ id: string; tool: string; input?: unknown }>;
  decisions?: Record<string, { approved: boolean; by?: string }>;
  /** An Ask a Person node's request: the heading and the draft instead of a tool call. */
  confirm?: { title: string; text: string };
}

/** A file attached in the panel, sent base64 with the message (the trigger item's binary data0, data1…). */
export interface ChatFile {
  fileName: string;
  mimeType: string;
  data: string;
  size: number;
}

/** What a send or a decision ends with: the reply when nothing streamed, the approval the run now waits for. */
export interface ChatOutcome {
  reply?: string;
  executionId?: string;
  approval?: ChatApproval;
  /** A decision on one call of several: the run goes on once every call has one. */
  stillWaiting?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  tools?: Array<{ nodeId: string; name: string; ok: boolean }>;
  /** Streamed tool calls (with input and output). */
  calls?: ChatTool[];
  files?: Array<{ fileName: string; mimeType: string; size: number }>;
  approval?: ChatApproval & { executionId: string; decided: Record<string, boolean | 'busy'> };
}

const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const pretty = (value: unknown) => {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
};

/** Fold one streamed chunk into the reply being built. */
function applyChunk(current: { text: string; calls: ChatTool[]; error?: string }, chunk: ChatChunk) {
  if (chunk.type === 'item' && chunk.content) return { ...current, text: current.text + chunk.content };
  if (chunk.type === 'error') return { ...current, error: chunk.content ?? 'The model stream failed' };
  if (chunk.type === 'tool' && chunk.tool) {
    const tool = chunk.tool;
    const known = current.calls.find((c) => c.id === tool.id);
    const next: ChatTool = { ...known, id: tool.id, name: tool.name, status: tool.status, ...(tool.input !== undefined && { input: tool.input }), ...(tool.output !== undefined && { output: tool.output }) };
    return { ...current, calls: known ? current.calls.map((c) => (c.id === tool.id ? next : c)) : [...current.calls, next] };
  }
  return current;
}

const EMPTY_REPLY = { text: '', calls: [] as ChatTool[] };

export function ChatPanel({
  open,
  onClose,
  onSend,
  onDecide,
}: {
  open: boolean;
  onClose: () => void;
  onSend: (message: string, sessionId: string, files: ChatFile[], onChunk: (chunk: ChatChunk) => void) => Promise<ChatOutcome>;
  onDecide?: (executionId: string, callId: string, approved: boolean, onChunk: (chunk: ChatChunk) => void) => Promise<ChatOutcome>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [sessionId, setSessionId] = useState(() => `chat_${nanoid(6)}`);
  const [pending, setPending] = useState(false);
  const [live, setLive] = useState<{ text: string; calls: ChatTool[]; error?: string }>(EMPTY_REPLY);
  const log = useEditor((s) => s.log);
  const nodes = useEditor((s) => s.nodes);
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const runStart = useRef(0);
  const reply = useRef(EMPTY_REPLY as { text: string; calls: ChatTool[]; error?: string });

  // Follow the reply only when you are at the end (reading further up stays put), or just sent something.
  const atEnd = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && (atEnd.current || messages.at(-1)?.role === 'user')) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, log.length, live]);

  // Live tool activity of the current run (sub-node calls on the canvas), when the agent streams nothing itself.
  const activity = pending ? log.slice(runStart.current).filter((l) => l.kind !== 'log' && (l.source === 'tool' || l.source === 'model')) : [];
  const liveTools = activity.filter((l) => l.source === 'tool' && l.kind !== 'start');
  const thinking = activity.length > 0 && activity[activity.length - 1].kind === 'start';

  const onChunk = (chunk: ChatChunk) => {
    reply.current = applyChunk(reply.current, chunk);
    setLive(reply.current);
  };

  /** Run `work` (a send or a decision) with the reply streaming in, then add the assistant's message. */
  const converse = async (work: () => Promise<ChatOutcome>) => {
    setPending(true);
    reply.current = EMPTY_REPLY;
    setLive(EMPTY_REPLY);
    runStart.current = useEditor.getState().log.length;
    try {
      const outcome = await work();
      if (outcome.stillWaiting) return;
      const streamed = reply.current;
      const tools = useEditor
        .getState()
        .log.slice(runStart.current)
        .filter((l) => l.source === 'tool' && (l.kind === 'finish' || l.kind === 'error'))
        .map((l) => ({ nodeId: l.nodeId!, name: l.nodeName ?? 'tool', ok: l.kind === 'finish' }));
      const text = streamed.text.trim() ? streamed.text : outcome.approval ? '' : outcome.reply;
      const approval =
        outcome.approval && outcome.executionId ? { ...outcome.approval, executionId: outcome.executionId, decided: Object.fromEntries(Object.entries(outcome.approval.decisions ?? {}).map(([id, d]) => [id, d.approved])) } : undefined;
      setMessages((m) => [
        ...m,
        {
          id: nanoid(),
          role: text === undefined && !approval ? 'error' : 'assistant',
          text: text ?? (approval ? '' : 'The workflow did not produce a reply — check the execution log.'),
          // Streamed calls carry their input and output; otherwise the tool nodes that ran.
          ...(streamed.calls.length ? { calls: streamed.calls } : { tools }),
          ...(approval && { approval }),
        },
      ]);
      if (streamed.error) setMessages((m) => [...m, { id: nanoid(), role: 'error', text: streamed.error! }]);
    } catch (error) {
      // What streamed before the failure stays visible.
      const streamed = reply.current;
      if (streamed.text.trim() || streamed.calls.length) setMessages((m) => [...m, { id: nanoid(), role: 'assistant', text: streamed.text, calls: streamed.calls }]);
      setMessages((m) => [...m, { id: nanoid(), role: 'error', text: (error as Error).message }]);
    } finally {
      reply.current = EMPTY_REPLY;
      setLive(EMPTY_REPLY);
      setPending(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || pending) return;
    const attached = files;
    setDraft('');
    setFiles([]);
    setMessages((m) => [...m, { id: nanoid(), role: 'user', text, ...(attached.length && { files: attached.map(({ fileName, mimeType, size: bytes }) => ({ fileName, mimeType, size: bytes })) }) }]);
    await converse(() => onSend(text, sessionId, attached, onChunk));
  };

  /** Try again: the message before an error, sent again in the same session. */
  const retry = (errorId: string) => {
    const at = messages.findIndex((m) => m.id === errorId);
    const asked = messages.slice(0, at).findLast((m) => m.role === 'user');
    if (!asked || pending) return;
    setMessages((m) => m.filter((msg) => msg.id !== errorId));
    void converse(() => onSend(asked.text, sessionId, [], onChunk));
  };

  const decide = async (messageId: string, executionId: string, callId: string, approved: boolean) => {
    if (!onDecide || pending) return;
    const mark = (value: boolean | 'busy' | undefined) =>
      setMessages((m) =>
        m.map((msg) => {
          if (msg.id !== messageId || !msg.approval) return msg;
          const decided = { ...msg.approval.decided };
          if (value === undefined) delete decided[callId];
          else decided[callId] = value;
          return { ...msg, approval: { ...msg.approval, decided } };
        }),
      );
    mark('busy');
    let failed = false;
    await converse(async () => {
      try {
        const outcome = await onDecide(executionId, callId, approved, onChunk);
        mark(approved);
        return outcome;
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    if (failed) mark(undefined);
  };

  const attach = async (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    if (fileInput.current) fileInput.current.value = '';
    if (!picked.length) return;
    if (files.length + picked.length > MAX_FILES) return void toast.error(`At most ${MAX_FILES} files per message`);
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) return void toast.error(`${tooBig.name} is larger than 20 MB`);
    try {
      const read = await Promise.all(picked.map(async (f) => ({ fileName: f.name, mimeType: f.type || 'application/octet-stream', size: f.size, data: await readBase64(f) })));
      setFiles((current) => [...current, ...read].slice(0, MAX_FILES));
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const iconOf = (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    return node ? nodeTypes[node.data.wf.type]?.descriptor.icon : undefined;
  };

  if (!open) return null;
  return (
    <aside className="z-30 flex w-[380px] shrink-0 animate-panel flex-col border-l border-hair bg-sf max-md:h-[52dvh] max-md:w-full max-md:rounded-t-2xl max-md:border-l-0 max-md:border-t">
      <div className="relative flex h-11 shrink-0 items-center gap-1.5 border-b border-hair pl-3 pr-1.5">
        <span className="absolute left-1/2 top-1 block h-1 w-8 -translate-x-1/2 rounded-full bg-hair md:hidden" aria-hidden />
        <Bot className="size-3.5 shrink-0 text-viz-7" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-t1">Chat</span>
        <button
          title={`New conversation (this one is ${sessionId})`}
          aria-label="New conversation"
          onClick={() => {
            setMessages([]);
            setSessionId(`chat_${nanoid(6)}`);
          }}
          className={CHAT_ICON_BUTTON}
        >
          <SquarePen className="size-3.5" />
        </button>
        <button onClick={onClose} aria-label="Close chat" title="Close chat" className={CHAT_ICON_BUTTON}>
          <X className="size-4" />
        </button>
      </div>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
      >
        {messages.length === 0 && (
          <ChatEmpty
            className="mt-8"
            mark={
              <span className="grid size-10 place-items-center rounded-full border border-hair bg-wl text-viz-7">
                <Bot className="size-4" />
              </span>
            }
            title="Talk to your workflow"
            help="Messages enter through the Chat Message trigger. Replies stream in as the agent writes them; tool calls show up live."
          />
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="space-y-1.5">
              {m.files && m.files.length > 0 && <FileChips files={m.files} />}
              <UserBubble>{m.text}</UserBubble>
            </div>
          ) : m.role === 'error' ? (
            <div key={m.id} className="pl-7">
              <ChatError message={m.text} onRetry={pending ? undefined : () => retry(m.id)} />
            </div>
          ) : (
            <AssistantRow key={m.id} mark={<Bot className="size-3.5" />}>
              {m.tools && m.tools.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {m.tools.map((t, i) => (
                    <span key={i} className={cn('flex items-center gap-1 rounded-full border px-2 py-px text-[11px]', t.ok ? 'border-hair text-t2' : 'border-rdbd bg-rddim text-rd')}>
                      <NodeIcon icon={iconOf(t.nodeId)} size={11} /> {t.name}
                    </span>
                  ))}
                </div>
              )}
              {m.calls && m.calls.length > 0 && <ToolCalls calls={m.calls} />}
              {m.text ? <ChatMarkdown text={m.text} /> : null}
              {m.approval && <ApprovalCard approval={m.approval} disabled={pending || !onDecide} onDecide={(callId, approved) => void decide(m.id, m.approval!.executionId, callId, approved)} />}
            </AssistantRow>
          ),
        )}
        {pending && (
          <AssistantRow mark={<Bot className="size-3.5" />}>
            {live.calls.length > 0 && <ToolCalls calls={live.calls} />}
            {live.text ? <ChatMarkdown text={live.text} /> : <Working label={thinking || !(liveTools.length || live.calls.length) ? 'Thinking…' : 'Using tools…'} />}
            {!live.calls.length && liveTools.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {liveTools.map((t) => (
                  <span key={t.id} className="flex animate-in items-center gap-1 rounded-full border border-hair px-2 py-px text-[11px] text-t2">
                    <Wrench className="size-2.5" /> {t.nodeName}
                  </span>
                ))}
              </div>
            )}
          </AssistantRow>
        )}
      </div>

      <div className="shrink-0 border-t border-hair p-2.5 max-md:pb-[max(10px,env(safe-area-inset-bottom))]">
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => void attach(e.target.files)} />
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          busy={pending}
          placeholder="Message the agent"
          label="Message the agent"
          top={
            files.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-1">
                {files.map((f, i) => (
                  <span key={`${f.fileName}-${i}`} className="flex max-w-[170px] items-center gap-1 rounded-full border border-hair bg-sf py-px pl-2 pr-1 text-[11px] text-t2">
                    <FileText className="size-3 shrink-0" />
                    <span className="truncate">{f.fileName}</span>
                    <span className="shrink-0 text-t3">{size(f.size)}</span>
                    <button aria-label={`Remove ${f.fileName}`} onClick={() => setFiles((list) => list.filter((_, j) => j !== i))} className="grid size-4 shrink-0 place-items-center rounded-full text-t3 hover:text-t1 max-md:size-9">
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )
          }
          before={
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={pending || files.length >= MAX_FILES}
              title="Attach files (images, PDFs, text — the AI Agent sends them with “Include Binary as Input”)"
              aria-label="Attach files"
              className="mb-[2px] grid size-8 shrink-0 place-items-center rounded-full text-t3 transition-colors hover:bg-acdim hover:text-t1 disabled:opacity-40 max-md:size-11"
            >
              <Paperclip className="size-3.5" />
            </button>
          }
        />
      </div>
    </aside>
  );
}

const STATUS: Record<ChatTool['status'], { label: string; tone: string }> = {
  started: { label: 'Running', tone: 'text-t3' },
  finished: { label: 'Done', tone: 'text-gn' },
  failed: { label: 'Failed', tone: 'text-rd' },
  approval: { label: 'Needs you', tone: 'text-warn' },
};

/** Streamed tool calls: name and status, input and output on demand. */
function ToolCalls({ calls }: { calls: ChatTool[] }) {
  return (
    <div className="space-y-1">
      {calls.map((call) => (
        <details key={call.id} className="group animate-in rounded-[8px] border border-hair bg-wl text-[11px]">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-t2 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 shrink-0 text-t3 transition-transform group-open:rotate-90" />
            {call.status === 'started' ? <Loader2 className="size-3 shrink-0 animate-spin text-t3" /> : <Wrench className="size-3 shrink-0 text-t3" />}
            <span className="truncate font-medium text-t1">{call.name}</span>
            <span className={cn('ml-auto shrink-0', STATUS[call.status].tone)}>{STATUS[call.status].label}</span>
          </summary>
          <div className="space-y-1 border-t border-hair px-2 py-1.5">
            {call.input !== undefined && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-t3">Input</div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] text-t2">{pretty(call.input)}</pre>
              </div>
            )}
            {call.output !== undefined && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-t3">Output</div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] text-t2">{pretty(call.output)}</pre>
              </div>
            )}
            {call.input === undefined && call.output === undefined && <div className="text-t3">No details yet</div>}
          </div>
        </details>
      ))}
    </div>
  );
}

function FileChips({ files }: { files: Array<{ fileName: string; mimeType: string; size: number }> }) {
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {files.map((f, i) => (
        <span key={i} title={f.mimeType} className="flex max-w-[200px] items-center gap-1 rounded-full border border-hair bg-wl px-2 py-px text-[11px] text-t2">
          <FileText className="size-3 shrink-0" />
          <span className="truncate">{f.fileName}</span>
          <span className="shrink-0 text-t3">{size(f.size)}</span>
        </span>
      ))}
    </div>
  );
}

/** Approve / Reject per waiting tool call (chat channel); Slack approvals are decided in Slack. */
function ApprovalCard({ approval, disabled, onDecide }: { approval: NonNullable<ChatMessage['approval']>; disabled: boolean; onDecide: (callId: string, approved: boolean) => void }) {
  return (
    <div className="space-y-1.5 rounded-xl border border-warnbd bg-warndim px-3 py-2 text-[12px] text-t1">
      <div className="flex items-center gap-1.5 font-medium">
        <ShieldAlert className="size-3.5 text-warn" />
        {approval.confirm ? `Needs you · ${approval.confirm.title}` : `${approval.nodeName} wants to run ${approval.calls.length === 1 ? 'a tool' : `${approval.calls.length} tools`}`}
      </div>
      {approval.channel === 'slack' && <div className="text-t2">Waiting for an approval in Slack — the run continues once someone decides there.</div>}
      {approval.calls.map((call) => {
        const decided = approval.decided[call.id];
        return (
          <div key={call.id} className="rounded-[8px] border border-hair bg-wl px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <Wrench className="size-3 text-t3" />
              <span className="font-medium">{approval.confirm ? approval.nodeName : call.tool}</span>
              {decided === true && <span className="ml-auto flex items-center gap-0.5 text-gn"><Check className="size-3" /> Approved</span>}
              {decided === false && <span className="ml-auto flex items-center gap-0.5 text-rd"><X className="size-3" /> {approval.confirm ? 'Rejected' : 'Denied'}</span>}
              {decided === 'busy' && <Loader2 className="ml-auto size-3 animate-spin text-t3" />}
            </div>
            {call.input !== undefined && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] text-t2">{approval.confirm ? approval.confirm.text : pretty(call.input)}</pre>}
            {approval.channel === 'chat' && decided === undefined && (
              <div className="mt-1.5 flex gap-1.5">
                <Button size="sm" variant="primary" className="max-md:min-h-11" disabled={disabled} onClick={() => onDecide(call.id, true)}>
                  <Check className="size-3.5" /> Approve
                </Button>
                <Button size="sm" variant="outline" className="max-md:min-h-11" disabled={disabled} onClick={() => onDecide(call.id, false)}>
                  {approval.confirm ? <X className="size-3.5" /> : <Ban className="size-3.5" />} {approval.confirm ? 'Reject' : 'Deny'}
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
