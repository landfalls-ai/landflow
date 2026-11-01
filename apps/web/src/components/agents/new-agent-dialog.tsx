'use client';
/**
 * The New agent dialog (docs/agents.md#templates): pick a persona to start from, name it, give it a team and an avatar,
 * and create it. Saved templates can be deleted here by whoever may edit them.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import type { AgentTemplate } from '@/lib/shared/agents';
import { ARCHITECT } from '@/lib/shared/agent-architect';
import { randomFace } from '@/lib/shared/faces';
import { Button } from '../ui/button';
import { Chip } from '../ui/badge';
import { Input } from '../ui/inputs';
import { AgentArchitect } from './architect';
import { AgentAvatar } from './avatar';
import { AGENT_COLORS, AvatarDialog, type AvatarChoice } from './avatar-dialog';
import { Dialog, Field } from './dialog';

const ALL = 'All';
const SAVED = 'Your templates';
const categoryOf = (t: AgentTemplate) => (t.source === 'saved' ? SAVED : t.category);

function defaultChoice(template: AgentTemplate | undefined, seed: string): AvatarChoice {
  const c = template?.config;
  if (template && template.id !== 'blank' && (c?.avatar || c?.icon)) return { avatar: c.avatar, icon: c.icon || 'bot', color: c.color || AGENT_COLORS[0] };
  return { avatar: { kind: 'face', face: randomFace(seed) }, icon: c?.icon || 'bot', color: AGENT_COLORS[0] };
}

const defaultName = (t: AgentTemplate | undefined) => (!t || t.id === 'blank' ? '' : t.name);

function summary(t: AgentTemplate): string {
  const p = t.config.persona;
  const rules = (p?.always?.length ?? 0) + (p?.never?.length ?? 0);
  const examples = p?.examples?.length ?? 0;
  if (!rules && !examples) return 'Nothing filled in';
  return `${rules} ${rules === 1 ? 'rule' : 'rules'} · ${examples} ${examples === 1 ? 'example' : 'examples'}`;
}

export function NewAgentDialog({
  templates: initial,
  teams,
  initialTemplateId,
  initialMode = 'templates',
  onClose,
}: {
  templates: AgentTemplate[];
  teams: string[];
  initialTemplateId?: string;
  /** Open on the Agent architect instead of the template picker. */
  initialMode?: 'templates' | 'architect';
  onClose: () => void;
}) {
  const router = useRouter();
  const id = useId();
  const [mode, setMode] = useState(initialMode);
  const [templates, setTemplates] = useState(initial);
  const [selectedId, setSelectedId] = useState(initialTemplateId && initial.some((t) => t.id === initialTemplateId) ? initialTemplateId : 'blank');
  const [category, setCategory] = useState(ALL);
  const [seed] = useState(() => Math.random().toString(36).slice(2, 10));
  const selected = templates.find((t) => t.id === selectedId) ?? templates.find((t) => t.id === 'blank');
  const [name, setName] = useState(defaultName(selected));
  const [nameEdited, setNameEdited] = useState(false);
  const [choice, setChoice] = useState<AvatarChoice>(() => defaultChoice(selected, seed));
  const [choiceEdited, setChoiceEdited] = useState(false);
  const [team, setTeam] = useState('');
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const selectedCard = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (initialTemplateId) selectedCard.current?.scrollIntoView({ block: 'nearest' });
  }, [initialTemplateId]);

  const categories = useMemo(() => {
    const names: string[] = [];
    for (const t of templates) if (t.source === 'builtin' && !names.includes(t.category)) names.push(t.category);
    if (templates.some((t) => t.source === 'saved')) names.push(SAVED);
    return names;
  }, [templates]);
  const count = (c: string) => (c === ALL ? templates.length : templates.filter((t) => categoryOf(t) === c).length);
  const shown = category === ALL ? templates : templates.filter((t) => categoryOf(t) === category);

  const select = (t: AgentTemplate) => {
    setSelectedId(t.id);
    if (!nameEdited) setName(defaultName(t));
    if (!choiceEdited) setChoice(defaultChoice(t, seed));
  };

  const remove = async (t: AgentTemplate) => {
    try {
      await api(`/api/agent-templates/${t.id}`, { method: 'DELETE' });
      toast.success(`Deleted “${t.name}”`);
      setTemplates((list) => list.filter((x) => x.id !== t.id));
      if (selectedId === t.id) {
        const blank = templates.find((x) => x.id === 'blank');
        if (blank) select(blank);
      }
      if (category === SAVED && templates.filter((x) => x.source === 'saved').length <= 1) setCategory(ALL);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setConfirmDelete(undefined);
    }
  };

  const create = async () => {
    setCreating(true);
    try {
      const blank = !selected || selected.id === 'blank';
      const { agent } = await api<{ agent: { id: string } }>('/api/agents', {
        method: 'POST',
        json: {
          templateId: blank ? undefined : selected.id,
          name: name.trim() || undefined,
          team: team.trim() || undefined,
          avatar: choice.avatar,
          icon: choice.icon,
          color: choice.color,
        },
      });
      router.push(`/agents/${agent.id}`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
      setCreating(false);
    }
  };

  const navItem = (c: string) => (
    <button
      key={c}
      type="button"
      aria-pressed={category === c}
      onClick={() => setCategory(c)}
      className={cn(
        'flex shrink-0 items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-[13px] focus-visible:outline-2 focus-visible:outline-ac',
        category === c ? 'bg-acdim font-semibold text-ac' : 'text-t2 hover:bg-acdim hover:text-t1',
      )}
    >
      <span>{c}</span>
      <span className="text-[11px] tabular-nums text-t3">{count(c)}</span>
    </button>
  );

  if (mode === 'architect') return <AgentArchitect teams={teams} onBack={() => setMode('templates')} onClose={onClose} />;

  return (
    <>
      <Dialog
        title="New agent"
        subtitle="Start from a persona, or from a blank page."
        icon={<Plus className="size-5 text-ac" />}
        onClose={onClose}
        width={980}
        bodyClassName="p-0"
        footer={
          <div className="flex w-full flex-wrap items-end gap-3">
            <button
              type="button"
              aria-label="Change avatar"
              onClick={() => setPicking(true)}
              className="rounded-[28%] transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ac"
            >
              <AgentAvatar agent={{ name: name || 'Untitled agent', ...choice }} size={44} />
            </button>
            <Field id={`${id}-name`} label="Name" className="min-w-[160px] flex-1">
              <Input
                id={`${id}-name`}
                value={name}
                placeholder="Untitled agent"
                onChange={(e) => {
                  setName(e.target.value);
                  setNameEdited(true);
                }}
              />
            </Field>
            <Field id={`${id}-team`} label="Team" className="w-full sm:w-44">
              <Input id={`${id}-team`} value={team} onChange={(e) => setTeam(e.target.value)} list={`${id}-teams`} placeholder="No team" maxLength={60} />
              <datalist id={`${id}-teams`}>
                {teams.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </Field>
            <p className="order-last w-full text-[12px] text-t3">{selected?.suggests ? `Suggests tools: ${selected.suggests}` : 'No tools yet: add them on the Abilities tab.'}</p>
            <div className="ml-auto flex gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" onClick={() => void create()} loading={creating}>
                Create agent
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex flex-col md:flex-row">
          <nav aria-label="Template categories" className="flex shrink-0 gap-1 overflow-x-auto border-b border-hair p-3 md:w-[200px] md:flex-col md:overflow-visible md:border-b-0 md:border-r">
            {[ALL, ...categories].map(navItem)}
          </nav>
          <div className="grid min-w-0 flex-1 grid-cols-1 content-start gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-acbd bg-acdim p-3.5 sm:col-span-2 lg:col-span-3">
            <AgentAvatar agent={{ name: ARCHITECT.name, color: ARCHITECT.color, avatar: { kind: 'face', face: ARCHITECT.face } }} size={48} />
            <div className="min-w-0 flex-1 basis-60">
              <div className="text-[13px] font-semibold text-t1">Design it with the Agent architect</div>
              <p className="text-[12px] leading-snug text-t2">Describe the job in a chat; it picks the persona and the tools from your plugins and drafts the agent.</p>
            </div>
            <Button variant="primary" size="sm" onClick={() => setMode('architect')}>
              Start
            </Button>
          </div>
            {shown.map((t) => {
              const on = t.id === selected?.id;
              const tones = t.config.persona?.tones ?? [];
              return (
                <div key={t.id} className="relative">
                  <button
                    ref={on ? selectedCard : undefined}
                    type="button"
                    aria-pressed={on}
                    onClick={() => select(t)}
                    className={cn(
                      'flex h-full w-full flex-col gap-2 rounded-2xl border bg-wl p-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ac',
                      on ? 'border-2 border-ac bg-acdim' : 'border-hair hover:border-bd',
                    )}
                  >
                    <span className="flex items-center gap-2.5">
                      <AgentAvatar agent={{ name: t.name, icon: t.config.icon || 'bot', color: t.config.color || AGENT_COLORS[0], avatar: t.config.avatar }} size={44} />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold text-t1">{t.name}</span>
                        <span className="block truncate text-[11px] text-t3">{t.category}</span>
                      </span>
                    </span>
                    <span className="line-clamp-3 text-[12px] leading-snug text-t2">{t.description}</span>
                    {tones.length > 0 && (
                      <span className="flex flex-wrap gap-1">
                        {tones.slice(0, 3).map((tone) => (
                          <Chip key={tone} className="px-2 text-[11px]">
                            {tone}
                          </Chip>
                        ))}
                      </span>
                    )}
                    <span className={cn('mt-auto pt-1 text-[11px] text-t3', t.source === 'saved' && t.canEdit && 'pr-9')}>
                      {t.id === 'blank' ? 'Nothing filled in' : summary(t)}
                      {t.source === 'saved' && ` · ${t.projectName ? `Saved in ${t.projectName}` : 'Saved on this instance'}`}
                    </span>
                  </button>
                  {on && (
                    <span className="pointer-events-none absolute right-2.5 top-2.5 grid size-5 place-items-center rounded-full bg-ac2 text-on-ac">
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                  )}
                  {t.source === 'saved' && t.canEdit && (
                    <div
                      className={cn(
                        'absolute flex items-center gap-1',
                        confirmDelete === t.id ? 'inset-x-1.5 bottom-1.5 justify-end rounded-xl border border-hair bg-sf px-2 py-1 shadow-sm' : 'bottom-2 right-2',
                      )}
                    >
                      {confirmDelete === t.id ? (
                        <>
                          <span className="mr-auto text-[12px] text-t2">Delete this template?</span>
                          <Button size="sm" variant="danger" onClick={() => void remove(t)}>
                            Delete
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(undefined)}>
                            Keep
                          </Button>
                        </>
                      ) : (
                        <Button size="icon-sm" variant="ghost" aria-label={`Delete template ${t.name}`} onClick={() => setConfirmDelete(t.id)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Dialog>
      {picking && (
        <AvatarDialog
          name={name || 'Untitled agent'}
          subtitle="New agent"
          seed={seed}
          value={choice}
          onClose={() => setPicking(false)}
          onDone={(c) => {
            setChoice(c);
            setChoiceEdited(true);
            setPicking(false);
          }}
        />
      )}
    </>
  );
}
