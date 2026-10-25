'use client';
/**
 * Workflow settings (n8n's Workflow settings dialog): error workflow, time
 * zone, timeout, which workflows may call this one, and which executions are
 * kept. This dialog only edits and saves `workflow.settings`; the engine and
 * runner apply them.
 */
import { useEffect, useMemo, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import type { WorkflowSettings, WorkflowSummary } from '@/lib/shared/types';
import { Dialog, Field, ToggleRow } from '../agents/dialog';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/inputs';
import { useEditor } from './store';

const ERROR_TRIGGER = 'core.errorTrigger';

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}

export function SettingsDialog({ onClose, onSave }: { onClose: () => void; onSave: () => Promise<boolean> }) {
  const workflowId = useEditor((s) => s.workflowId);
  const [draft, setDraft] = useState<WorkflowSettings>(() => structuredClone(useEditor.getState().settings));
  const [timeout, setTimeoutText] = useState(() => (draft.timeoutSeconds ? String(draft.timeoutSeconds) : ''));
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>();
  const [saving, setSaving] = useState(false);
  const zones = useMemo(timeZones, []);
  const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  useEffect(() => {
    api<{ workflows: WorkflowSummary[] }>('/api/workflows')
      .then(({ workflows: list }) => setWorkflows(list.filter((w) => w.id !== workflowId)))
      .catch(() => setWorkflows([]));
  }, [workflowId]);

  // Workflows with an Error Trigger first: those are the ones that can handle errors.
  const errorTargets = useMemo(
    () => [...(workflows ?? [])].sort((a, b) => Number(b.nodeTypes.includes(ERROR_TRIGGER)) - Number(a.nodeTypes.includes(ERROR_TRIGGER)) || a.name.localeCompare(b.name)),
    [workflows],
  );
  const selectedError = workflows?.find((w) => w.id === draft.errorWorkflowId);
  const timeoutValue = timeout.trim() === '' ? undefined : Number(timeout);
  const timeoutInvalid = timeoutValue !== undefined && (!Number.isInteger(timeoutValue) || timeoutValue < 1 || timeoutValue > 86_400);
  const patch = (next: Partial<WorkflowSettings>) => setDraft((d) => ({ ...d, ...next }));
  const policy = draft.callerPolicy ?? 'any';
  const callers = new Set(draft.callerIds ?? []);

  const save = async () => {
    if (timeoutInvalid) return;
    const settings: WorkflowSettings = { ...draft, timeoutSeconds: timeoutValue };
    // Leave out what is at its default, so the saved document stays small and defaults can change.
    for (const key of Object.keys(settings) as Array<keyof WorkflowSettings>) if (settings[key] === undefined || settings[key] === '') delete settings[key];
    if (settings.callerPolicy !== 'list') delete settings.callerIds;
    if (settings.callerPolicy === 'any') delete settings.callerPolicy;
    for (const key of ['saveSuccessfulExecutions', 'saveFailedExecutions', 'saveManualExecutions'] as const) if (settings[key] === true) delete settings[key];
    useEditor.getState().setSettings(settings);
    setSaving(true);
    const ok = await onSave();
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      title="Workflow settings"
      subtitle={useEditor.getState().name}
      icon={<Settings2 className="size-5 text-t2" />}
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={timeoutInvalid}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          id="wf-error-workflow"
          label="Error workflow"
          hint={
            selectedError && !selectedError.nodeTypes.includes(ERROR_TRIGGER) ? (
              <span className="text-warn">“{selectedError.name}” has no Error Trigger node, so it won’t start when this workflow fails.</span>
            ) : (
              'Runs when an execution of this workflow fails. It needs an Error Trigger node.'
            )
          }
        >
          <Select id="wf-error-workflow" value={draft.errorWorkflowId ?? ''} onChange={(e) => patch({ errorWorkflowId: e.target.value || undefined })}>
            <option value="">No error workflow</option>
            {draft.errorWorkflowId && workflows && !selectedError && <option value={draft.errorWorkflowId}>Deleted workflow ({draft.errorWorkflowId})</option>}
            {errorTargets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.nodeTypes.includes(ERROR_TRIGGER) ? '  ·  Error Trigger' : ''}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field id="wf-timezone" label="Time zone" hint="For schedules and $now in this workflow.">
            <Select id="wf-timezone" value={draft.timezone ?? ''} onChange={(e) => patch({ timezone: e.target.value || undefined })}>
              <option value="">Host default</option>
              {draft.timezone && !zones.includes(draft.timezone) && <option value={draft.timezone}>{draft.timezone}</option>}
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replaceAll('_', ' ')}
                  {zone === browserZone ? '  (this browser)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            id="wf-timeout"
            label="Timeout"
            hint={timeoutInvalid ? <span className="text-rd">A whole number of seconds from 1 to 86400.</span> : 'Stop an execution after this many seconds. Empty: no limit.'}
          >
            <div className="relative">
              <Input
                id="wf-timeout"
                inputMode="numeric"
                value={timeout}
                onChange={(e) => setTimeoutText(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="No timeout"
                className={cn('pr-16', timeoutInvalid && 'border-rd')}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-t3">seconds</span>
            </div>
          </Field>
        </div>

        <Field label="Can be called by" hint="Other workflows that may run this one with Execute Workflow.">
          <div className="flex gap-0.5 rounded-[10px] border border-hair bg-wl p-0.5" role="radiogroup" aria-label="Can be called by">
            {(
              [
                ['any', 'Any workflow'],
                ['none', 'No workflows'],
                ['list', 'Selected workflows'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                role="radio"
                aria-checked={policy === value}
                onClick={() => patch({ callerPolicy: value })}
                className={cn(
                  'h-7 flex-1 rounded-lg border border-transparent text-[12px] text-t2 transition-colors',
                  policy === value && 'border-bd bg-sf font-semibold text-t1 shadow-[0_1px_2px_var(--hair)]',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {policy === 'list' && (
            <div className="mt-2 max-h-[180px] space-y-0.5 overflow-y-auto rounded-[10px] border border-hair p-1">
              {!workflows && <div className="px-2 py-1.5 text-[12px] text-t3">Loading…</div>}
              {workflows?.length === 0 && <div className="px-2 py-1.5 text-[12px] text-t3">No other workflows yet.</div>}
              {workflows?.map((w) => (
                <label key={w.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-[13px] text-t1 hover:bg-acdim">
                  <input
                    type="checkbox"
                    checked={callers.has(w.id)}
                    onChange={(e) => {
                      const next = new Set(callers);
                      if (e.target.checked) next.add(w.id);
                      else next.delete(w.id);
                      patch({ callerIds: [...next] });
                    }}
                    className="accent-[var(--ac)]"
                  />
                  <span className="truncate">{w.name}</span>
                </label>
              ))}
            </div>
          )}
        </Field>

        <div className="space-y-2">
          <div className="text-[12px] font-semibold text-t2">Executions to keep</div>
          <ToggleRow
            title="Successful executions"
            description="Keep successful runs in the history"
            checked={draft.saveSuccessfulExecutions !== false}
            onChange={(v) => patch({ saveSuccessfulExecutions: v })}
          />
          <ToggleRow title="Failed executions" description="Keep runs that ended with an error" checked={draft.saveFailedExecutions !== false} onChange={(v) => patch({ saveFailedExecutions: v })} />
          <ToggleRow
            title="Manual executions"
            description="Keep runs started from the editor"
            checked={draft.saveManualExecutions !== false}
            onChange={(v) => patch({ saveManualExecutions: v })}
          />
        </div>
      </div>
    </Dialog>
  );
}
