'use client';
/** Build tab → Skills: Agent Skills (SKILL.md) uploaded as a file or folder, picked from the marketplace library, or written by hand. */
import { useRef, useState } from 'react';
import { BookOpen, FileText, FolderOpen, Library, Loader2, PenLine, Pencil, Plus, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import type { AgentConfig, AgentSkill } from '@/lib/shared/agents';
import type { LibrarySkill } from '@/lib/shared/marketplace';
import { Chip } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Input, Textarea } from '../ui/inputs';
import { Dialog, Field, ItemRow, Section } from './dialog';
import { newId, parseSkillMarkdown, readSkillFolder, toolName, type UpdateConfig } from './util';
import { useAgentList } from './use-agent-data';

const MAX_INSTRUCTIONS = 65536;

function SkillDialog({
  skill,
  toolNames,
  onSave,
  onClose,
}: {
  skill?: AgentSkill;
  toolNames: string[];
  onSave: (skill: AgentSkill) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<'choose' | 'library' | 'form'>(skill ? 'form' : 'choose');
  const [library, setLibrary] = useState<LibrarySkill[]>();
  const [value, setValue] = useState<AgentSkill>(skill ?? { id: newId('skill'), name: '', whenToUse: '', instructions: '' });
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const fill = (parsed: Partial<AgentSkill>) => {
    setValue((v) => ({ ...v, ...parsed }));
    setError(undefined);
    setStep('form');
  };

  const fromFile = async (file?: File) => {
    if (!file) return;
    try {
      fill(parseSkillMarkdown(await file.text()));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const fromFolder = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      fill(await readSkillFolder(files));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const set = (patch: Partial<AgentSkill>) => setValue((v) => ({ ...v, ...patch }));
  const allowed = new Set(value.allowedTools ?? []);
  const choices = [...new Set([...toolNames, ...(value.allowedTools ?? [])])];
  const valid = value.whenToUse.trim() && value.instructions.trim() && value.instructions.length <= MAX_INSTRUCTIONS;

  const tiles = [
    {
      key: 'file',
      icon: FileText,
      title: 'Upload SKILL.md',
      description: 'Name and description come from its frontmatter',
      onClick: () => fileInput.current?.click(),
    },
    {
      key: 'folder',
      icon: FolderOpen,
      title: 'Upload a folder',
      description: 'A skill folder: SKILL.md plus references/',
      onClick: () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.setAttribute('webkitdirectory', '');
        input.multiple = true;
        input.onchange = () => void fromFolder(input.files);
        input.click();
      },
    },
    {
      key: 'library',
      icon: Library,
      title: 'From the library',
      description: 'Skills installed from a marketplace plugin',
      onClick: () => {
        setStep('library');
        setError(undefined);
        api<{ skills: LibrarySkill[] }>('/api/skills')
          .then((r) => setLibrary(r.skills))
          .catch((e: Error) => {
            setLibrary([]);
            setError(e.message);
          });
      },
    },
    {
      key: 'manual',
      icon: PenLine,
      title: 'Add manually',
      description: 'Write the instructions here',
      onClick: () => setStep('form'),
    },
  ];

  return (
    <Dialog
      title={skill ? 'Edit skill' : 'Add skill'}
      subtitle="Skills teach the agent how to handle a kind of task. It loads one when the task matches “When to use”."
      icon={
        <span className="grid size-8 place-items-center rounded-[10px] border border-hair bg-wl text-t2">
          <BookOpen className="size-4" />
        </span>
      }
      onClose={onClose}
      width={620}
      footer={
        step === 'library' ? (
          <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setStep('choose')}>
            Back
          </Button>
        ) : step === 'form' ? (
          <>
            {!skill && (
              <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setStep('choose')}>
                Back
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!valid}
              onClick={() =>
                onSave({
                  ...value,
                  name: value.name.trim() || 'Untitled skill',
                })
              }
            >
              {skill ? 'Save skill' : 'Add skill'}
            </Button>
          </>
        ) : undefined
      }
    >
      <input
        ref={fileInput}
        type="file"
        accept=".md,.markdown,text/markdown,text/plain"
        className="hidden"
        onChange={(e) => void fromFile(e.target.files?.[0])}
      />
      {error && <div className="mb-3 rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">{error}</div>}
      {step === 'library' ? (
        !library ? (
          <div className="flex items-center gap-2 py-6 text-[13px] text-t3">
            <Loader2 className="size-4 animate-spin" /> Loading the skill library…
          </div>
        ) : library.length === 0 ? (
          <EmptyState
            title="The library is empty"
            hint="Install a plugin with skills from the Marketplace, and its skills show up here."
            action={
              <Link href="/marketplace">
                <Button size="sm" variant="outline">
                  Open Marketplace
                </Button>
              </Link>
            }
          />
        ) : (
          <div className="max-h-[420px] space-y-1.5 overflow-y-auto">
            {library.map((entry) => (
              <button
                key={entry.id}
                // A copy: later edits to the agent's skill don't change the library, and the library can be uninstalled.
                onClick={() => {
                  const { source: _source, ...copy } = entry;
                  fill({ ...copy, id: newId('skill') });
                }}
                className="flex w-full flex-col items-start gap-0.5 rounded-xl border border-hair bg-wl px-3.5 py-2.5 text-left transition-colors hover:border-ac"
              >
                <span className="flex w-full items-center gap-2 text-[13px] font-semibold text-t1">
                  {entry.name}
                  <span className="ml-auto font-mono text-[11px] font-normal text-t3">
                    {entry.source.plugin}@{entry.source.marketplace}
                  </span>
                </span>
                <span className="line-clamp-2 text-[12px] leading-snug text-t3">{entry.whenToUse}</span>
              </button>
            ))}
          </div>
        )
      ) : step === 'choose' ? (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {tiles.map((tile) => (
            <button
              key={tile.key}
              onClick={tile.onClick}
              className="group flex flex-col items-start gap-2 rounded-xl border border-hair bg-wl p-3.5 text-left transition-colors hover:border-ac animate-fade-up"
            >
              <span className="grid size-9 place-items-center rounded-[10px] border border-hair bg-sf text-t2 transition-colors group-hover:border-acbd group-hover:text-ac">
                <tile.icon className="size-4" />
              </span>
              <span className="text-[13px] font-semibold text-t1">{tile.title}</span>
              <span className="text-[12px] leading-snug text-t3">{tile.description}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <Field id="skill-name" label="Name">
            <Input id="skill-name" value={value.name} onChange={(e) => set({ name: e.target.value })} placeholder="Triage support tickets" autoFocus={!skill} />
          </Field>
          <Field id="skill-when" label="When to use this skill" required hint="Always in the agent’s prompt, so keep it to a sentence or two.">
            <Textarea
              id="skill-when"
              rows={2}
              value={value.whenToUse}
              onChange={(e) => set({ whenToUse: e.target.value })}
              placeholder="Use when a new ticket arrives and needs a priority and an owner."
            />
          </Field>
          <Field
            id="skill-instructions"
            label="What the skill does"
            required
            aside={
              <span className={cn('font-mono', value.instructions.length > MAX_INSTRUCTIONS && 'text-rd')}>
                {value.instructions.length.toLocaleString()}/{MAX_INSTRUCTIONS.toLocaleString()}
              </span>
            }
            hint="Step-by-step instructions, loaded only when the agent uses the skill."
          >
            <Textarea
              id="skill-instructions"
              rows={10}
              value={value.instructions}
              onChange={(e) => set({ instructions: e.target.value })}
              className="font-mono text-[12px]"
              placeholder={'1. Read the ticket.\n2. …'}
            />
          </Field>
          <div>
            <div className="mb-[5px] text-[12px] font-semibold text-t2" id="skill-tools-label">
              Allowed tools
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="skill-tools-label">
              {choices.map((name) => {
                const on = allowed.has(name);
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set({
                        allowedTools: on ? (value.allowedTools ?? []).filter((t) => t !== name) : [...(value.allowedTools ?? []), name],
                      })
                    }
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-[12px] transition-colors',
                      on ? 'border-ac2 bg-ac2 text-on-ac' : 'border-bd text-t2 hover:border-ac hover:text-ac',
                    )}
                  >
                    {name}
                  </button>
                );
              })}
              {!choices.length && <span className="text-[12px] text-t3">Add tools under Capabilities to pick them here.</span>}
            </div>
            <p className="mt-1 text-[12px] text-t3">The tools the skill expects. Informational: the agent can still use every tool.</p>
          </div>
          {value.references && value.references.length > 0 && (
            <div>
              <div className="mb-[5px] text-[12px] font-semibold text-t2">References</div>
              <div className="flex flex-wrap gap-1.5">
                {value.references.map((ref) => (
                  <Chip key={ref.name} mono>
                    {ref.name}
                    <span className="text-t3">{Math.max(1, Math.round(ref.content.length / 1024))} KB</span>
                    <button
                      type="button"
                      aria-label={`Remove ${ref.name}`}
                      onClick={() =>
                        set({
                          references: value.references?.filter((r) => r.name !== ref.name),
                        })
                      }
                      className="-mr-1 grid size-4 place-items-center rounded-full text-t3 hover:text-rd"
                    >
                      <X className="size-3" />
                    </button>
                  </Chip>
                ))}
              </div>
              <p className="mt-1 text-[12px] text-t3">Files the agent can read while using the skill.</p>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function SkillsCard({ config, update }: { config: AgentConfig; update: UpdateConfig }) {
  const [dialog, setDialog] = useState<{ skill?: AgentSkill } | null>(null);
  const agents = useAgentList();
  const toolNames = config.tools.map((t) => toolName(t, agents));

  const save = (skill: AgentSkill) => {
    update((c) => ({
      ...c,
      skills: c.skills.some((s) => s.id === skill.id) ? c.skills.map((s) => (s.id === skill.id ? skill : s)) : [...c.skills, skill],
    }));
    toast.success(dialog?.skill ? `Saved “${skill.name}”` : `Added “${skill.name}”`);
    setDialog(null);
  };

  return (
    <Section
      icon={<BookOpen className="size-4" />}
      title="Skills"
      description="Know-how for specific tasks, loaded only when a task calls for it."
      actions={
        <Button size="sm" variant="outline" onClick={() => setDialog({})}>
          <Plus className="size-3.5" /> Add skill
        </Button>
      }
    >
      {config.skills.length ? (
        <div className="space-y-1.5">
          {config.skills.map((skill) => (
            <ItemRow
              key={skill.id}
              icon={
                <span className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-hair bg-sf text-t2">
                  <BookOpen className="size-3.5" />
                </span>
              }
              title={skill.name}
              subtitle={skill.whenToUse}
              badges={skill.references?.length ? <Chip mono>{skill.references.length} refs</Chip> : undefined}
              onClick={() => setDialog({ skill })}
              actions={
                <>
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${skill.name}`} title="Edit" onClick={() => setDialog({ skill })}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${skill.name}`}
                    title="Delete"
                    className="hover:bg-rddim hover:text-rd"
                    onClick={() =>
                      update((c) => ({
                        ...c,
                        skills: c.skills.filter((s) => s.id !== skill.id),
                      }))
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              }
            />
          ))}
        </div>
      ) : (
        <EmptyState compact title="No skills yet" hint="Upload a SKILL.md or write one to teach the agent a repeatable procedure." />
      )}
      {dialog && <SkillDialog skill={dialog.skill} toolNames={toolNames} onSave={save} onClose={() => setDialog(null)} />}
    </Section>
  );
}
