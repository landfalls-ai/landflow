'use client';
/**
 * The Persona tab: who the agent is (name, role, who it helps, what it does), how it talks (tone, answer length, language, a
 * sign-off), its rules and examples, and instructions in its own words. Beside them, the system prompt they make as the
 * runtime and kagent get it (personaPrompt), and what changed since the published version.
 */
import { useMemo, useState } from 'react';
import { AudioLines, FlaskConical, Info, ListChecks, MessagesSquare, NotebookPen, Plus, ScrollText, UserRound, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Agent, AgentConfig, AgentPersona } from '@/lib/shared/agents';
import { ANSWER_LENGTHS, PERSONA_TONES, cleanPersona, personaPrompt } from '@/lib/shared/persona';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/inputs';
import { Field, Section } from './dialog';
import { AutoTextarea } from './model-card';
import type { UpdateConfig } from './util';

const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch', 'Polish', 'Turkish', 'Hebrew', 'Arabic', 'Hindi', 'Russian', 'Japanese', 'Korean', 'Chinese'];
const MAX_EXAMPLES = 10;

function TonePicker({ tones, onChange }: { tones: string[]; onChange: (tones: string[]) => void }) {
  const [other, setOther] = useState('');
  const shown = [...PERSONA_TONES, ...tones.filter((t) => !PERSONA_TONES.includes(t))];
  const add = () => {
    const tone = other.trim();
    if (tone && !tones.includes(tone)) onChange([...tones, tone]);
    setOther('');
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((tone) => {
        const on = tones.includes(tone);
        return (
          <button
            key={tone}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? tones.filter((t) => t !== tone) : [...tones, tone])}
            className={cn(
              'h-7 rounded-full border px-3 text-[12px] font-medium transition-colors duration-[120ms]',
              on ? 'border-ac2 bg-ac2 text-on-ac' : 'border-hair bg-wl text-t2 hover:border-bd hover:text-t1',
            )}
          >
            {tone}
          </button>
        );
      })}
      <input
        id="persona-tone"
        aria-label="Another tone"
        value={other}
        placeholder="+ Another"
        onChange={(e) => setOther(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          add();
        }}
        onBlur={add}
        className="h-7 w-[104px] rounded-full border border-dashed border-bd bg-transparent px-3 text-[12px] text-t1 outline-none placeholder:text-t3 focus:border-ac"
      />
    </div>
  );
}

