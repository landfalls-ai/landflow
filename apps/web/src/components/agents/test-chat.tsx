'use client';
/**
 * "Test agent": a slide-over chat with the draft, on the chat kit (docs/agents.md#test-chat): tool calls as one activity
 * line that opens into its steps, approvals as they happen, a footer under each reply, and Earlier tests: the agent's
 * earlier test sessions, whoever ran them (they are saved under Sessions already; nothing new is stored).
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Bot, Clock, SquarePen, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { Badge } from '../ui/badge';
import { AssistantRow, CHAT_ICON_BUTTON, ChatComposer, ChatEmpty, ModelChip, Working } from '../ui/chat';
import { ChatList } from '../ui/chat-motion';
import { Popover } from '../ui/popover';
import { isAnalyst, sourcesOf } from '@/lib/shared/analyst-chart';
import type { AgentToolConfig, SessionSummary } from '@/lib/shared/agents';
import { AnalystTimeline, SUGGEST_FIX_MESSAGE, SourceChips } from './analyst-view';
import { AgentAvatar, type AvatarSource } from './avatar';
import { timelineItems, type ToolEntry } from './timeline';
import { useAgentList } from './use-agent-data';
import { REASON_LABEL, useAgentRun } from './use-agent-run';
import { ContextPreviewButton } from './context-preview';
import { testProjectOptions, type AvailabilityAnswer, type ProjectRef } from './project-names';
import { Select } from '../ui/inputs';

/** The projects "Test in project" offers (home first), and none until they are known. */
function useTestProjects(agentId: string): ProjectRef[] {
  const [options, setOptions] = useState<ProjectRef[]>([]);
  useEffect(() => {
    let live = true;
    (async () => {
      const { availability } = await api<{ availability: AvailabilityAnswer }>(`/api/agents/${agentId}/shares`, { background: true });
      // "All projects": every project the person sees.
      const caller = availability.all ? (await api<{ projects: ProjectRef[] }>('/api/projects', { background: true })).projects : [];
      if (live) setOptions(testProjectOptions(availability, caller.map((p) => ({ id: p.id, name: p.name }))));
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [agentId]);
  return options;
}

/** The agent's earlier test sessions, newest first, whoever ran them: the sessions route, People, source test. */
function TestHistory({ agentId, current, onOpen }: { agentId: string; current?: string; onOpen: (id: string) => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api<{ sessions: SessionSummary[] }>(`/api/agents/${agentId}/sessions?audience=people&source=test&limit=30`, { background: true })
      .then((r) => live && setSessions(r.sessions))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [agentId]);
  return (
    <div className="max-h-[50vh] overflow-y-auto p-1 max-md:max-h-none">
      {failed && <p className="px-3 py-3 text-[12px] text-rd">Couldn’t load the earlier tests.</p>}
      {!failed && !sessions && <p className="px-3 py-3 text-[12px] text-t3">Loading…</p>}
      {sessions && !sessions.length && <p className="px-3 py-3 text-[12px] leading-relaxed text-t3">Nothing yet. Test conversations with this agent show up here.</p>}
      {sessions?.map((s) => (
        <button
          key={s.id}
          type="button"
          role="menuitem"
          onClick={() => onOpen(s.id)}
          className={cn('flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-acdim max-md:min-h-11 max-md:!items-start', s.id === current && 'bg-acdim')}
        >
          <span className="w-full truncate text-[13px] font-semibold text-t1">{s.title || 'Untitled session'}</span>
          <span className="text-[11px] text-t3">
            {timeAgo(s.updatedAt)} · {s.turns} {s.turns === 1 ? 'turn' : 'turns'}
          </span>
        </button>
      ))}
    </div>
  );
}

export function TestChat({
  agentId,
  agentName,
  look,
  onClose,
  beforeSend,
  childHref,
  onSessionChange,
  tools,
}: {
  agentId: string;
  agentName: string;
  /** The agent's avatar, shown when the chat is empty. */
  look?: AvatarSource;
  onClose: () => void;
  /** Saves the draft first, so the run uses what's on screen. */
  beforeSend: () => Promise<void>;
  childHref?: (entry: ToolEntry) => string | undefined;
  onSessionChange?: () => void;
  /** The agent's tools: the Platform analyst is drawn with source chips and an answer card. */
  tools?: AgentToolConfig[];
}) {
  const analyst = isAnalyst(tools);
  const projects = useTestProjects(agentId);
  const [project, setProject] = useState<string>();
  const home = projects[0];
  // The home project is the default: the chat names a project only when another is chosen.
  const chosen = project && project !== home?.id ? project : undefined;
  const run = useAgentRun(agentId, undefined, undefined, chosen);
  const [draft, setDraft] = useState('');
  const [deciding, setDeciding] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const agents = useAgentList();

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Escape closes the panel unless a dialog or menu is open over it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"],[role="menu"]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sendText = async (text: string) => {
    if (!text || run.running || run.awaitingApproval) return;
    await beforeSend().catch(() => {});
    await run.send(text);
    onSessionChange?.();
  };
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    return sendText(text);
  };

  const decide = async (callId: string, approved: boolean) => {
    setDeciding(true);
    try {
      await run.decide(callId, approved);
      onSessionChange?.();
    } finally {
      setDeciding(false);
    }
  };

  const last = run.entries[run.entries.length - 1];
  // A tool call has its own live line; "Thinking…" is for before the first one and between a person's answer and the next step.
  const thinking = run.running && last?.type !== 'tool';
  const lastTrace = run.traceIds[run.traceIds.length - 1];
  // The trace, as the Open trace link of the last activity line: the trace UI when the host has one, else this session under Sessions.
  const traceUrl = lastTrace ? (run.traceUrls[lastTrace] ?? (run.sessionId ? `/agents/${encodeURIComponent(agentId)}?tab=sessions&session=${encodeURIComponent(run.sessionId)}` : undefined)) : undefined;
  const model = run.entries.findLast((e): e is Extract<typeof e, { type: 'assistant' }> => e.type === 'assistant' && !!e.model)?.model ?? agents?.find((a) => a.id === agentId)?.model;
  const items = analyst
    ? run.entries.length
      ? [
          <AnalystTimeline
            key="analyst"
            entries={run.entries}
            running={run.running}
            childHref={childHref}
            onDecide={(callId, approved) => void decide(callId, approved)}
            deciding={deciding}
            onSuggest={() => void sendText(SUGGEST_FIX_MESSAGE)}
            traceUrl={traceUrl}
          />,
        ]
      : []
    : timelineItems({ entries: run.entries, childHref, onDecide: (callId, approved) => void decide(callId, approved), deciding, trace: { running: run.running, traceUrl } });

  return (
    <aside
      className="z-40 flex h-screen w-[380px] shrink-0 animate-panel flex-col border-l border-hair bg-sf max-md:fixed max-md:inset-0 max-md:h-dvh max-md:w-full max-md:pt-[env(safe-area-inset-top)]"
      aria-label="Test agent"
    >
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-hair px-3">
        <span className="text-[13px] font-semibold text-t1">Test agent</span>
        <Badge tone="muted">Draft</Badge>
        <span className="ml-auto flex items-center">
          <Popover
            title="Earlier tests"
            label="Earlier tests"
            align="end"
            className="w-[300px] p-0"
            trigger={({ toggle, open }) => (
              <button type="button" onClick={toggle} aria-label="Earlier tests" aria-expanded={open} title="Earlier tests of this agent" className={CHAT_ICON_BUTTON}>
                <Clock className="size-4" />
              </button>
            )}
          >
            {(close) => (
              <TestHistory
                agentId={agentId}
                current={run.sessionId}
                onOpen={(id) => {
                  close();
                  void run.load(id).catch((e: Error) => toast.error(`Could not open that test: ${e.message}`));
                }}
              />
            )}
          </Popover>
          <button title="New conversation" aria-label="New conversation" onClick={run.reset} className={CHAT_ICON_BUTTON}>
            <SquarePen className="size-3.5" />
          </button>
        </span>
        <button onClick={onClose} aria-label="Close test chat" className={CHAT_ICON_BUTTON}>
          <X className="size-4" />
        </button>
      </div>

      {projects.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-hair px-3 py-2">
          {projects.length > 1 && (
            <label className="flex min-w-[220px] flex-1 items-center gap-2 text-[12px] text-t3">
              <span className="shrink-0">Test in project</span>
              <Select
                aria-label="Test in project"
                value={project ?? home?.id}
                onChange={(e) => {
                  // Another project is another conversation: its block is part of the run.
                  if (run.entries.length) run.reset();
                  setProject(e.target.value);
                }}
                className="h-8 text-[12px] max-md:h-10"
              >
                {projects.map((p, i) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {i === 0 ? ' (home)' : ''}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <ContextPreviewButton agentId={agentId} projectId={chosen} projectName={projects.find((p) => p.id === (project ?? home?.id))?.name} />
        </div>
      )}

      {analyst && <SourceChips sources={sourcesOf((tools ?? []).map((t) => ('name' in t ? String(t.name) : '')))} />}

      <div className="flex min-h-0 flex-1 flex-col px-4 py-4">
        {run.entries.length === 0 ? (
          <ChatEmpty
            className="mt-8"
            mark={look ? <AgentAvatar agent={look} size={40} round /> : undefined}
            title={`Talk to ${agentName || 'your agent'}`}
            help="Messages run the current draft. Tool calls show up here as they happen, and the conversation is saved under Sessions."
          />
        ) : (
          <ChatList>
            {[
              ...items,
              ...(thinking
                ? [
                    <AssistantRow key="thinking" mark={<Bot className="size-3.5" />}>
                      <Working />
                    </AssistantRow>,
                  ]
                : []),
            ]}
          </ChatList>
        )}
      </div>

      <div className="border-t border-hair p-2.5 max-md:pb-[max(10px,env(safe-area-inset-bottom))]">
        {/* The time, tokens and cost are under each reply, the trace in its activity line; here, only how a run ended badly. */}
        {run.reason && run.reason !== 'completed' && !run.running && (
          <p className={cn('mb-2 text-[11px]', run.reason === 'error' ? 'text-rd' : 'text-warn')}>{REASON_LABEL[run.reason]}</p>
        )}
        <ChatComposer
          inputRef={input}
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          onStop={run.stop}
          busy={run.running}
          canSend={!run.awaitingApproval}
          placeholder={run.awaitingApproval ? 'Approve or deny the tool call first…' : 'Message the agent'}
          label="Message the agent"
          chip={model ? <ModelChip model={model} local={model.startsWith('ollama/')} /> : undefined}
        />
      </div>
    </aside>
  );
}
