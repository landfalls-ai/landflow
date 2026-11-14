'use client';
/**
 * The Agent architect (docs/agents.md#agent-architect): a chat with a specialist that designs an agent from the plugins
 * this instance has. The chat is on the left; the draft it proposes stays on the right, whole, until the user creates it.
 */
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, Bot, Check, ChevronLeft, Plug, RadioTower, SquarePen, TriangleAlert, Workflow, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, streamEvents } from '@/lib/client/api';
import { useConversation } from '@/lib/client/conversations';
import type { ActivityStep } from '@/lib/shared/activity';
import type { ConversationItem, ConversationItemInput, ConversationPart } from '@/lib/shared/conversations';
import { nodeColor, tint } from '@/lib/client/node-style';
import { cn } from '@/lib/utils';
import type { AgentConfig, AgentToolConfig } from '@/lib/shared/agents';
import { ARCHITECT, type ArchitectMissing, type ArchitectNeed, type ArchitectRequest, type ArchitectTurn } from '@/lib/shared/agent-architect';
import { randomFace } from '@/lib/shared/faces';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { Chip } from '../ui/badge';
import { Button } from '../ui/button';
import { ActivityTrace } from '../ui/activity-trace';
import { AssistantRow, CHAT_ICON_BUTTON, ChatComposer, ChatEmpty, ChatError, ChatMarkdown, ModelChip, ReplyMeta, UserBubble, Working, type ReplyInfo } from '../ui/chat';
import { ChatList } from '../ui/chat-motion';
import { ConversationHistory } from '../ui/conversation-history';
import { NodeIcon } from '../ui/icon';
import { Input } from '../ui/inputs';
import { AgentAvatar } from './avatar';
import { AGENT_COLORS, AvatarDialog, type AvatarChoice } from './avatar-dialog';
import { Dialog, Field } from './dialog';
import { useAgentList, useNodeTypes } from './use-agent-data';

const STARTERS = [
  'Answer customer questions from our docs and open a Jira ticket when it can’t',
  'Triage Grafana alerts and post a summary to Slack',
  'Every Monday, report last week’s numbers from a Postgres table',
  'Review new pull requests and leave a first round of comments',
];

export interface Draft {
  id: string;
  summary: string;
  config: Partial<AgentConfig>;
  needs: ArchitectNeed[];
  dropped: string[];
  missing: ArchitectMissing[];
}

/** What the stream says when a reply fails: the kind of failure, and (after some steps) the checkpoint that continues it. */
interface FailedReply {
  message: string;
  kind?: string;
  checkpoint?: string;
  /** The step that failed: "Continue from step N". */
  step?: number;
}

export interface Message {
  role: 'user' | 'assistant';
  text: string;
  /** What the architect did: the tools it used, in order. */
  steps: ActivityStep[];
  /** The summary of the draft this reply proposed. */
  proposed?: string;
  /** The model, time, steps, tokens and cost of the finished reply. */
  info?: ReplyInfo;
  error?: FailedReply;
  /** What the architect is doing now (the step that began), for the live line. */
  stepLabel?: string;
  /** From a conversation kept earlier: shown under the "Earlier" divider. */
  earlier?: boolean;
}

/** The architect's conversation is kept under this scope (a design is about an agent that does not exist yet). */
const SCOPE = { surface: 'architect', subjectType: 'agent', subjectId: 'new' } as const;

const architectAvatar = { name: ARCHITECT.name, color: ARCHITECT.color, avatar: { kind: 'face', face: ARCHITECT.face } } as const;

/** What the server hears of the conversation: the user's words, and each reply's prose plus a note of any draft it made. */
function history(messages: Message[]): ArchitectTurn[] {
  const turns: ArchitectTurn[] = [];
  for (const m of messages) {
    const content = m.role === 'user' ? m.text : [m.text.trim(), m.proposed ? `[Proposed draft “${m.proposed}”]` : ''].filter(Boolean).join('\n');
    if (content) turns.push({ role: m.role, content });
  }
  return turns;
}

