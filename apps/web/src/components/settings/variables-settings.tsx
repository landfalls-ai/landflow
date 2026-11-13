'use client';
/**
 * Settings → Variables: create, edit, rename and delete the instance's variables, which expressions read as
 * `{{ $vars.KEY }}`, or (the scope picker; a project's Variables tab) a project's: its workflows read those first, then
 * the instance's. The instance's are changed by owners and admins, a project's by its editors and admins.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Braces, Check, Copy, Pencil, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import type { Variable } from '@/lib/shared/platform';
import { can } from '@/lib/shared/auth';
import { useViewer } from '@/components/auth/viewer';
import { projectLabel, useProjects } from '@/components/projects/use-projects';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, SearchInput, Select } from '@/components/ui/inputs';
import { VariableEnvironments } from './variable-environments';

/** GET /api/projects/<id>/variables */
interface ProjectVariables {
  variables: Variable[];
  environments: Record<string, Record<string, string>>;
  canEdit: boolean;
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function keyProblem(key: string, existing: Variable[], current?: string): string | undefined {
  if (!key) return 'Enter a key';
  if (!KEY.test(key)) return 'Letters, digits and _ only; not starting with a digit';
  if (key.length > 64) return 'At most 64 characters';
  if (key !== current && existing.some((v) => v.key === key)) return 'That key exists already';
  return undefined;
}

/** One row being edited (or the new-variable row). */
function Editor({ initial, existing, onSave, onCancel }: { initial?: Variable; existing: Variable[]; onSave: (v: Variable) => Promise<void>; onCancel: () => void }) {
  const [key, setKey] = useState(initial?.key ?? '');
  const [value, setValue] = useState(initial?.value ?? '');
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  useEffect(() => keyInput.current?.focus(), []);
  const problem = keyProblem(key.trim(), existing, initial?.key);

  const submit = async () => {
    setTouched(true);
    if (problem) return;
    setSaving(true);
    try {
      await onSave({ key: key.trim(), value });
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') onCancel();
  };

  return (
    <div className="grid grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto] items-start gap-2 border-b border-hair bg-sf2 px-4 py-2.5 last:border-b-0 animate-fade-up">
      <div>
        <Input ref={keyInput} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={onKeyDown} onBlur={() => setTouched(true)} placeholder="API_BASE_URL" className={cn('font-mono', touched && problem && 'border-rd')} aria-label="Key" />
        {touched && problem && <div className="mt-1 text-[11px] text-rd">{problem}</div>}
      </div>
      <Input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown} placeholder="Value" className="font-mono" aria-label="Value" />
      <div className="flex items-center gap-1">
        <Button size="icon" variant="primary" onClick={submit} loading={saving} aria-label="Save variable" title="Save (Enter)">
          {!saving && <Check className="size-4" />}
        </Button>
        <Button size="icon" variant="ghost" onClick={onCancel} aria-label="Cancel" title="Cancel (Esc)">
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** `projectId`: a project's variables only (its Variables tab); else the instance's, with a picker for a project's. */
export function VariablesSettings({ projectId }: { projectId?: string }) {
  const viewer = useViewer();
  const { projects } = useProjects();
  const [scope, setScope] = useState(projectId ?? '');
  const [list, setList] = useState<Variable[]>();
  const [envValues, setEnvValues] = useState<ProjectVariables['environments']>();
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [confirm, setConfirm] = useState<string>();
  const [query, setQuery] = useState('');
  const base = scope ? `/api/projects/${encodeURIComponent(scope)}/variables` : '/api/variables';
  const project = projects?.find((p) => p.id === scope);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      if (scope) {
        const result = await api<ProjectVariables>(`/api/projects/${encodeURIComponent(scope)}/variables`);
        setList(result.variables);
        setEnvValues(result.environments);
        setCanEdit(result.canEdit);
      } else {
        setList(await api<Variable[]>('/api/variables'));
        setEnvValues(undefined);
        setCanEdit(can(viewer, 'variables:manage'));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [scope, viewer]);
  useEffect(() => {
    setList(undefined);
    setEditing(null);
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list ?? []).filter((v) => !q || v.key.toLowerCase().includes(q) || v.value.toLowerCase().includes(q));
  }, [list, query]);

  const create = async (variable: Variable) => {
    try {
      await api(base, { method: 'POST', json: variable });
      toast.success(`Added $vars.${variable.key}`);
      setEditing(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const update = async (key: string, variable: Variable) => {
    try {
      await api(`${base}/${encodeURIComponent(key)}`, { method: 'PATCH', json: variable });
      toast.success(variable.key === key ? `Saved $vars.${key}` : `Renamed to $vars.${variable.key}`);
      setEditing(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const remove = async (key: string) => {
    try {
      await api(`${base}/${encodeURIComponent(key)}`, { method: 'DELETE' });
      toast.success(`Deleted $vars.${key}`);
      setConfirm(undefined);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const copy = (key: string) => {
    void navigator.clipboard?.writeText(`{{ $vars.${key} }}`).then(
      () => toast.success(`Copied {{ $vars.${key} }}`),
      () => toast.error('Could not copy'),
    );
  };

  return (
    <div className="space-y-3">
      {!projectId && (projects?.length ?? 0) > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-t3">Variables of</span>
          <div className="w-64">
            <Select className="h-8" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Variables of">
              <option value="">The whole instance</option>
              {projects?.map((p) => (
                <option key={p.id} value={p.id}>
                  {projectLabel(p, viewer?.id)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] text-t2">
          {scope ? (
            <>
              Values for the expressions of {project ? `the “${projectLabel(project, viewer?.id)}” project’s` : 'this project’s'} workflows:{' '}
              <code className="rounded bg-acdim px-1.5 py-0.5 font-mono text-[12px] text-t1">{'{{ $vars.KEY }}'}</code> reads a project variable first, then the instance’s of the same key. Not
              encrypted: keep secrets in Credentials.
            </>
          ) : (
            <>
              Instance-wide values for expressions: <code className="rounded bg-acdim px-1.5 py-0.5 font-mono text-[12px] text-t1">{'{{ $vars.KEY }}'}</code>. Values are strings and
              read-only in workflows; a run sees the values at the time it starts; a project’s own variable of the same key wins in its workflows. Not encrypted: keep secrets in Credentials.
            </>
          )}
        </p>
        {(list?.length ?? 0) > 6 && (
          <SearchInput value={query} onChange={setQuery} placeholder="Search variables" className="w-56" />
        )}
        {canEdit && (
          <Button variant="primary" size="sm" onClick={() => setEditing('new')} disabled={editing === 'new'}>
            <Plus className="size-3.5" /> Add variable
          </Button>
        )}
      </div>

      {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}

      <Card className="overflow-hidden p-0">
        <div className="grid grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto] gap-2 border-b border-hair px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
          <span>Key</span>
          <span>Value</span>
          <span className="w-[92px]" />
        </div>
        {editing === 'new' && list && <Editor existing={list} onSave={create} onCancel={() => setEditing(null)} />}
        {!list && !error && <div className="m-4 h-4 w-2/3 rounded bg-acdim animate-pulse-soft" />}
        {shown.map((variable) =>
          editing === variable.key ? (
            <Editor key={variable.key} initial={variable} existing={list ?? []} onSave={(next) => update(variable.key, next)} onCancel={() => setEditing(null)} />
          ) : (
            <div key={variable.key} className="group grid grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto] items-center gap-2 border-b border-hair px-4 py-2.5 last:border-b-0 hover:bg-sf2">
              <button onClick={() => copy(variable.key)} title="Copy as an expression" className="flex min-w-0 items-center gap-1.5 text-left font-mono text-[13px] font-semibold text-t1 hover:text-ac">
                <span className="truncate">{variable.key}</span>
                <Copy className="size-3 shrink-0 text-t3 opacity-0 transition group-hover:opacity-100" />
              </button>
              <span className={cn('truncate font-mono text-[12px]', variable.value ? 'text-t2' : 'italic text-t3')} title={variable.value}>
                {variable.value || 'empty'}
              </span>
              <div className="flex w-[92px] items-center justify-end gap-1">
                {confirm === variable.key ? (
                  <span role="alertdialog" aria-label={`Delete ${variable.key}?`} className="flex items-center gap-1 animate-fade-up">
                    <Button size="sm" variant="danger" onClick={() => remove(variable.key)}>
                      Delete
                    </Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(undefined)} aria-label="Keep">
                      <X className="size-3.5" />
                    </Button>
                  </span>
                ) : (
                  canEdit && (
                    <>
                      <Button size="icon-sm" variant="ghost" onClick={() => setEditing(variable.key)} aria-label={`Edit ${variable.key}`} title="Edit">
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(variable.key)} aria-label={`Delete ${variable.key}`} title="Delete">
                        <Trash2 className="size-3.5" />
                      </Button>
                    </>
                  )
                )}
              </div>
            </div>
          ),
        )}
        {list && list.length === 0 && editing !== 'new' && (
          <EmptyState
            className="py-8"
            title="No variables yet"
            hint={
              scope
                ? 'Give this project’s workflows their own value of a key (a base URL, a team name), or keys only they use.'
                : 'Store a base URL, an environment name or a shared limit once and use it in any workflow as $vars.NAME.'
            }
            action={
              canEdit && (
                <Button variant="primary" onClick={() => setEditing('new')}>
                  <Braces className="size-3.5" /> Add your first variable
                </Button>
              )
            }
          />
        )}
        {list && list.length > 0 && !shown.length && <EmptyState compact className="py-6" title="No variable matches" />}
      </Card>
      <VariableEnvironments variables={list} base={base} values={envValues} canEdit={canEdit} />
    </div>
  );
}
