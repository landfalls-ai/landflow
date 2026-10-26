'use client';
/**
 * Settings → Variables, per environment (only on an instance with LANDFLOW_ENVIRONMENT): a variable can have a value
 * for each environment. On the instance whose environment has one, `$vars.KEY` reads it instead of the variable's
 * own value; Git sync carries them (variables.json `environments`, with values), so a promotion brings every
 * environment's value along and each instance picks its own. A project's variables have theirs too (`base`: the
 * project's variables route, `values` from its listing).
 */
import { useEffect, useState } from 'react';
import { Check, Layers } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { useEnvironment } from '@/lib/client/environment';
import type { Variable } from '@/lib/shared/platform';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/inputs';

type Values = Record<string, Record<string, string>>;
const NONE: Record<string, string> = {};

function Row({
  variable,
  environments,
  current,
  saved,
  onSaved,
  base,
  canEdit,
}: {
  variable: Variable;
  environments: string[];
  current?: string;
  saved: Record<string, string>;
  onSaved: (v: Record<string, string>) => void;
  base: string;
  canEdit: boolean;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = environments.some((e) => (draft[e] ?? '') !== (saved[e] ?? ''));
  const save = async () => {
    setSaving(true);
    try {
      const values = Object.fromEntries(environments.map((e) => [e, draft[e] ? draft[e] : null]));
      const result = await api<{ values: Record<string, string> }>(`${base}/${encodeURIComponent(variable.key)}/environments`, { method: 'PUT', json: { values } });
      onSaved(result.values);
      toast.success(`Saved the environment values of $vars.${variable.key}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="grid items-center gap-2 border-b border-hair px-4 py-2 last:border-b-0" style={{ gridTemplateColumns: `minmax(0,180px) repeat(${environments.length}, minmax(0,1fr)) 32px` }}>
      <span className="truncate font-mono text-[13px] font-semibold text-t1">{variable.key}</span>
      {environments.map((environment) => (
        <Input
          key={environment}
          value={draft[environment] ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, [environment]: e.target.value }))}
          placeholder={environment === current ? variable.value || '(own value)' : '(own value)'}
          className="h-7 font-mono text-[12px]"
          disabled={!canEdit}
          aria-label={`${variable.key} in ${environment}`}
        />
      ))}
      <Button size="icon-sm" variant={dirty ? 'primary' : 'ghost'} onClick={save} loading={saving} disabled={!dirty} aria-label={`Save ${variable.key}`}>
        {!saving && <Check className="size-3.5" />}
      </Button>
    </div>
  );
}

export function VariableEnvironments({ variables, base = '/api/variables', values: given, canEdit = true }: { variables?: Variable[]; base?: string; values?: Values; canEdit?: boolean }) {
  const environment = useEnvironment();
  const [values, setValues] = useState<Values>();
  useEffect(() => {
    if (!environment?.name) return;
    if (given) return setValues(given);
    api<{ values: Values }>('/api/environment/variables')
      .then((r) => setValues(r.values))
      .catch(() => setValues({}));
  }, [environment?.name, variables, given]);
  if (!environment?.name || !variables?.length || !values) return null;
  const environments = environment.environments.map((e) => e.name);
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center gap-2 border-b border-hair px-4 py-2.5">
        <Layers className="size-4 text-t3" strokeWidth={1.8} />
        <span className="text-[13px] font-semibold text-t1">Values per environment</span>
        <span className="truncate text-[12px] text-t3">
          This instance is {environment.name}: its value is used here when set; empty uses the variable’s own value. Promotion carries them to the other environments.
        </span>
      </div>
      <div className="grid gap-2 border-b border-hair px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3" style={{ gridTemplateColumns: `minmax(0,180px) repeat(${environments.length}, minmax(0,1fr)) 32px` }}>
        <span>Key</span>
        {environments.map((e) => (
          <span key={e} className={e === environment.name ? 'text-ac' : undefined}>
            {e}
          </span>
        ))}
        <span />
      </div>
      {variables.map((variable) => (
        <Row
          key={variable.key}
          variable={variable}
          environments={environments}
          current={environment.name}
          saved={values[variable.key] ?? NONE}
          onSaved={(v) => setValues((all) => ({ ...all, [variable.key]: v }))}
          base={base}
          canEdit={canEdit}
        />
      ))}
    </Card>
  );
}
