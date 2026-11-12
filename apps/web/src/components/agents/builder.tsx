'use client';
/**
 * The agent builder (/agents/:id): header with setup checklist, test chat and publishing; the agent's icon, name and where
 * it runs; Persona, Abilities, Deploy, Safety, Sessions and Evaluations tabs. Every change to the draft autosaves after a
 * short pause.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Circle,
  CircleCheck,
  Download,
  FlaskConical,
  Loader2,
  MoreHorizontal,
  Package,
  Pencil,
  Rocket,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  Users,
  X,
  LayoutTemplate,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { diffConfigs, type Agent, type AgentConfig, type KagentStatus } from '@/lib/shared/agents';
import { Badge, Chip } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Input, Textarea } from '../ui/inputs';
import { MenuItem, MenuLabel, MenuSeparator, Popover } from '../ui/popover';
import { AgentAvatar } from './avatar';
import { AvatarDialog } from './avatar-dialog';
import { CapabilitiesCard } from './capabilities-card';
import { GuardrailsCard } from './guardrails-card';
import { KagentCard } from './kagent-card';
import { Dialog, Field } from './dialog';
import { ModelCard } from './model-card';
import { RouterCard } from './router-card';
import { CacheCard } from './cache-card';
import { AccessCard } from './access-card';
import { LayersCard } from './layers-card';
import { EvaluationsTab } from './evaluations-tab';
import { PersonaTab } from './persona-tab';
import { SessionsTab } from './sessions-tab';
import { SettingsTab } from './settings-tab';
import { PluginsCard } from './plugins-card';
import { SaveTemplateDialog } from './save-template-dialog';
import { SkillsCard } from './skills-card';
import { TestChat } from './test-chat';
import { useNewLook } from '../shell/look-toggle';
import { AgentLastRuns } from '../run-trace/run-line';
import type { ToolEntry } from './timeline';
import { TriggersCard } from './triggers-card';
import { useAgentData, useAgentList } from './use-agent-data';
import { ExportPluginDialog } from './export-plugin-dialog';
import { canTest, configOf, downloadJson, parseAgentFile, sameConfig, setupSteps, slug, type UpdateConfig } from './util';

export const BUILDER_TABS = ['persona', 'abilities', 'deploy', 'safety', 'sessions', 'evaluations'] as const;
export type BuilderTab = (typeof BUILDER_TABS)[number];
type SaveState = 'saved' | 'pending' | 'saving' | 'error';

/** Where each "Finish setup" step is done: the tab, the section to scroll to and the field to focus. */
const STEP_TARGET: Record<string, { tab: BuilderTab; section: string; field?: string }> = {
  model: { tab: 'abilities', section: 'section-model', field: 'agent-provider' },
  persona: { tab: 'persona', section: 'section-persona', field: 'persona-role' },
  tools: { tab: 'abilities', section: 'section-capabilities' },
};

const CHANNEL_NAMES: Record<string, string> = { slack: 'Slack', telegram: 'Telegram', teams: 'Teams' };

/** Where the published version runs: Landflow, kagent, its channels and schedules. Opens the Deploy tab. */
function RunsOn({ agent, onOpen }: { agent: Agent; onOpen: () => void }) {
  const published = agent.published;
  const channels = [...new Set((published?.config.channels ?? []).filter((c) => c.enabled).map((c) => CHANNEL_NAMES[c.type] ?? c.type))];
  const schedules = (published?.config.schedules ?? []).filter((s) => s.enabled).length;
  return (
    <button onClick={onOpen} className="group flex max-w-full flex-wrap items-center gap-1.5 text-left text-[12px] text-t3" title="Open the Deploy tab">
      <span className="group-hover:text-t1">Runs on</span>
      {published ? <Chip tone="success">Landflow · v{published.version}</Chip> : <Chip>Nowhere yet: publish it first</Chip>}
      {agent.kagent && (
        <Chip mono>
          kagent · {agent.kagent.name}
          {agent.kagent.version ? ` v${agent.kagent.version}` : ''}
        </Chip>
      )}
      {channels.map((name) => (
        <Chip key={name}>{name}</Chip>
      ))}
      {schedules > 0 && <Chip>{schedules === 1 ? '1 schedule' : `${schedules} schedules`}</Chip>}
    </button>
  );
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === 'error')
    return (
      <button onClick={onRetry} className="flex shrink-0 items-center gap-1 text-[12px] text-rd hover:underline" title="Retry saving">
        <TriangleAlert className="size-3" /> Not saved
      </button>
    );
  return (
    <span className="flex shrink-0 items-center gap-1 text-[12px] text-t3" aria-live="polite">
      {state === 'saved' ? <Check className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
      {/* A phone has no room for the word: it is still read out. */}
      <span className="max-sm:sr-only">{state === 'saved' ? 'Saved' : 'Saving…'}</span>
    </span>
  );
}

