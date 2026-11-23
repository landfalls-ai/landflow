'use client';
/**
 * New practice and Edit (docs/practices.md): both save a draft that an admin approves before any agent follows it. The form
 * checks what the API checks (limits, handle, topic and repository patterns) before it sends. Editing keeps the handle,
 * level and project, and makes a new version from the form's text.
 */
import { useId, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { ApiError } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { PRACTICE_LEVELS, PRACTICE_LEVEL_LABELS, PRACTICE_LIMITS, PRACTICE_STRENGTHS, PRACTICE_STRENGTH_LABELS, PRACTICE_TOPICS, type PracticeCheck, type PracticeDetailResponse, type PracticeView } from '@/lib/shared/practices';
import { projectLabel, useProjects, writableProjects } from '../../projects/use-projects';
import { FilterChip } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Dialog, Field } from '../../ui/dialog';
import { Input, Select, Textarea } from '../../ui/inputs';
import { draftPractice, editPractice } from './practices-api';
import { draftInput, editBase, editInput, emptyCheck, emptyForm, formFrom, validatePracticeForm, type CheckRow, type FormErrors, type PracticeFormValues } from './practices-logic';

const CHECK_KINDS: Array<{ kind: PracticeCheck['kind']; label: string }> = [
  { kind: 'pathExists', label: 'A file must exist' },
  { kind: 'pathAbsent', label: 'No file may exist' },
  { kind: 'fileMatches', label: 'Files must contain text' },
];

const Error_ = ({ text }: { text?: string }) => (text ? <p className="mt-1 text-[12px] text-rd">{text}</p> : null);