/** The body of POST /api/assistant/agent: the conversation, the draft so far, and `resume` to continue a failed reply from its checkpoint. */
export type ArchitectBody = ArchitectRequest & { resume?: { checkpoint: string } };
export function architectBody(messages: Message[], draft?: Partial<AgentConfig>, resume?: { checkpoint: string }): ArchitectBody {
  return { messages: history(messages), ...(draft && { draft }), ...(resume && { resume }) };
}

/** The conversation item a finished reply is kept as: its words, steps, the draft it proposed, a failure, and what it cost. */
export function replyItem(m: Message, draft?: Draft): ConversationItemInput {
  const parts: ConversationPart[] = [];
  if (m.text.trim()) parts.push({ type: 'text', text: m.text });
  if (m.steps.length) parts.push({ type: 'steps', steps: m.steps.map((s) => ({ id: s.id, label: s.label, kind: s.kind, status: s.status, ...(s.durationMs !== undefined && { durationMs: s.durationMs }) })) });
  if (m.proposed && draft) parts.push({ type: 'proposal', id: draft.id, summary: m.proposed, ops: [draft], state: 'pending' });
  if (m.error) parts.push({ type: 'error', message: m.error.message, ...(m.error.kind && { kind: m.error.kind }) });
  if (!parts.length) parts.push({ type: 'text', text: '' });
  const i = m.info;
  return {
    role: 'assistant',
    parts,
    ...(i && { meta: { ...(i.model && { model: i.model }), ...(i.durationMs !== undefined && { durationMs: i.durationMs }), ...(i.steps !== undefined && { steps: i.steps }), ...(i.inputTokens !== undefined && { inputTokens: i.inputTokens }), ...(i.outputTokens !== undefined && { outputTokens: i.outputTokens }), ...(i.costUsd !== undefined && { costUsd: i.costUsd }), ...(i.local && { local: true }) } }),
  };
}

/** A kept conversation as chat messages (under "Earlier"), and the last draft it proposed. */
export function restore(items: ConversationItem[]): { messages: Message[]; draft?: Draft } {
  let draft: Draft | undefined;
  const messages = items.map((item): Message => {
    const text = item.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n');
    if (item.role === 'user') return { role: 'user', text, steps: [], earlier: true };
    const steps = item.parts.flatMap((p) => (p.type === 'steps' ? p.steps : [])).map((s): ActivityStep => ({ id: s.id, label: s.label, kind: (s.kind as ActivityStep['kind']) || 'tool', status: s.status === 'failed' ? 'failed' : 'ok', ...(s.durationMs !== undefined && { durationMs: s.durationMs }) }));
    const proposal = item.parts.find((p) => p.type === 'proposal');
    if (proposal?.type === 'proposal') {
      const kept = proposal.ops[0] as Partial<Draft> | undefined;
      if (kept && typeof kept === 'object' && kept.config) draft = { id: proposal.id, summary: proposal.summary, config: kept.config, needs: kept.needs ?? [], dropped: kept.dropped ?? [], missing: kept.missing ?? [] };
    }
    const failure = item.parts.find((p) => p.type === 'error');
    const meta = item.meta;
    return {
      role: 'assistant',
      text,
      steps,
      earlier: true,
      ...(proposal?.type === 'proposal' && { proposed: proposal.summary }),
      // A kept failure cannot be continued (its checkpoint was in memory): Try again is all it offers.
      ...(failure?.type === 'error' && { error: { message: failure.message, ...(failure.kind && { kind: failure.kind }) } }),
      ...(meta && { info: { model: meta.model, durationMs: meta.durationMs, steps: meta.steps, inputTokens: meta.inputTokens, outputTokens: meta.outputTokens, costUsd: meta.costUsd, local: meta.local } }),
    };
  });
  return { messages, ...(draft && { draft }) };
}

function ToolTile({ info, size = 32 }: { info?: NodeTypeInfo; size?: number }) {
  const color = nodeColor(info);
  return (
    <span className="grid shrink-0 place-items-center rounded-[10px] border border-hair" style={{ width: size, height: size, background: tint(color, 12) }}>
      <NodeIcon icon={info?.descriptor.icon ?? 'wrench'} size={Math.round(size * 0.45)} style={{ color }} />
    </span>
  );
}