function RuleList({ id, label, placeholder, rules, onChange }: { id: string; label: string; placeholder: string; rules: string[]; onChange: (rules: string[]) => void }) {
  const [next, setNext] = useState('');
  const add = () => {
    const rule = next.trim();
    if (rule) onChange([...rules, rule]);
    setNext('');
  };
  return (
    <Field id={id} label={label}>
      {rules.length > 0 && (
        <ul className="mb-1.5 space-y-1.5">
          {rules.map((rule, i) => (
            <li key={i} className="flex items-center gap-1">
              <Input aria-label={`${label}, rule ${i + 1}`} value={rule} onChange={(e) => onChange(rules.map((r, j) => (j === i ? e.target.value : r)))} />
              <Button size="icon-sm" variant="ghost" aria-label={`Remove “${rule}”`} title="Remove" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1">
        <Input
          id={id}
          value={next}
          placeholder={placeholder}
          onChange={(e) => setNext(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            add();
          }}
          onBlur={add}
        />
        <Button size="icon-sm" variant="ghost" aria-label={`Add to ${label}`} title="Add" disabled={!next.trim()} onClick={add}>
          <Plus className="size-3.5" />
        </Button>
      </div>
    </Field>
  );
}

function ExampleList({ examples, onChange }: { examples: NonNullable<AgentPersona['examples']>; onChange: (examples: NonNullable<AgentPersona['examples']>) => void }) {
  const set = (i: number, patch: Partial<(typeof examples)[number]>) => onChange(examples.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <div className="space-y-3">
      {examples.map((example, i) => (
        <div key={i} className="space-y-2.5 rounded-xl border border-hair bg-wl p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-t2">Example {i + 1}</span>
            <Button size="icon-sm" variant="ghost" aria-label={`Remove example ${i + 1}`} title="Remove" onClick={() => onChange(examples.filter((_, j) => j !== i))}>
              <X className="size-3.5" />
            </Button>
          </div>
          <Field id={`persona-example-${i}-user`} label="Someone writes">
            <AutoTextarea id={`persona-example-${i}-user`} rows={1} value={example.user} onChange={(e) => set(i, { user: e.target.value })} placeholder="can you tidy this up: teh release is on friday" />
          </Field>
          <Field
            id={`persona-example-${i}-assistant`}
            label="It answers"
            hint={!example.user.trim() || !example.assistant.trim() ? 'Write both sides to add it to the prompt.' : undefined}
          >
            <AutoTextarea id={`persona-example-${i}-assistant`} rows={1} value={example.assistant} onChange={(e) => set(i, { assistant: e.target.value })} placeholder="The release is on Friday." />
          </Field>
        </div>
      ))}
      <Button size="sm" variant="outline" disabled={examples.length >= MAX_EXAMPLES} onClick={() => onChange([...examples, { user: '', assistant: '' }])}>
        <Plus className="size-3.5" /> Add example
      </Button>
    </div>
  );
}

type DiffLine = { op: ' ' | '+' | '-'; line: string };

/** A line diff (longest common subsequence), or undefined when the texts are too long to compare here. */
function lineDiff(before: string, after: string): DiffLine[] | undefined {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 1_000_000) return undefined;
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: '-', line: a[i++] });
    else out.push({ op: '+', line: b[j++] });
  }
  while (i < a.length) out.push({ op: '-', line: a[i++] });
  while (j < b.length) out.push({ op: '+', line: b[j++] });
  return out;
}

function PromptPreview({ agent, config, nextVersion, testable, onTest }: { agent: Agent; config: AgentConfig; nextVersion: number; testable: boolean; onTest: () => void }) {
  const prompt = useMemo(() => personaPrompt(config), [config]);
  const published = agent.published;
  const before = useMemo(() => (published ? personaPrompt(published.config) : undefined), [published]);
  const changed = before !== undefined && before !== prompt;
  const [view, setView] = useState<'draft' | 'changes'>('draft');
  const comparing = changed && view === 'changes';
  const diff = useMemo(() => (comparing ? lineDiff(before!, prompt) : undefined), [comparing, before, prompt]);
  const kagentRuns = Boolean(agent.kagent && published && agent.kagent.version === published.version);

  return (
    <section aria-labelledby="prompt-preview-title" className="flex min-w-0 flex-col rounded-2xl border border-hair bg-sf animate-fade-up lg:sticky lg:top-[68px] lg:max-h-[calc(100vh-84px)]">
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-hair bg-wl text-t2">
          <ScrollText className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="prompt-preview-title" className="text-[14px] font-semibold text-t1">
            What the model reads
          </h2>
          <p className="text-[12px] leading-snug text-t3">The system prompt, here and on kagent, as you edit.</p>
        </div>
      </div>
      <div
        aria-live="polite"
        className={cn(
          'mx-4 mb-3 rounded-[10px] border px-3 py-2 text-[12px] leading-snug',
          !published ? 'border-hair text-t3' : changed ? 'border-warnbd bg-warndim text-warn' : 'border-gnbd bg-gndim text-gn',
        )}
      >
        {!published
          ? 'Not published yet: schedules, channels and kagent use this prompt once you publish.'
          : changed
            ? `Changed since v${published.version}. Publish v${nextVersion} to use it here${agent.kagent ? ' and on kagent' : ''}.`
            : `The same as published v${published.version}${kagentRuns ? ', the version kagent runs' : ''}.`}
      </div>
      {changed && (
        <div role="group" aria-label="Prompt view" className="mx-4 mb-2 inline-flex self-start rounded-[10px] border border-hair bg-wl p-0.5">
          {(
            [
              ['draft', 'Draft'],
              ['changes', `Changes since v${published!.version}`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              onClick={() => setView(key)}
              className={cn('h-6 rounded-[8px] px-2.5 text-[12px] transition-colors', view === key ? 'bg-sf font-semibold text-t1 shadow-sm' : 'text-t2 hover:text-t1')}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-[160px] flex-1 overflow-auto border-y border-hair bg-wl py-3 font-mono text-[12px] leading-[1.6]" tabIndex={0} aria-label="System prompt">
        {comparing ? (
          diff ? (
            diff.map((d, i) => (
              <div key={i} className={cn('whitespace-pre-wrap break-words px-4', d.op === '+' && 'bg-gndim text-gn', d.op === '-' && 'bg-rddim text-rd line-through')}>
                <span aria-hidden className="mr-2 inline-block w-2 select-none">
                  {d.op}
                </span>
                <span className="sr-only">{d.op === '+' ? 'Added: ' : d.op === '-' ? 'Removed: ' : ''}</span>
                {d.line || ' '}
              </div>
            ))
          ) : (
            <p className="px-4 font-sans text-t3">Too long to compare here.</p>
          )
        ) : (
          prompt.split('\n').map((line, i) => (
            <div key={i} className={cn('whitespace-pre-wrap break-words px-4', line.startsWith('## ') ? 'font-semibold text-t1' : 'text-t2')}>
              {line || ' '}
            </div>
          ))
        )}
      </div>
      <div className="flex items-center gap-3 px-4 py-2.5">
        <p className="min-w-0 flex-1 text-[11px] leading-snug text-t3">
          {prompt.length.toLocaleString()} characters, about {Math.ceil(prompt.length / 4).toLocaleString()} tokens. Each run adds the date and time
          {config.memory.crossSession ? ' and what it remembers about the person' : ''}.
        </p>
        <span title={testable ? 'Chat with the draft' : 'Choose a model and describe the persona first'}>
          <Button size="sm" variant="outline" disabled={!testable} onClick={onTest}>
            <FlaskConical className="size-3.5" /> Try it
          </Button>
        </span>
      </div>
    </section>
  );
}

export function PersonaTab({
  agent,
  config,
  update,
  nextVersion,
  testable,
  onTest,
}: {
  agent: Agent;
  config: AgentConfig;
  update: UpdateConfig;
  nextVersion: number;
  testable: boolean;
  onTest: () => void;
}) {
  const persona = config.persona ?? {};
  const set = (patch: Partial<AgentPersona>) => update((c) => ({ ...c, persona: { ...c.persona, ...patch } }));
  const languages = persona.language && !LANGUAGES.includes(persona.language) ? [persona.language, ...LANGUAGES] : LANGUAGES;
  // An agent written before personas: its whole prompt is the instructions, at the bottom of the tab.
  const instructionsOnly = !cleanPersona(config.persona) && Boolean(config.instructions.trim());
  const toInstructions = () => {
    document.getElementById('section-instructions')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('agent-instructions')?.focus({ preventScroll: true });
  };

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
      <div className="min-w-0 space-y-4">
        {instructionsOnly && (
          <div className="flex items-start gap-2.5 rounded-xl border border-hair bg-wl px-3.5 py-3 text-[12px] leading-snug text-t2 animate-fade-up">
            <Info className="mt-px size-3.5 shrink-0 text-t3" />
            <p>
              This agent’s prompt is its{' '}
              <button type="button" onClick={toInstructions} className="font-semibold text-t1 underline-offset-2 hover:underline">
                instructions
              </button>
              , at the bottom. Fill in the parts below to give it a role, a voice and rules; the instructions stay, after them.
            </p>
          </div>
        )}
        <div id="section-persona" className="scroll-mt-20">
          <Section icon={<UserRound className="size-4" />} title="Who it is" description="What the agent is, who it helps and what it does for them.">
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="persona-name" label="Name">
                  <Input
                    id="persona-name"
                    value={config.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      update((c) => ({ ...c, name }));
                    }}
                    onBlur={() => !config.name.trim() && update((c) => ({ ...c, name: 'Untitled agent' }))}
                  />
                </Field>
                <Field id="persona-role" label="Role">
                  <Input id="persona-role" value={persona.role ?? ''} placeholder="Editor for the docs team" onChange={(e) => set({ role: e.target.value })} />
                </Field>
              </div>
              <Field id="persona-audience" label="Who it helps">
                <Input id="persona-audience" value={persona.audience ?? ''} placeholder="Technical writers with rough drafts" onChange={(e) => set({ audience: e.target.value })} />
              </Field>
              <Field id="persona-mission" label="What it does">
                <AutoTextarea
                  id="persona-mission"
                  rows={2}
                  value={persona.mission ?? ''}
                  placeholder="Turns notes into clean Markdown and keeps the author’s meaning."
                  onChange={(e) => set({ mission: e.target.value })}
                />
              </Field>
              <Field label="What I do" hint="Up to three short lines for its card on a team page. Left empty, they come from what it does. Not part of the prompt.">
                <div className="space-y-1.5">
                  {[0, 1, 2].map((i) => (
                    <Input
                      key={i}
                      id={`persona-whatido-${i}`}
                      aria-label={`What I do, line ${i + 1}`}
                      maxLength={120}
                      value={persona.whatIDo?.[i] ?? ''}
                      placeholder={['Reviews every pull request', 'Flags risky changes', 'Explains what it found'][i]}
                      onChange={(e) => set({ whatIDo: [0, 1, 2].map((j) => (j === i ? e.target.value : persona.whatIDo?.[j] ?? '')) })}
                    />
                  ))}
                </div>
              </Field>
              <Field id="persona-description" label="Description" hint="Shown in the agent list and to agents that delegate to this one; it also closes the prompt.">
                <Input
                  id="persona-description"
                  value={config.description}
                  placeholder="Tidies drafts for the docs team"
                  onChange={(e) => {
                    const description = e.target.value;
                    update((c) => ({ ...c, description }));
                  }}
                  onBlur={() => config.description !== config.description.trim() && update((c) => ({ ...c, description: c.description.trim() }))}
                />
              </Field>
            </div>
          </Section>
        </div>

        <Section icon={<AudioLines className="size-4" />} title="Voice" description="How it sounds and how much it says.">
          <div className="space-y-4">
            <Field id="persona-tone" label="Tone">
              <TonePicker tones={persona.tones ?? []} onChange={(tones) => set({ tones })} />
            </Field>
            <Field label="Answer length" hint="Pick the selected one again to leave it to the model.">
              <div id="persona-length" role="radiogroup" aria-label="Answer length" className="inline-flex flex-wrap rounded-[10px] border border-hair bg-wl p-0.5">
                {ANSWER_LENGTHS.map((l) => {
                  const on = persona.length === l.value;
                  return (
                    <button
                      key={l.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => set({ length: on ? undefined : l.value })}
                      className={cn('h-7 rounded-[8px] px-3 text-[12px] transition-colors', on ? 'bg-sf font-semibold text-t1 shadow-sm' : 'text-t2 hover:text-t1')}
                    >
                      {l.label}
                    </button>
                  );
                })}
              </div>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="persona-language" label="Language">
                <Select id="persona-language" value={persona.language ?? ''} onChange={(e) => set({ language: e.target.value || undefined })}>
                  <option value="">The one it’s written to in</option>
                  {languages.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="persona-signoff" label="Sign-off" hint="A line it ends every answer with.">
                <Input id="persona-signoff" value={persona.signoff ?? ''} placeholder={`— your ${config.name || 'agent'}`} onChange={(e) => set({ signoff: e.target.value })} />
              </Field>
            </div>
          </div>
        </Section>

        <Section icon={<ListChecks className="size-4" />} title="Rules" description="What it always does and never does, a sentence each.">
          <div className="grid gap-4 sm:grid-cols-2">
            <RuleList id="persona-always" label="Always" placeholder="Keep the author’s meaning" rules={persona.always ?? []} onChange={(always) => set({ always })} />
            <RuleList id="persona-never" label="Never" placeholder="Invent facts or quotes" rules={persona.never ?? []} onChange={(never) => set({ never })} />
          </div>
        </Section>

        <Section icon={<MessagesSquare className="size-4" />} title="Examples" description="A message and the answer you’d want. Models follow the style of examples closely.">
          <ExampleList examples={persona.examples ?? []} onChange={(examples) => set({ examples })} />
        </Section>

        <div id="section-instructions" className="scroll-mt-20">
        <Section icon={<NotebookPen className="size-4" />} title="Instructions" description="Anything the parts above don’t cover, in your own words. They come after them in the prompt.">
          <AutoTextarea
            id="agent-instructions"
            aria-label="Instructions"
            rows={4}
            value={config.instructions}
            onChange={(e) => {
              const instructions = e.target.value;
              update((c) => ({ ...c, instructions }));
            }}
            placeholder="When a draft has no title, suggest three."
            className="min-h-[96px]"
          />
        </Section>
        </div>
      </div>

      <PromptPreview agent={agent} config={config} nextVersion={nextVersion} testable={testable} onTest={onTest} />
    </div>
  );
}
