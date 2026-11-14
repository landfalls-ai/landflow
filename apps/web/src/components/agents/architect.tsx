'use client';
/**
 * The Agent architect (docs/agents.md#agent-architect): a chat with a specialist that designs an agent from the plugins
 * this instance has. The chat is on the left; the draft it proposes stays on the right, whole, until the user creates it.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, Bot, Check, ChevronLeft, Loader2, Plug, RadioTower, TriangleAlert, Workflow, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, streamEvents } from '@/lib/client/api';
import { nodeColor, tint } from '@/lib/client/node-style';
import { cn } from '@/lib/utils';
import type { AgentConfig, AgentToolConfig } from '@/lib/shared/agents';
import { isNodeKnowledge } from '@/lib/shared/agents';
import { ARCHITECT, type ArchitectMissing, type ArchitectNeed, type ArchitectRequest, type ArchitectTurn } from '@/lib/shared/agent-architect';
import { randomFace } from '@/lib/shared/faces';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { Chip } from '../ui/badge';
import { Button } from '../ui/button';
import { AssistantRow, ChatComposer, ChatEmpty, ChatError, ChatMarkdown, UserBubble, Working } from '../ui/chat';
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

interface Draft {
  id: string;
  summary: string;
  config: Partial<AgentConfig>;
  needs: ArchitectNeed[];
  dropped: string[];
  missing: ArchitectMissing[];
}

interface Message {
  role: 'user' | 'assistant';
  text: string;
  tools: Array<{ name: string; label: string; ok: boolean }>;
  /** The summary of the draft this reply proposed. */
  proposed?: string;
  error?: string;
}

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
    subtitle = isNodeKnowledge(tool) ? `Knowledge base · ${tool.nodeType}` : `Knowledge base · “${tool.collection}”`;
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
  const bottom = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(false), 1200);
    return () => clearTimeout(t);
  }, [fresh, draft?.id]);

  /** Change the last (streaming) message. */
  const patch = (fn: (m: Message) => Message) => setMessages((list) => list.map((m, i) => (i === list.length - 1 ? fn(m) : m)));

  const send = async (text: string, base = messages) => {
    const content = text.trim();
    if (!content || streaming) return;
    const sent = [...base, { role: 'user' as const, text: content, tools: [] }];
    setMessages([...sent, { role: 'assistant', text: '', tools: [] }]);
    setInput('');
    setStreaming(true);
    const controller = new AbortController();
    abort.current = controller;
    const body: ArchitectRequest = { messages: history(sent), ...(draftRef.current && { draft: draftRef.current.config }) };
    try {
      await streamEvents(
        '/api/assistant/agent',
        body,
        (event, data) => {
          const d = data as Record<string, unknown>;
          if (event === 'text') patch((m) => ({ ...m, text: m.text + String(d.text ?? '') }));
          else if (event === 'tool') patch((m) => ({ ...m, tools: [...m.tools, { name: String(d.name), label: String(d.label ?? d.name), ok: d.ok !== false }] }));
          else if (event === 'draft') {
            const next = d as unknown as Draft;
            setDraft({ id: next.id, summary: next.summary, config: next.config ?? {}, needs: next.needs ?? [], dropped: next.dropped ?? [], missing: next.missing ?? [] });
            setFresh(true);
            setPane('draft');
            patch((m) => ({ ...m, proposed: next.summary }));
          } else if (event === 'error') patch((m) => ({ ...m, error: String(d.message ?? 'Something went wrong') }));
        },
        controller.signal,
      );
    } catch (e) {
      if (!controller.signal.aborted) patch((m) => ({ ...m, error: (e as Error).message }));
    } finally {
      setStreaming(false);
      abort.current = null;
    }
  };

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
            <div aria-live="polite" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 && (
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
              )}
              {messages.map((m, i) => {
                const last = i === messages.length - 1;
                if (m.role === 'user') return <UserBubble key={i}>{m.text}</UserBubble>;
                return (
                  <AssistantRow key={i} mark={<AgentAvatar agent={architectAvatar} size={20} />}>
                    {m.tools.map((t, j) => (
                      <div key={j} className="flex items-center gap-1.5 text-[11px] text-t3">
                        {t.ok ? <Check className="size-3 text-gn" /> : <X className="size-3 text-rd" />}
                        <span className="truncate">{t.label}</span>
                      </div>
                    ))}
                    {m.text && <ChatMarkdown text={m.text} />}
                    {m.proposed && (
                      <button type="button" onClick={() => setPane('draft')} className="text-left text-[11px] text-t3 max-md:min-h-11 max-md:text-ac">
                        Draft updated: {m.proposed}
                      </button>
                    )}
                    {streaming && last && !m.error && <Working />}
                    {m.error && (
                      <ChatError
                        message={m.error}
                        onRetry={
                          streaming || !last
                            ? undefined
                            : () => {
                                const asked = messages[i - 1];
                                if (asked?.role === 'user') void send(asked.text, messages.slice(0, i - 1));
                              }
                        }
                      />
                    )}
                  </AssistantRow>
                );
              })}
              <div ref={bottom} />
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