function KindTile({ icon }: { icon: React.ReactNode }) {
  return <span className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-hair bg-sf text-t2">{icon}</span>;
}

function List({ title, items, tone }: { title: string; items: string[]; tone: 'ok' | 'no' }) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{title}</h4>
      <ul className="space-y-1">
        {items.map((r, i) => (
          <li key={i} className="flex gap-1.5 text-[12px] leading-snug text-t2">
            {tone === 'ok' ? <Check className="mt-0.5 size-3 shrink-0 text-gn" /> : <X className="mt-0.5 size-3 shrink-0 text-rd" />}
            <span>{r}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ToolRow({ tool }: { tool: AgentToolConfig }) {
  const nodeTypes = useNodeTypes();
  const agents = useAgentList();
  let icon: React.ReactNode;
  let title = tool.type === 'agent' ? 'Sub-agent' : tool.name;
  let subtitle: string;
  if (tool.type === 'node') {
    const info = nodeTypes?.[tool.nodeType];
    icon = <ToolTile info={info} />;
    subtitle = info ? `${info.descriptor.displayName} · ${info.pluginId === 'core' ? 'Core' : info.pluginName}` : `${tool.nodeType} · plugin offline`;
  } else if (tool.type === 'workflow') {
    icon = <KindTile icon={<Workflow className="size-3.5" />} />;
    subtitle = `Workflow · ${tool.description || 'No description'}`;
  } else if (tool.type === 'mcp') {
    icon = <KindTile icon={<Plug className="size-3.5" />} />;
    subtitle = `MCP server · ${String(tool.parameters.endpointUrl ?? '') || 'No URL'}`;
  } else if (tool.type === 'a2a') {
    icon = <KindTile icon={<RadioTower className="size-3.5" />} />;
    subtitle = `A2A agent · ${tool.useWhen || String(tool.parameters.agentUrl ?? '') || 'No URL'}`;
  } else if (tool.type === 'knowledge') {
    icon = <KindTile icon={<BookOpen className="size-3.5" />} />;
    subtitle = `Knowledge base · “${tool.collection}”`;
  } else {
    const agent = agents?.find((a) => a.id === tool.agentId);
    icon = <AgentAvatar agent={agent ?? {}} size={32} />;
    title = agent?.name ?? 'Sub-agent';
    subtitle = `Sub-agent · ${tool.useWhen || agent?.description || 'No description'}`;
  }
  return (
    <li className="flex items-center gap-2.5 rounded-xl border border-hair bg-wl px-2.5 py-2">
      {icon}
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold text-t1">{title}</span>
        <span className="block truncate text-[12px] text-t3">{subtitle}</span>
      </span>
    </li>
  );
}

function DraftPreview({ draft, seed, fresh, onPick }: { draft: Draft; seed: string; fresh: boolean; onPick: () => void }) {
  const c = draft.config;
  const p = c.persona;
  const [open, setOpen] = useState(false);
  const instructions = c.instructions?.trim();
  const face = useMemo(() => ({ kind: 'face' as const, face: randomFace(seed) }), [seed]);
  return (
    <div className={cn('space-y-4 rounded-2xl border border-hair p-4 ring-2 transition-shadow duration-1000', fresh ? 'ring-ac' : 'ring-transparent')}>
      <header className="flex items-start gap-3">
        <button
          type="button"
          aria-label="Change avatar, icon and colour"
          onClick={onPick}
          className="rounded-[28%] transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ac"
        >
          <AgentAvatar agent={{ name: c.name, icon: c.icon || 'bot', color: c.color || AGENT_COLORS[0], avatar: c.avatar ?? face }} size={56} />
        </button>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[16px] font-semibold text-t1">{c.name || 'Untitled agent'}</h3>
          {p?.role && <div className="text-[12px] font-medium text-t2">{p.role}</div>}
          {c.description && <p className="mt-1 text-[12px] leading-snug text-t2">{c.description}</p>}
        </div>
      </header>
      {p?.tones && p.tones.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {p.tones.map((tone) => (
            <Chip key={tone} className="px-2 text-[11px]">
              {tone}
            </Chip>
          ))}
        </div>
      )}
      {((p?.always?.length ?? 0) > 0 || (p?.never?.length ?? 0) > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {p?.always && p.always.length > 0 && <List title="Always" items={p.always} tone="ok" />}
          {p?.never && p.never.length > 0 && <List title="Never" items={p.never} tone="no" />}
        </div>
      )}
      {instructions && (
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Instructions</h4>
          <p className={cn('whitespace-pre-wrap text-[12px] leading-relaxed text-t2', !open && 'line-clamp-4')}>{instructions}</p>
          {instructions.length > 240 && (
            <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 rounded text-[12px] font-semibold text-ac hover:underline focus-visible:outline-2 focus-visible:outline-ac">
              {open ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
      <div>
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Tools · {c.tools?.length ?? 0}</h4>
        {c.tools && c.tools.length > 0 ? (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {c.tools.map((t) => (
              <ToolRow key={t.id} tool={t} />
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-t3">No tools in this draft.</p>
        )}
      </div>
      {draft.needs.length > 0 && (
        <ul className="space-y-1.5" aria-label="Still to do">
          {draft.needs.map((n, i) => (
            <li key={i} className="flex gap-2 rounded-xl border border-warnbd bg-warndim px-3 py-2 text-[12px] leading-snug text-t1">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
              <span>{n.text}</span>
            </li>
          ))}
        </ul>
      )}
      {draft.missing.length > 0 && (
        <div className="rounded-xl border border-hair bg-sf px-3 py-2 text-[12px] leading-snug text-t2">
          <span className="font-semibold text-t1">No plugin here can:</span> {draft.missing.map((m) => (m.system ? `${m.capability} (${m.system})` : m.capability)).join('; ')}.{' '}
          <span className="text-t3">The second brain will suggest building it in Suggestions on Home.</span>
        </div>
      )}
      {draft.dropped.length > 0 && <p className="text-[12px] text-t3">Left out: {draft.dropped.join('; ')}</p>}
    </div>
  );
}

export function AgentArchitect({ teams, onBack, onClose }: { teams: string[]; onBack?: () => void; onClose: () => void }) {
  const router = useRouter();
  const id = useId();
  const [seed] = useState(() => Math.random().toString(36).slice(2, 10));
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState<Draft>();
  const [fresh, setFresh] = useState(false);
  const [team, setTeam] = useState('');
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  // A phone shows one pane at a time: the chat, or the draft (it switches to the draft when one arrives).
  const [pane, setPane] = useState<'chat' | 'draft'>('chat');
  const box = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // The conversation is kept (when the person keeps conversations): reopening the architect brings the last one back.
  const kept = useConversation(SCOPE);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(false), 1200);
    return () => clearTimeout(t);
  }, [fresh, draft?.id]);

  /** Show a kept conversation: its messages under "Earlier", and the draft it ended with. */
  const show = (items: ConversationItem[]) => {
    const back = restore(items);
    shown.current = true;
    setMessages(back.messages);
    setDraft(back.draft);
    setPane('chat');
  };
  // Opening a kept conversation puts its items in the hook; this shows them once they arrive (a new items array: not the
  // one there was when it was asked for). Resuming the latest never replaces what the person has already started.
  const itemsNow = useRef(kept.items);
  itemsNow.current = kept.items;
  // The person has sent a message in this chat (a late resume must not mix an earlier conversation into it).
  const started = useRef(false);
  const shown = useRef(false);
  const asked = useRef<{ before: ConversationItem[]; force: boolean }>(null);
  const ask = (force: boolean) => {
    asked.current = { before: itemsNow.current, force };
  };
  useEffect(() => {
    const want = asked.current;
    if (!want || kept.items === want.before) return;
    asked.current = null;
    if (want.force || !started.current) show(kept.items);
  }, [kept.items]); // eslint-disable-line react-hooks/exhaustive-deps
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    ask(false);
    void kept
      .resumeLatest()
      .then((found) => {
        if (!found) asked.current = null;
        // The person started a design while it loaded: theirs stays, and later messages go to a new conversation.
        else if (started.current && !shown.current) kept.startNew();
      })
      .catch(() => {
        asked.current = null;
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Change the last (streaming) message. */
  const patch = (fn: (m: Message) => Message) => setMessages((list) => list.map((m, i) => (i === list.length - 1 ? fn(m) : m)));

  /**
   * Ask the architect. `base` is the conversation before the new message; `resume` continues the failed reply `base` ends
   * with from its checkpoint (the same message goes on: its steps stay and the new ones follow).
   */
  const send = async (text: string, base = messages, resume?: { checkpoint: string }) => {
    const content = text.trim();
    if (!content || streaming) return;
    started.current = true;
    const sent = resume ? base : [...base, { role: 'user' as const, text: content, steps: [] }];
    // A continued reply is the failed one, its error cleared.
    const failed = resume ? sent.at(-1) : undefined;
    const asked = resume ? sent.slice(0, -1) : sent;
    const reply: Message = failed && failed.role === 'assistant' ? { ...failed, error: undefined, info: undefined } : { role: 'assistant', text: '', steps: [] };
    const draftBefore = draftRef.current;
    setMessages([...asked, reply]);
    setInput('');
    setStreaming(true);
    const controller = new AbortController();
    abort.current = controller;
    // The reply as it is built, so it can be kept when the stream ends.
    let built = reply;
    let proposal: Draft | undefined;
    const update = (fn: (m: Message) => Message) => {
      built = fn(built);
      patch(fn);
    };
    if (!resume) void kept.append([{ role: 'user', parts: [{ type: 'text', text: content }] }]).catch(() => {});
    try {
      await streamEvents(
        '/api/assistant/agent',
        architectBody(asked, draftBefore?.config, resume),
        (event, data) => {
          const d = data as Record<string, unknown>;
          if (event === 'step.start') update((m) => ({ ...m, stepLabel: String(d.label ?? '') || undefined }));
          else if (event === 'text') update((m) => ({ ...m, text: m.text + String(d.text ?? '') }));
          else if (event === 'tool')
            update((m) => ({
              ...m,
              steps: [
                ...m.steps,
                {
                  id: String(d.id ?? `${d.name}-${m.steps.length}`),
                  label: String(d.label ?? d.name),
                  kind: 'tool',
                  status: d.ok === false ? 'failed' : 'ok',
                  ...(typeof d.durationMs === 'number' && { durationMs: d.durationMs }),
                  ...(typeof d.detail === 'string' && d.detail && { detail: d.detail }),
                },
              ],
            }));
          else if (event === 'draft') {
            const next = d as unknown as Draft;
            proposal = { id: next.id, summary: next.summary, config: next.config ?? {}, needs: next.needs ?? [], dropped: next.dropped ?? [], missing: next.missing ?? [] };
            setDraft(proposal);
            setFresh(true);
            setPane('draft');
            update((m) => ({ ...m, proposed: next.summary }));
          } else if (event === 'done') {
            const usage = (d.usage ?? {}) as { inputTokens?: number; outputTokens?: number };
            update((m) => ({
              ...m,
              info: {
                model: typeof d.model === 'string' ? d.model : undefined,
                durationMs: typeof d.durationMs === 'number' ? d.durationMs : undefined,
                // The tools it used, as the activity line counts them (the model's own step count is a different number).
                steps: m.steps.length || undefined,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                costUsd: typeof d.costUsd === 'number' ? d.costUsd : undefined,
                local: d.local === true,
              },
            }));
          } else if (event === 'error')
            update((m) => ({
              ...m,
              error: {
                message: String(d.message ?? 'Something went wrong'),
                ...(typeof d.kind === 'string' && { kind: d.kind }),
                ...(typeof d.checkpoint === 'string' && { checkpoint: d.checkpoint }),
                ...(typeof d.step === 'number' && { step: d.step }),
              },
            }));
        },
        controller.signal,
      );
    } catch (e) {
      if (!controller.signal.aborted) update((m) => ({ ...m, error: { message: (e as Error).message } }));
    } finally {
      setStreaming(false);
      abort.current = null;
      if (built.text || built.steps.length || built.error) void kept.append([replyItem(built, proposal)]).catch(() => {});
    }
  };

  const lastInfo = messages.findLast((m) => m.info?.model)?.info;

  const choice: AvatarChoice | undefined = draft && {
    avatar: draft.config.avatar ?? { kind: 'face', face: randomFace(seed) },
    icon: draft.config.icon || 'bot',
    color: draft.config.color || AGENT_COLORS[0],
  };

  const create = async () => {
    if (!draft) return;
    setCreating(true);
    try {
      const { agent } = await api<{ agent: { id: string; name: string } }>('/api/agents/import', {
        method: 'POST',
        json: { config: { ...draft.config, avatar: draft.config.avatar ?? { kind: 'face', face: randomFace(seed) }, ...(team.trim() && { team: team.trim() }) } },
      });
      toast.success(draft.needs.length ? `Created “${agent.name}”. Finish ${draft.needs.length === 1 ? 'its open item' : `its ${draft.needs.length} open items`} on the Abilities tab.` : `Created “${agent.name}”`);
      router.push(`/agents/${agent.id}`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
      setCreating(false);
    }
  };

  return (
    <>
      <Dialog
        title="Agent architect"
        subtitle="Design an agent from the plugins you have."
        icon={<AgentAvatar agent={architectAvatar} size={32} />}
        onClose={onClose}
        width={1120}
        bodyClassName="p-0"
        footer={
          <div className="flex w-full flex-wrap items-end gap-3">
            <Field id={`${id}-team`} label="Team" className="w-full sm:w-52">
              <Input id={`${id}-team`} value={team} onChange={(e) => setTeam(e.target.value)} list={`${id}-teams`} placeholder="No team" maxLength={60} />
              <datalist id={`${id}-teams`}>
                {teams.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </Field>
            <div className="ml-auto flex gap-2">
              {onBack && (
                <Button onClick={onBack}>
                  <ChevronLeft className="size-3.5" /> Back
                </Button>
              )}
              <Button variant="primary" disabled={!draft} loading={creating} onClick={() => void create()}>
                Create agent
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex h-[min(620px,70vh)] min-h-0 flex-col md:flex-row">
          <div role="group" aria-label="Pane" className="flex shrink-0 gap-1 border-b border-hair p-2 md:hidden">
            {(['chat', 'draft'] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={pane === p}
                onClick={() => setPane(p)}
                className={cn('h-11 flex-1 rounded-full text-[13px] font-semibold transition-colors', pane === p ? 'bg-sf2 text-t1 shadow-sm' : 'text-t3')}
              >
                {p === 'chat' ? 'Chat' : draft ? 'Draft' : 'Draft (none yet)'}
              </button>
            ))}
          </div>
          <section aria-label="Chat with the Agent architect" className={cn('flex min-h-0 flex-1 flex-col border-b border-hair md:w-[400px] md:flex-none md:border-b-0 md:border-r', pane !== 'chat' && 'max-md:hidden')}>
            <div className="flex h-9 shrink-0 items-center justify-end gap-0.5 border-b border-hair px-2">
              <ConversationHistory
                {...SCOPE}
                ownSurfaceOnly
                subjectLabel="Agent designs"
                onOpen={(id) => {
                  if (streaming) return;
                  ask(true);
                  void kept.open(id).catch(() => {
                    asked.current = null;
                  });
                }}
                onNew={() => {
                  if (streaming) return;
                  kept.startNew();
                  setMessages([]);
                  setDraft(undefined);
                }}
              />
              <button
                type="button"
                aria-label="New design"
                title="New design"
                disabled={streaming}
                onClick={() => {
                  kept.startNew();
                  setMessages([]);
                  setDraft(undefined);
                }}
                className={cn(CHAT_ICON_BUTTON, 'disabled:opacity-40')}
              >
                <SquarePen className="size-3.5" />
              </button>
            </div>
            <div aria-live="polite" className="flex min-h-0 flex-1 flex-col p-4">
              {messages.length === 0 ? (
                <ChatEmpty
                  className="flex h-full flex-col justify-center"
                  mark={<AgentAvatar agent={architectAvatar} size={48} />}
                  title="The Agent architect"
                  help="Tell me what the agent should do, who it helps and where it works. I’ll pick the persona and the tools from your plugins."
                  starters={STARTERS}
                  onStarter={(text) => {
                    setInput(text);
                    box.current?.focus();
                  }}
                />
              ) : (
                <ChatList>
                  {messages.map((m, i) => {
                    const last = i === messages.length - 1;
                    const firstEarlier = m.earlier && !messages[i - 1]?.earlier;
                    const divider = firstEarlier && (
                      <div role="separator" className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
                        <span className="h-px flex-1 bg-hair" />
                        Earlier
                        <span className="h-px flex-1 bg-hair" />
                      </div>
                    );
                    if (m.role === 'user')
                      return (
                        <Fragment key={i}>
                          {divider}
                          <UserBubble>{m.text}</UserBubble>
                        </Fragment>
                      );
                    const working = streaming && last && !m.error;
                    const resumeAt = m.error?.checkpoint && m.error.step && m.error.step > 1 ? m.error.step : undefined;
                    const asked = messages[i - 1];
                    return (
                      <Fragment key={i}>
                        {divider}
                        <AssistantRow mark={<AgentAvatar agent={architectAvatar} size={20} />}>
                          {working ? (m.steps.length ? <ActivityTrace steps={m.steps} live /> : <Working label={m.stepLabel} />) : <ActivityTrace steps={m.steps} live={false} durationMs={m.info?.durationMs} />}
                          {m.text && <ChatMarkdown text={m.text} />}
                          {m.proposed && (
                            <button type="button" onClick={() => setPane('draft')} className="text-left text-[11px] text-t3 max-md:min-h-11 max-md:text-ac">
                              Draft updated: {m.proposed}
                            </button>
                          )}
                          {m.error && (
                            <ChatError
                              message={m.error.message}
                              onRetry={
                                streaming || !last
                                  ? undefined
                                  : () => {
                                      if (asked?.role === 'user') void send(asked.text, messages.slice(0, i - 1));
                                    }
                              }
                              actions={
                                resumeAt && !streaming && last && asked?.role === 'user'
                                  ? [{ label: `Continue from step ${resumeAt}`, primary: true, onClick: () => void send(asked.text, messages.slice(0, i + 1), { checkpoint: m.error!.checkpoint! }) }]
                                  : undefined
                              }
                            />
                          )}
                          {!working && !m.error && (m.info || m.text) && <ReplyMeta info={m.info} copy={m.text || undefined} />}
                        </AssistantRow>
                      </Fragment>
                    );
                  })}
                </ChatList>
              )}
            </div>
            <div className="shrink-0 border-t border-hair p-2.5">
              <ChatComposer
                inputRef={box}
                value={input}
                onChange={setInput}
                onSend={(text) => void send(text)}
                onStop={() => abort.current?.abort()}
                busy={streaming}
                placeholder={draft ? 'Ask for changes' : 'Describe the agent'}
                label="Message the Agent architect"
                chip={lastInfo?.model ? <ModelChip model={lastInfo.model} local={lastInfo.local} /> : undefined}
              />
            </div>
          </section>
          <section aria-label="Draft agent" className={cn('min-h-[260px] min-w-0 flex-1 overflow-y-auto bg-wl p-4', pane !== 'draft' && 'max-md:hidden')}>
            {draft ? (
              <DraftPreview draft={draft} seed={seed} fresh={fresh} onPick={() => setPicking(true)} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <span className="grid size-12 place-items-center rounded-2xl border border-hair bg-sf text-t3">
                  <Bot className="size-6" strokeWidth={1.5} />
                </span>
                <h3 className="text-[14px] font-semibold text-t1">The draft appears here</h3>
                <p className="max-w-[320px] text-[12px] leading-relaxed text-t3">
                  Once the architect proposes an agent you’ll see its persona, rules and tools here. Keep chatting to change it, then create it.
                </p>
              </div>
            )}
          </section>
        </div>
      </Dialog>
      {picking && choice && (
        <AvatarDialog
          name={draft?.config.name || 'Untitled agent'}
          subtitle="Agent architect draft"
          seed={seed}
          value={choice}
          onClose={() => setPicking(false)}
          onDone={(c) => {
            setDraft((d) => d && { ...d, config: { ...d.config, avatar: c.avatar, icon: c.icon, color: c.color } });
            setPicking(false);
          }}
        />
      )}
    </>
  );
}