/** The agent's avatar: opens the avatar picker (a face, an icon, initials or an image, and the colour). */
function AvatarButton({ agentId, config, update }: { agentId: string; config: AgentConfig; update: UpdateConfig }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Change avatar"
        title="Change avatar"
        className="rounded-[28%] transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-ac"
      >
        <AgentAvatar agent={config} size={64} />
      </button>
      {open && (
        <AvatarDialog
          name={config.name}
          subtitle={config.persona?.role}
          seed={agentId}
          value={{ avatar: config.avatar, icon: config.icon, color: config.color }}
          onClose={() => setOpen(false)}
          onDone={(choice) => {
            setOpen(false);
            update((c) => {
              const { avatar: _avatar, ...rest } = c;
              return { ...rest, icon: choice.icon, color: choice.color, ...(choice.avatar && { avatar: choice.avatar }) };
            });
          }}
        />
      )}
    </>
  );
}

/** The team the agent belongs to, which groups it on the Agents page: one of the teams in use, or a new one. */
function TeamPicker({ config, update, teams }: { config: AgentConfig; update: UpdateConfig; teams: string[] }) {
  const [text, setText] = useState('');
  const set = (team?: string) =>
    update((c) => {
      const { team: _team, ...rest } = c;
      return team?.trim() ? { ...rest, team: team.trim() } : rest;
    });
  return (
    <Popover
      align="start"
      trigger={({ toggle, open }) => (
        <button
          onClick={() => {
            setText('');
            toggle();
          }}
          aria-expanded={open}
          className={cn('inline-flex items-center gap-1 rounded-full border border-hair px-2 py-0.5 text-[12px] transition-colors hover:border-bd', config.team ? 'text-t1' : 'text-t3')}
        >
          <Users className="size-3" />
          {config.team ?? 'Add to a team'}
        </button>
      )}
      className="w-[240px]"
    >
      {(close) => (
        <>
          <MenuLabel>Team</MenuLabel>
          <form
            className="px-2 pb-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              set(text);
              close();
            }}
          >
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="New team" aria-label="New team" maxLength={60} autoFocus />
          </form>
          {teams
            .filter((t) => t !== config.team)
            .map((team) => (
              <MenuItem
                key={team}
                onClick={() => {
                  set(team);
                  close();
                }}
              >
                <Users /> {team}
              </MenuItem>
            ))}
          {config.team && (
            <>
              <MenuSeparator />
              <MenuItem
                onClick={() => {
                  set(undefined);
                  close();
                }}
              >
                <X /> Remove from {config.team}
              </MenuItem>
            </>
          )}
        </>
      )}
    </Popover>
  );
}

