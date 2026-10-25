'use client';
/**
 * Workflow settings (n8n's Workflow settings dialog): error workflow, time
 * zone, timeout, which workflows may call this one, which executions are
 * kept, concurrency and automatic retries. This dialog only edits and saves
 * `workflow.settings`; the engine and runner apply them.
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

/** The runner's cap on the wait before an automatic retry: six hours. */
const MAX_RETRY_WAIT_SECONDS = 6 * 3600;

function formatWait(seconds: number) {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${+(seconds / 60).toFixed(1)} min`;
  return `${+(seconds / 3600).toFixed(1)} h`;
}

/** "after 30 s, 1 min and 2 min": the wait before each automatic retry (it doubles, up to six hours). */
function retrySchedule(attempts: number, baseSeconds: number) {
  if (baseSeconds === 0) return 'right away';
  const waits = Array.from({ length: attempts - 1 }, (_, i) => formatWait(Math.min(MAX_RETRY_WAIT_SECONDS, baseSeconds * 2 ** i)));
  return `after ${waits.length > 1 ? `${waits.slice(0, -1).join(', ')} and ${waits.at(-1)}` : waits[0]}`;
}

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
  const [minutes, setMinutesText] = useState(() => (draft.timeSavedMinutes ? String(draft.timeSavedMinutes) : ''));
  const [limit, setLimitText] = useState(() => (draft.concurrencyLimit ? String(draft.concurrencyLimit) : ''));
  const [queueSize, setQueueSizeText] = useState(() => (draft.concurrencyQueueSize ? String(draft.concurrencyQueueSize) : ''));
  const [attempts, setAttemptsText] = useState(() => (draft.retryMaxAttempts ? String(draft.retryMaxAttempts) : ''));
  const [retryDelay, setRetryDelayText] = useState(() => (draft.retryBaseDelaySeconds !== undefined ? String(draft.retryBaseDelaySeconds) : ''));
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
  const minutesValue = minutes.trim() === '' ? undefined : Number(minutes);
  const minutesInvalid = minutesValue !== undefined && (!Number.isFinite(minutesValue) || minutesValue < 0 || minutesValue > 100_000);
  const intIn = (value: number | undefined, min: number, max: number) => value !== undefined && (!Number.isInteger(value) || value < min || value > max);
  const limitValue = limit.trim() === '' ? undefined : Number(limit);
  const limitInvalid = intIn(limitValue, 0, 1000);
  // A limit or the singleton: trigger runs beyond it queue (default) or are skipped.
  const limited = Boolean(limitValue) || Boolean(draft.singleton);
  const overflow = draft.concurrencyOverflow ?? 'queue';
  const queueSizeValue = queueSize.trim() === '' ? undefined : Number(queueSize);
  const queueSizeInvalid = limited && overflow === 'queue' && intIn(queueSizeValue, 1, 10_000);
  const attemptsValue = attempts.trim() === '' ? undefined : Number(attempts);
  const attemptsInvalid = intIn(attemptsValue, 1, 10);
  const retriesOn = !attemptsInvalid && (attemptsValue ?? 0) >= 2;
  const retryDelayValue = retryDelay.trim() === '' ? undefined : Number(retryDelay);
  const retryDelayInvalid = retriesOn && intIn(retryDelayValue, 0, 86_400);
  const invalid = timeoutInvalid || minutesInvalid || limitInvalid || queueSizeInvalid || attemptsInvalid || retryDelayInvalid;
  const patch = (next: Partial<WorkflowSettings>) => setDraft((d) => ({ ...d, ...next }));
  const policy = draft.callerPolicy ?? 'any';
  const callers = new Set(draft.callerIds ?? []);

  const save = async () => {
    if (invalid) return;
    const settings: WorkflowSettings = {
      ...draft,
      timeoutSeconds: timeoutValue,
      timeSavedMinutes: minutesValue || undefined,
      concurrencyLimit: limitValue || undefined,
      singleton: draft.singleton || undefined,
      concurrencyQueueSize: queueSizeValue,
      // One attempt (the run itself) is no retries.
      retryMaxAttempts: retriesOn ? attemptsValue : undefined,
      retryBaseDelaySeconds: retryDelayValue,
    };
    // Leave out what is at its default, so the saved document stays small and defaults can change.
    for (const key of Object.keys(settings) as Array<keyof WorkflowSettings>) if (settings[key] === undefined || settings[key] === '') delete settings[key];
    if (settings.callerPolicy !== 'list') delete settings.callerIds;
    if (settings.callerPolicy === 'any') delete settings.callerPolicy;
    for (const key of ['saveSuccessfulExecutions', 'saveFailedExecutions', 'saveManualExecutions'] as const) if (settings[key] === true) delete settings[key];
    if (!settings.concurrencyLimit && !settings.singleton) delete settings.concurrencyOverflow;
    if (settings.concurrencyOverflow === 'queue') delete settings.concurrencyOverflow;
    if (!limited || settings.concurrencyOverflow === 'skip') delete settings.concurrencyQueueSize;
    if (!settings.retryMaxAttempts) delete settings.retryBaseDelaySeconds;
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
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={invalid}>
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
              <option value="">Instance default (Settings)</option>
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

        <Field
          id="wf-time-saved"
          label="Time saved per run"
          hint={
            minutesInvalid ? (
              <span className="text-rd">A number of minutes from 0 to 100000.</span>
            ) : (
              'Manual work one successful run replaces. Insights adds it up as time saved.'
            )
          }
        >
          <div className="relative w-1/2 pr-1.5">
            <Input
              id="wf-time-saved"
              inputMode="decimal"
              value={minutes}
              onChange={(e) => setMinutesText(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="Not set"
              className={cn('pr-16', minutesInvalid && 'border-rd')}
            />
            <span className="pointer-events-none absolute right-4.5 top-1/2 -translate-y-1/2 text-[12px] text-t3">minutes</span>
          </div>
        </Field>

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

        <div className="space-y-2">
          <div className="text-[12px] font-semibold text-t2">Concurrency</div>
          <Field
            id="wf-concurrency-limit"
            label="Concurrency limit"
            hint={
              limitInvalid ? (
                <span className="text-rd">A whole number of runs from 0 to 1000.</span>
              ) : draft.singleton ? (
                'The singleton below allows one run at a time.'
              ) : (
                'Production runs (webhooks, forms, schedules, polls, tool calls) going at once. Empty or 0: no limit. Runs from the editor always start.'
              )
            }
          >
            <div className="relative w-1/2 pr-1.5">
              <Input
                id="wf-concurrency-limit"
                inputMode="numeric"
                value={limit}
                onChange={(e) => setLimitText(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="No limit"
                disabled={draft.singleton}
                className={cn('pr-12 disabled:opacity-50', limitInvalid && 'border-rd')}
              />
              <span className="pointer-events-none absolute right-4.5 top-1/2 -translate-y-1/2 text-[12px] text-t3">runs</span>
            </div>
          </Field>
          <ToggleRow
            title="Run one at a time (singleton)"
            description="A production run starts only when no other is running or waiting"
            checked={Boolean(draft.singleton)}
            onChange={(v) => patch({ singleton: v || undefined })}
          />
          {limited && (
            <div className="grid grid-cols-2 gap-3 animate-in">
              <Field
                id="wf-concurrency-overflow"
                label="When busy"
                hint={overflow === 'skip' ? 'The run is dropped; webhooks answer 429 Too Many Requests.' : 'The run waits its turn, first in, first out.'}
              >
                <Select id="wf-concurrency-overflow" value={overflow} onChange={(e) => patch({ concurrencyOverflow: e.target.value as 'queue' | 'skip' })}>
                  <option value="queue">Queue the run</option>
                  <option value="skip">Skip the run</option>
                </Select>
              </Field>
              {overflow === 'queue' && (
                <Field
                  id="wf-queue-size"
                  label="Queue size"
                  hint={queueSizeInvalid ? <span className="text-rd">A whole number from 1 to 10000.</span> : 'Runs that can wait at once. Runs beyond it are skipped.'}
                >
                  <div className="relative">
                    <Input
                      id="wf-queue-size"
                      inputMode="numeric"
                      value={queueSize}
                      onChange={(e) => setQueueSizeText(e.target.value.replace(/[^\d]/g, ''))}
                      placeholder="100"
                      className={cn('pr-12', queueSizeInvalid && 'border-rd')}
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-t3">runs</span>
                  </div>
                </Field>
              )}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="text-[12px] font-semibold text-t2">Automatic retries</div>
          <div className="grid grid-cols-2 gap-3">
            <Field
              id="wf-retry-attempts"
              label="Max attempts"
              hint={attemptsInvalid ? <span className="text-rd">A whole number from 1 to 10.</span> : 'In all, the first run included. Empty or 1: no retries.'}
            >
              <div className="relative">
                <Input
                  id="wf-retry-attempts"
                  inputMode="numeric"
                  value={attempts}
                  onChange={(e) => setAttemptsText(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="No retries"
                  className={cn('pr-20', attemptsInvalid && 'border-rd')}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-t3">attempts</span>
              </div>
            </Field>
            <Field
              id="wf-retry-delay"
              label="Base delay"
              hint={retryDelayInvalid ? <span className="text-rd">A whole number of seconds from 0 to 86400.</span> : 'Before the first retry. It doubles for each further one, up to 6 h.'}
            >
              <div className="relative">
                <Input
                  id="wf-retry-delay"
                  inputMode="numeric"
                  value={retryDelay}
                  onChange={(e) => setRetryDelayText(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="30"
                  disabled={!retriesOn}
                  className={cn('pr-16 disabled:opacity-50', retryDelayInvalid && 'border-rd')}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-t3">seconds</span>
              </div>
            </Field>
          </div>
          <p className="text-[12px] leading-snug text-t3">
            {retriesOn && attemptsValue && !retryDelayInvalid && (
              <>
                A failed run is retried {attemptsValue - 1} time{attemptsValue === 2 ? '' : 's'}, {retrySchedule(attemptsValue, retryDelayValue ?? 30)}.{' '}
              </>
            )}
            Only production runs (webhooks, forms, schedules, polls, tool calls) are retried, never runs started from the editor or chat. Each retry is a new execution linked to the one that failed.
          </p>
        </div>
      </div>
    </Dialog>
  );
}