/** `editing`: the practice and its newest version; without it, a new practice. */
export function PracticeForm({ editing, onClose, onSaved }: { editing?: PracticeDetailResponse; onClose: () => void; onSaved: (practice: PracticeView) => void }) {
  const newest = editing ? editBase(editing.versions) : undefined;
  const [values, setValues] = useState<PracticeFormValues>(() => (editing && newest ? formFrom(editing.practice, newest) : emptyForm()));
  const [tag, setTag] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const { projects } = useProjects();
  const drafting = writableProjects(projects);
  const id = useId();
  const errors: FormErrors = validatePracticeForm(values, { editing: Boolean(editing) });
  const shown = sent ? errors : {};
  const set = <K extends keyof PracticeFormValues>(key: K, value: PracticeFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const setCheck = (i: number, patch: Partial<CheckRow>) => set('checks', values.checks.map((c, at) => (at === i ? { ...c, ...patch } : c)));
  const toggleTopic = (topic: string) => set('topics', values.topics.includes(topic) ? values.topics.filter((t) => t !== topic) : [...values.topics, topic]);
  const addTag = () => {
    const next = tag.trim().toLowerCase();
    if (next && !values.topics.includes(next)) set('topics', [...values.topics, next]);
    setTag('');
  };
  const free = values.topics.filter((t) => !(PRACTICE_TOPICS as readonly string[]).includes(t));

  const save = async () => {
    setSent(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const { practice } = editing ? await editPractice(editing.practice.id, editInput(values)) : await draftPractice(draftInput(values));
      onSaved(practice);
    } catch (e) {
      setProblem(e instanceof ApiError && (e.body as { code?: string } | undefined)?.code === 'practice_handle_taken' ? 'That handle is taken at this level. Choose another.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const approvers = values.level === 'org' ? 'an owner or admin of this instance' : 'an admin of the project';
  return (
    <Dialog
      title={editing ? `Edit ${editing.practice.handle}` : 'New practice'}
      subtitle={`This saves a draft. ${approvers.charAt(0).toUpperCase()}${approvers.slice(1)} approves it before any agent follows it.`}
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {editing ? 'Save as a new draft' : 'Save draft'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {problem && (
          <p role="alert" className="rounded-lg border border-rdbd bg-rddim px-3 py-2 text-[12.5px] text-rd">
            {problem}
          </p>
        )}
        {!editing && (
          <>
            <Field id={`${id}-handle`} label="Handle" required hint="Two or three lowercase parts, such as helm/chart-location. It names the practice and never changes.">
              <Input id={`${id}-handle`} value={values.handle} onChange={(e) => set('handle', e.target.value)} placeholder="helm/chart-location" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              <Error_ text={shown.handle} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${id}-level`} label="Level" required hint={values.level === 'org' ? 'Every agent that works for the organization.' : 'Agents that work in one project.'}>
                <Select id={`${id}-level`} value={values.level} onChange={(e) => set('level', e.target.value as PracticeFormValues['level'])}>
                  {PRACTICE_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {PRACTICE_LEVEL_LABELS[l]}
                    </option>
                  ))}
                </Select>
              </Field>
              {values.level === 'project' && (
                <Field id={`${id}-project`} label="Project" required>
                  <Select id={`${id}-project`} value={values.projectId} onChange={(e) => set('projectId', e.target.value)}>
                    <option value="">Choose a project</option>
                    {drafting.map((p) => (
                      <option key={p.id} value={p.id}>
                        {projectLabel(p)}
                      </option>
                    ))}
                  </Select>
                  <Error_ text={shown.projectId} />
                </Field>
              )}
            </div>
          </>
        )}
        <Field id={`${id}-title`} label="Title" required aside={`${values.title.length}/${PRACTICE_LIMITS.title}`}>
          <Input id={`${id}-title`} value={values.title} onChange={(e) => set('title', e.target.value)} placeholder="Charts live in deploy/helm" />
          <Error_ text={shown.title} />
        </Field>
        <Field label="Strength" hint="Required: a failed check stops a flow until someone fixes the change or waives it. Recommended: it is reported and never stops anything.">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Strength">
            {PRACTICE_STRENGTHS.map((s) => (
              <FilterChip key={s} active={values.strength === s} onClick={() => set('strength', s)}>
                {PRACTICE_STRENGTH_LABELS[s]}
              </FilterChip>
            ))}
          </div>
        </Field>
        <Field label="Topics" hint="Pick some or add your own: lowercase letters, digits and dashes.">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Topics">
            {[...PRACTICE_TOPICS, ...free].map((t) => (
              <FilterChip key={t} size="sm" active={values.topics.includes(t)} onClick={() => toggleTopic(t)}>
                {t}
              </FilterChip>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addTag();
                }
              }}
              placeholder="Add a topic"
              aria-label="Add a topic"
              autoCapitalize="none"
            />
            <Button type="button" variant="outline" onClick={addTag} disabled={!tag.trim()}>
              Add
            </Button>
          </div>
          <Error_ text={shown.topics} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${id}-repos`} label="Repositories" hint="owner/name, one per line. Empty: any repository.">
            <Textarea id={`${id}-repos`} rows={3} value={values.repos} onChange={(e) => set('repos', e.target.value)} placeholder="acme/web" spellCheck={false} className="font-mono text-[12.5px]" />
            <Error_ text={shown.repos} />
          </Field>
          <Field id={`${id}-paths`} label="Paths" hint="Globs, one per line, such as deploy/**. Empty: anywhere.">
            <Textarea id={`${id}-paths`} rows={3} value={values.paths} onChange={(e) => set('paths', e.target.value)} placeholder="deploy/**" spellCheck={false} className="font-mono text-[12.5px]" />
            <Error_ text={shown.paths} />
          </Field>
        </div>
        <Field id={`${id}-summary`} label="Summary" required aside={`${values.summary.length}/${PRACTICE_LIMITS.summary}`} hint="The line agents are given. The rules below are read on demand.">
          <Textarea id={`${id}-summary`} rows={2} value={values.summary} onChange={(e) => set('summary', e.target.value)} placeholder="Charts live in deploy/helm/<service>/, one per service." className={cn(values.summary.length > PRACTICE_LIMITS.summary && 'border-rd')} />
          <Error_ text={shown.summary} />
        </Field>
        <Field id={`${id}-body`} label="Rules" aside={`${values.body.length}/${PRACTICE_LIMITS.body}`} hint="Markdown." required>
          <Textarea id={`${id}-body`} rows={7} value={values.body} onChange={(e) => set('body', e.target.value)} spellCheck className="font-mono text-[12.5px]" />
          <Error_ text={shown.body} />
        </Field>
        <Field label="Checks" hint="Optional, run without a model over the files a change touches.">
          <div className="space-y-2">
            {values.checks.map((row, i) => (
              <div key={i} className="space-y-2 rounded-xl border border-hair p-2.5">
                <div className="flex items-center gap-2">
                  <Select aria-label={`Check ${i + 1} kind`} value={row.kind} onChange={(e) => setCheck(i, { kind: e.target.value as CheckRow['kind'] })}>
                    {CHECK_KINDS.map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.label}
                      </option>
                    ))}
                  </Select>
                  <button type="button" onClick={() => set('checks', values.checks.filter((_, at) => at !== i))} aria-label={`Remove check ${i + 1}`} className="grid size-8 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:size-11">
                    <X className="size-4" />
                  </button>
                </div>
                <Input aria-label={`Check ${i + 1} path pattern`} value={row.glob} onChange={(e) => setCheck(i, { glob: e.target.value })} placeholder={row.kind === 'pathExists' ? 'deploy/helm/*/Chart.yaml' : 'Files matching, such as **/*.yaml'} spellCheck={false} className="font-mono text-[12.5px]" />
                {row.kind !== 'fileMatches' && (
                  <Input
                    aria-label={`Check ${i + 1} ${row.kind === 'pathExists' ? 'when' : 'unless'}`}
                    value={row.other}
                    onChange={(e) => setCheck(i, { other: e.target.value })}
                    placeholder={row.kind === 'pathExists' ? 'Only when a changed file matches (optional)' : 'Unless it also matches (optional)'}
                    spellCheck={false}
                    className="font-mono text-[12.5px]"
                  />
                )}
                {row.kind === 'fileMatches' && (
                  <>
                    <Input aria-label={`Check ${i + 1} text`} value={row.pattern} onChange={(e) => setCheck(i, { pattern: e.target.value })} placeholder="Text or pattern to look for" spellCheck={false} className="font-mono text-[12.5px]" />
                    <label className="flex w-fit cursor-pointer items-center gap-2 text-[13px] text-t2 max-md:min-h-11">
                      <input type="checkbox" checked={row.absent} onChange={(e) => setCheck(i, { absent: e.target.checked })} className="size-4 accent-[var(--ac2)]" />
                      It must not appear
                    </label>
                  </>
                )}
              </div>
            ))}
            {values.checks.length < PRACTICE_LIMITS.checks && (
              <Button type="button" variant="outline" size="sm" onClick={() => set('checks', [...values.checks, emptyCheck()])}>
                <Plus className="size-3.5" aria-hidden />
                Add a check
              </Button>
            )}
          </div>
          <Error_ text={shown.checks} />
        </Field>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