export function AgentBuilder({ agentId, initialTab = 'persona', initialSession }: { agentId: string; initialTab?: BuilderTab; initialSession?: string }) {
  const router = useRouter();
  const agents = useAgentList();
  const teams = [...new Set((agents ?? []).flatMap((a) => (a.team ? [a.team] : [])))].sort((a, b) => a.localeCompare(b));
  const [agent, setAgent] = useState<Agent>();
  const newLook = useNewLook();
  const [draft, setDraft] = useState<AgentConfig>();
  const [loadError, setLoadError] = useState<string>();
  const [save, setSave] = useState<SaveState>('saved');
  const [tab, setTab] = useState<BuilderTab>(initialTab);
  const [sessionId, setSessionId] = useState(initialSession);
  const [testing, setTesting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [modal, setModal] = useState<
    { kind: 'description' } | { kind: 'delete' } | { kind: 'template' } | { kind: 'plugin' } | { kind: 'import'; config: Partial<AgentConfig>; file: string } | null
  >(null);
  const [description, setDescription] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const latest = useRef<AgentConfig>(undefined);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    api<{ agent: Agent }>(`/api/agents/${agentId}`)
      .then(({ agent }) => {
        setAgent(agent);
        const config = configOf(agent);
        latest.current = config;
        setDraft(config);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [agentId]);

  useEffect(() => {
    setTab(initialTab);
    setSessionId(initialSession);
  }, [initialTab, initialSession]);

  /** Saves the draft now (waiting for any save in flight). */
  const persist = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (!dirty.current || !latest.current) return queue.current;
    dirty.current = false;
    const body = latest.current;
    setSave('saving');
    queue.current = queue.current.then(async () => {
      try {
        const r = await api<{ agent?: Agent }>(`/api/agents/${agentId}`, {
          method: 'PUT',
          json: body,
        });
        if (r?.agent) setAgent(r.agent);
        if (!dirty.current) setSave('saved');
      } catch (e) {
        dirty.current = true;
        setSave('error');
        toast.error(`Could not save the agent: ${(e as Error).message}`);
      }
    });
    return queue.current;
  }, [agentId]);

  const update: UpdateConfig = useCallback(
    (fn) => {
      const current = latest.current;
      if (!current) return;
      const next = fn(current);
      latest.current = next;
      setDraft(next);
      dirty.current = true;
      setSave('pending');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void persist(), 600);
    },
    [persist],
  );

  // Leaving the page (or the tab) saves what's pending.
  useEffect(() => {
    const flush = () => {
      if (!dirty.current || !latest.current) return;
      dirty.current = false;
      void fetch(`/api/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(latest.current),
        keepalive: true,
      });
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      clearTimeout(timer.current);
      flush();
    };
  }, [agentId]);

  const go = (next: BuilderTab, session?: string) => {
    setTab(next);
    setSessionId(session);
    const params = new URLSearchParams();
    if (next !== 'persona') params.set('tab', next);
    if (session) params.set('session', session);
    const query = params.toString();
    window.history.replaceState(null, '', `/agents/${agentId}${query ? `?${query}` : ''}`);
  };

  const publish = async (skipEval = false) => {
    setPublishing(true);
    try {
      await persist();
      const { agent: next, kagent } = await api<{ agent: Agent; kagent?: KagentStatus | { error: string } }>(`/api/agents/${agentId}/publish`, { method: 'POST', json: { skipEval } });
      setAgent(next);
      if (kagent && 'error' in kagent) toast.warning(`Published v${next.published?.version ?? ''}, but kagent still has v${next.kagent?.version ?? '?'}: ${kagent.error}`);
      else toast.success(`Published v${next.published?.version ?? ''}${kagent ? ' and written to kagent' : ''}`);
      void useAgentData.getState().loadAgents();
    } catch (e) {
      // The eval gate held the publish: say why, and offer to go ahead.
      const verdict = e instanceof ApiError && e.status === 409 ? (e.body as { gate?: { verdict?: { reason?: string } } } | undefined)?.gate?.verdict : undefined;
      if (verdict) toast.warning(`Held by the eval gate. ${verdict.reason ?? ''}`, { duration: 15_000, action: { label: 'Publish anyway', onClick: () => void publish(true) } });
      else toast.error((e as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  const unpublish = async () => {
    setPublishing(true);
    try {
      const { agent: next } = await api<{ agent: Agent }>(`/api/agents/${agentId}/publish`, { method: 'DELETE' });
      setAgent(next);
      toast('Unpublished: triggers and channels are off');
      void useAgentData.getState().loadAgents();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  /** Copy an earlier version into the draft; publishing it is a separate step. */
  const restore = async (version: number) => {
    try {
      clearTimeout(timer.current);
      dirty.current = false;
      const { agent: next } = await api<{ agent: Agent }>(`/api/agents/${agentId}/restore`, { method: 'POST', json: { version } });
      setAgent(next);
      const config = configOf(next);
      latest.current = config;
      setDraft(config);
      toast.success(`v${version} is in the draft. Publish to make it live.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async () => {
    try {
      clearTimeout(timer.current);
      dirty.current = false;
      await api(`/api/agents/${agentId}`, { method: 'DELETE' });
      toast(`Deleted “${draft?.name}”`);
      void useAgentData.getState().loadAgents();
      router.push('/agents');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      setModal({
        kind: 'import',
        config: parseAgentFile(await file.text()),
        file: file.name,
      });
    } catch (e) {
      toast.error(`Could not import ${file.name}: ${(e as Error).message}`);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const focusStep = (key: string) => {
    const target = STEP_TARGET[key];
    if (!target) return;
    go(target.tab);
    requestAnimationFrame(() => {
      document.getElementById(target.section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (target.field) document.getElementById(target.field)?.focus({ preventScroll: true });
    });
  };

  /** The Layers card's "Set up": open the tab and scroll to the setting. */
  const jumpTo = (fix: { tab: BuilderTab; section?: string }) => {
    go(fix.tab);
    requestAnimationFrame(() => {
      if (fix.section) document.getElementById(fix.section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const childHref = (entry: ToolEntry) => {
    const target = entry.childAgentId ? { id: entry.childAgentId } : agents?.find((a) => a.name === entry.label && a.id !== agentId);
    return target && entry.childSessionId ? `/agents/${target.id}?tab=sessions&session=${encodeURIComponent(entry.childSessionId)}` : undefined;
  };

  if (loadError)
    return (
      <div className="px-6 py-16">
        <EmptyState
          title="Agent not found"
          hint={loadError}
          action={
            <Link href="/agents">
              <Button size="sm">Back to agents</Button>
            </Link>
          }
        />
      </div>
    );

  if (!agent || !draft)
    return (
      <div className="flex h-screen flex-col">
        <div className="h-[52px] border-b border-hair" />
        <div className="mx-auto w-full max-w-[680px] space-y-4 px-4 py-8">
          <div className="size-14 rounded-[28%] bg-acdim animate-pulse-soft" />
          <div className="h-6 w-56 rounded-md bg-acdim animate-pulse-soft" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-36 rounded-2xl bg-acdim animate-pulse-soft" style={{ animationDelay: `${i * 120}ms` }} />
          ))}
        </div>
      </div>
    );

  const steps = setupSteps(draft);
  const incomplete = steps.some((s) => !s.done);
  const testable = canTest(draft);
  const published = agent.published;
  const changed = !published || !sameConfig(draft, published.config);
  const nextVersion = (published?.version ?? agent.history[0]?.version ?? 0) + 1;

  return (
    <div className="flex h-screen min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-20 flex h-[52px] shrink-0 items-center gap-2 border-b border-hair bg-bg px-3 sm:px-6">
          <Link
            href="/agents"
            className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-1 text-[13px] text-t2 transition-colors hover:bg-acdim hover:text-t1"
            aria-label="Back to agents"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Agents</span>
          </Link>
          <span className="hidden text-t3 sm:inline">/</span>
          <input
            aria-label="Agent name"
            value={draft.name}
            onChange={(e) => {
              const name = e.target.value;
              update((c) => ({ ...c, name }));
            }}
            onBlur={() => !draft.name.trim() && update((c) => ({ ...c, name: 'Untitled agent' }))}
            className="min-w-0 max-w-[260px] flex-1 truncate rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[15px] font-semibold text-t1 outline-none transition-colors hover:border-hair focus:border-ac"
          />
          <SaveIndicator state={save} onRetry={() => void persist()} />
          <span className="hidden items-center gap-1.5 lg:flex">
            {published ? <Badge tone="success">Published v{published.version}</Badge> : <Badge tone="muted">Draft</Badge>}
            {published && changed && <Badge tone="warning">Changes not published</Badge>}
          </span>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {incomplete && (
              <Popover
                trigger={({ toggle, open }) => (
                  <Button size="sm" variant="ghost" onClick={toggle} aria-expanded={open} className="text-warn hover:text-warn">
                    <CircleCheck className="size-3.5" />
                    <span className="hidden md:inline">Finish setup</span>
                    <span className="font-mono text-[11px]">
                      {steps.filter((s) => s.done).length}/{steps.length}
                    </span>
                  </Button>
                )}
                className="w-[240px]"
              >
                {(close) => (
                  <>
                    <MenuLabel>Finish setup</MenuLabel>
                    {steps.map((step) => (
                      <MenuItem
                        key={step.key}
                        onClick={() => {
                          close();
                          focusStep(step.key);
                        }}
                      >
                        {step.done ? <CircleCheck className="text-gn" /> : <Circle className="text-t3" />}
                        <span className={cn(step.done && 'text-t3 line-through')}>{step.label}</span>
                      </MenuItem>
                    ))}
                  </>
                )}
              </Popover>
            )}
            <span title={testable ? 'Chat with the draft' : 'Choose a model and describe the persona first'}>
              <Button
                size="sm"
                variant="outline"
                disabled={!testable}
                onClick={() => setTesting(!testing)}
                aria-pressed={testing}
                className={cn(testing && 'border-ac text-ac')}
              >
                <FlaskConical className="size-3.5" />
                <span className="hidden sm:inline">Test agent</span>
              </Button>
            </span>
            <div className="flex">
              <Button
                size="sm"
                variant="primary"
                className="rounded-r-none pr-2.5"
                loading={publishing}
                disabled={!changed}
                onClick={() => void publish()}
                title={changed ? `Publish the draft as v${nextVersion}` : 'The published version matches the draft'}
              >
                {!publishing && <Rocket className="size-3.5" />}
                {changed ? <span>Publish{published ? ` v${nextVersion}` : ''}</span> : <span>Published v{published?.version}</span>}
              </Button>
              <Popover
                trigger={({ toggle }) => (
                  <Button
                    size="sm"
                    variant="primary"
                    className="rounded-l-none pl-1.5 pr-2 shadow-[inset_1px_0_0_rgba(255,255,255,0.28)]"
                    onClick={toggle}
                    aria-label="Publish options"
                  >
                    <ChevronDown className="size-3.5" />
                  </Button>
                )}
                className="w-[250px]"
              >
                {(close) => (
                  <>
                    <MenuLabel>{published ? `Published v${published.version} · ${timeAgo(published.publishedAt)}` : 'Not published'}</MenuLabel>
                    {published && changed && <div className="px-2.5 pb-1.5 text-[12px] text-warn">The draft has changes not published yet.</div>}
                    {!published && <div className="px-2.5 pb-1.5 text-[12px] text-t3">Schedules, channels and workflows use the published version.</div>}
                    <MenuItem
                      disabled={!changed || publishing}
                      onClick={() => {
                        close();
                        void publish();
                      }}
                    >
                      <Rocket /> Publish v{nextVersion}
                    </MenuItem>
                    <MenuItem
                      danger
                      disabled={!published || publishing}
                      onClick={() => {
                        close();
                        void unpublish();
                      }}
                    >
                      <Undo2 /> Unpublish
                    </MenuItem>
                    {agent.history.length > 0 && (
                      <>
                        <MenuSeparator />
                        <MenuLabel>History</MenuLabel>
                        <div className="max-h-40 overflow-y-auto">
                          {agent.history.map((v, i) => {
                            const older = agent.history[i + 1];
                            const changes = older ? diffConfigs(older.config, v.config).map((c) => c.label) : [];
                            return (
                              <div key={v.version} className="px-2.5 py-1 text-[12px] text-t2">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-mono">v{v.version}</span>
                                  <span className="text-t3">{timeAgo(v.publishedAt)}</span>
                                  <button
                                    type="button"
                                    className="rounded px-1 text-[11px] text-ac hover:bg-acdim"
                                    disabled={sameConfig(draft, v.config)}
                                    onClick={() => {
                                      close();
                                      void restore(v.version);
                                    }}
                                  >
                                    Restore
                                  </button>
                                </div>
                                {changes.length > 0 && <div className="truncate text-[11px] text-t3">Changed: {changes.join(', ')}</div>}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </>
                )}
              </Popover>
            </div>
            <Popover
              trigger={({ toggle }) => (
                <Button size="icon-sm" variant="ghost" onClick={toggle} aria-label="More actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    onClick={() => {
                      close();
                      setDescription(draft.description);
                      setModal({ kind: 'description' });
                    }}
                  >
                    <Pencil /> Edit description
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      close();
                      downloadJson(`${slug(draft.name)}.agent.json`, configOf(draft));
                    }}
                  >
                    <Download /> Export JSON
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      close();
                      setModal({ kind: 'plugin' });
                    }}
                  >
                    <Package /> Export as Claude Code plugin…
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      close();
                      setModal({ kind: 'template' });
                    }}
                  >
                    <LayoutTemplate /> Save as template…
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      close();
                      fileInput.current?.click();
                    }}
                  >
                    <Upload /> Import JSON
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    danger
                    onClick={() => {
                      close();
                      setModal({ kind: 'delete' });
                    }}
                  >
                    <Trash2 /> Delete agent
                  </MenuItem>
                </>
              )}
            </Popover>
          </div>
        </header>
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void importFile(e.target.files?.[0])} />

        <div className={cn('mx-auto w-full px-4 pb-16 pt-7 sm:px-6', tab === 'persona' ? 'max-w-[1160px]' : tab === 'sessions' ? 'max-w-[960px]' : 'max-w-[680px]')}>
          <div className="flex animate-fade-up items-center gap-4">
            <AvatarButton agentId={agentId} config={draft} update={update} />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[22px] font-semibold tracking-[-0.01em] text-t1">{draft.name || 'Untitled agent'}</h1>
              <button
                onClick={() => {
                  setDescription(draft.description);
                  setModal({ kind: 'description' });
                }}
                className={cn('mt-0.5 block max-w-full truncate text-left text-[13px] hover:text-ac', draft.description ? 'text-t2' : 'text-t3')}
              >
                {draft.description || 'Add a description'}
              </button>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <TeamPicker config={draft} update={update} teams={teams} />
                <RunsOn agent={agent} onOpen={() => go('deploy')} />
              </div>
            </div>
          </div>

          <div className="mt-5 flex gap-5 overflow-x-auto border-b border-hair" role="tablist" aria-label="Agent">
            {BUILDER_TABS.map((key) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                onClick={() => go(key)}
                className={cn(
                  '-mb-px shrink-0 border-b-2 pb-2 text-[13px] capitalize transition-colors',
                  tab === key ? 'border-ac font-semibold text-t1' : 'border-transparent text-t2 hover:text-t1',
                )}
              >
                {key}
              </button>
            ))}
          </div>

          <div className="mt-5">
            {tab === 'persona' && (
              <PersonaTab agent={agent} config={draft} update={update} nextVersion={nextVersion} testable={testable} onTest={() => setTesting(true)} />
            )}
            {tab === 'abilities' && (
              <div className="space-y-4">
                <LayersCard agentId={agentId} config={draft} onFix={jumpTo} />
                <div id="section-model" className="scroll-mt-20">
                  <ModelCard config={draft} update={update} />
                </div>
                <div id="section-router" className="scroll-mt-20">
                  <RouterCard agentId={agentId} config={draft} update={update} />
                </div>
                <div id="section-cache" className="scroll-mt-20">
                  <CacheCard agentId={agentId} config={draft} update={update} />
                </div>
                <div id="section-access" className="scroll-mt-20">
                  <AccessCard agentId={agentId} config={draft} update={update} />
                </div>
                <SkillsCard config={draft} update={update} />
                <div id="section-capabilities" className="scroll-mt-20 space-y-4">
                  <CapabilitiesCard agentId={agentId} config={draft} update={update} />
                </div>
                <PluginsCard config={draft} update={update} />
              </div>
            )}
            {tab === 'deploy' && (
              <div className="space-y-4">
                <TriggersCard config={draft} update={update} published={Boolean(published)} agentId={agentId} />
                <KagentCard agent={agent} onAgent={setAgent} />
              </div>
            )}
            {tab === 'safety' && (
              <div className="space-y-4">
                <div id="section-guardrails" className="scroll-mt-20">
                  <GuardrailsCard config={draft} update={update} />
                </div>
                <SettingsTab config={draft} update={update} agentId={agentId} />
              </div>
            )}
            {tab === 'sessions' && newLook && !sessionId && <AgentLastRuns agentName={agent.name} />}
            {tab === 'sessions' && <SessionsTab agentId={agentId} sessionId={sessionId} onOpen={(id) => go('sessions', id)} childHref={childHref} />}
            {tab === 'evaluations' && <EvaluationsTab agentId={agentId} />}
          </div>
        </div>
      </div>

      {testing && <TestChat agentId={agentId} agentName={draft.name} look={draft} onClose={() => setTesting(false)} beforeSend={persist} childHref={childHref} tools={draft.tools} />}

      {modal?.kind === 'description' && (
        <Dialog
          title="Edit description"
          subtitle="Shown in the agent list, and to other agents that delegate to this one."
          onClose={() => setModal(null)}
          width={480}
          footer={
            <>
              <Button size="sm" variant="outline" onClick={() => setModal(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  const value = description.trim();
                  update((c) => ({ ...c, description: value }));
                  setModal(null);
                }}
              >
                Save
              </Button>
            </>
          }
        >
          <Field id="agent-description" label="Description">
            <Textarea
              id="agent-description"
              rows={3}
              autoFocus
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Answers customer questions about orders and refunds."
            />
          </Field>
        </Dialog>
      )}
      {modal?.kind === 'plugin' && <ExportPluginDialog base={`/api/agents/${agentId}`} title={draft.name} onClose={() => setModal(null)} />}
      {modal?.kind === 'template' && (
        <SaveTemplateDialog agent={{ id: agentId, name: draft.name, description: draft.description }} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'delete' && (
        <Dialog
          title={`Delete “${draft.name}”?`}
          onClose={() => setModal(null)}
          width={440}
          footer={
            <>
              <Button size="sm" variant="outline" onClick={() => setModal(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" onClick={() => void remove()}>
                <Trash2 className="size-3.5" /> Delete agent
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-relaxed text-t2">
            The agent, its published versions and its schedules and channels are removed. This can’t be undone. Export it as JSON first if you may want it back.
          </p>
        </Dialog>
      )}
      {modal?.kind === 'import' && (
        <Dialog
          title="Replace the draft?"
          subtitle={modal.file}
          onClose={() => setModal(null)}
          width={460}
          footer={
            <>
              <Button size="sm" variant="outline" onClick={() => setModal(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  const imported = modal.config;
                  update((c) =>
                    configOf({
                      ...c,
                      ...imported,
                      memory: { ...c.memory, ...imported.memory },
                      settings: { ...c.settings, ...imported.settings },
                    } as AgentConfig),
                  );
                  toast.success('Imported into the draft');
                  setModal(null);
                }}
              >
                Replace draft
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-relaxed text-t2">
            The draft of <strong className="text-t1">{draft.name}</strong> is replaced with{' '}
            {modal.config.name ? <strong className="text-t1">{modal.config.name}</strong> : 'the file'} ({modal.config.tools?.length ?? 0} tools,{' '}
            {modal.config.skills?.length ?? 0} skills). The published version stays as it is until you publish again.
          </p>
        </Dialog>
      )}
    </div>
  );
}
