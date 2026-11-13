'use client';
/**
 * Workflow settings (n8n's Workflow settings dialog): error workflow, time
 * zone, timeout, which workflows may call this one, which executions are
 * kept, concurrency, automatic retries, AI usage limits, Run Trace and transport overrides. This dialog only edits and saves
 * `workflow.settings`; the engine and runner apply them. Its Governance section (four-eyes publishing, allowed nodes)
 * is the workflow's policy, saved on its own route first (./workflow-governance.tsx).
 */
import { useEffect, useMemo, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { RUN_PROFILES, type RunProfile } from '@/lib/shared/run-profiles';
import type { PluginSummary, WorkflowSettings, WorkflowSummary } from '@/lib/shared/types';
import { transportLabel, type TransportObjective, type TransportPolicy, type WorkflowTransportOverride } from '@/lib/shared/transports';
import { Dialog, Field, ToggleRow } from '../agents/dialog';
import { Button } from '../ui/button';
import { Input, Select, Textarea } from '../ui/inputs';
import { NotifyOnFailure } from './notify-on-failure';
import { useEditor } from './store';
import { useWorkflowGovernance, WorkflowGovernanceSection } from './workflow-governance';

const ERROR_TRIGGER = 'core.errorTrigger';

/** Workflow settings → AI usage limits (lib/server/ai-usage): token and cost caps per execution and per day. */
const AI_LIMITS = [
  { key: 'aiMaxTokensPerExecution', label: 'Tokens per execution', unit: 'tokens', cost: false },
  { key: 'aiMaxCostPerExecution', label: 'Cost per execution', unit: 'USD', cost: true },
  { key: 'aiMaxTokensPerDay', label: 'Tokens per day', unit: 'tokens', cost: false },
  { key: 'aiMaxCostPerDay', label: 'Cost per day', unit: 'USD', cost: true },
] as const;
type AiLimitKey = (typeof AI_LIMITS)[number]['key'];

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

const OBJECTIVE_LABELS: Record<TransportObjective, string> = { balanced: 'balanced', latency: 'lowest latency', throughput: 'throughput' };

function policyText(policy: TransportPolicy | undefined): string {
  if (!policy) return 'Auto, balanced';
  if (policy.mode === 'pinned' && policy.pinned) return `always ${transportLabel(policy.pinned)}`;
  return `Auto, ${OBJECTIVE_LABELS[policy.objective]}${policy.allowed?.length ? ` over ${policy.allowed.map(transportLabel).join(', ')}` : ''}`;
}

/** An override as the picker shows it: '' (the plugin's policy), `auto:<objective>`, `pin:<kind>`, or `custom` (an allow-list set through the API). */
function overrideChoice(override: WorkflowTransportOverride | undefined): string {
  if (!override) return '';
  if (override.allowed) return 'custom';
  if (override.mode === 'pinned' || (!override.mode && override.pinned)) return `pin:${override.pinned}`;
  return `auto:${override.objective ?? 'balanced'}`;
}

/**
 * Workflow settings → Transports: per plugin this workflow uses, the plugin's own policy (Settings → Plugins) or this
 * workflow's override of it for its runs (settings `transports`; the host's withWorkflowOverride). Pins only offer the
 * kinds the plugin's allow-list keeps, since an override can't widen it.
 */
function TransportOverrides({ plugins, value, onChange }: { plugins: PluginSummary[]; value: WorkflowSettings['transports']; onChange: (next: WorkflowSettings['transports']) => void }) {
  const set = (pluginId: string, choice: string) => {
    const next = { ...value };
    if (!choice) delete next[pluginId];
    else if (choice.startsWith('pin:')) next[pluginId] = { mode: 'pinned', pinned: choice.slice(4) };
    else if (choice.startsWith('auto:')) next[pluginId] = { mode: 'auto', objective: choice.slice(5) as TransportObjective };
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="space-y-2">
      <div className="text-[12px] font-semibold text-t2">Transports</div>
      {plugins.map((plugin) => {
        const allowed = plugin.policy?.allowed;
        const kinds = (plugin.transports ?? []).map((t) => t.kind).filter((kind) => !allowed || allowed.includes(kind));
        const choice = overrideChoice(value?.[plugin.id]);
        return (
          <Field key={plugin.id} id={`wf-transport-${plugin.id}`} label={plugin.info.name}>
            <Select id={`wf-transport-${plugin.id}`} value={choice} onChange={(e) => set(plugin.id, e.target.value)}>
              <option value="">Plugin&apos;s policy ({policyText(plugin.policy)})</option>
              {(Object.keys(OBJECTIVE_LABELS) as TransportObjective[]).map((objective) => (
                <option key={objective} value={`auto:${objective}`}>
                  Auto, {OBJECTIVE_LABELS[objective]}
                </option>
              ))}
              {kinds.map((kind) => (
                <option key={kind} value={`pin:${kind}`}>
                  Always {transportLabel(kind)}
                </option>
              ))}
              {choice === 'custom' && <option value="custom">Custom (set through the API)</option>}
            </Select>
          </Field>
        );
      })}
      <p className="text-[12px] leading-snug text-t3">
        How this workflow&apos;s runs reach each plugin it uses. An override replaces the plugin&apos;s policy for these runs only; the plugin&apos;s allow-list still applies. The editor&apos;s pickers and other workflows keep the plugin&apos;s policy.
      </p>
    </div>
  );
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
  const [aiLimits, setAiLimits] = useState<Record<AiLimitKey, string>>(
    () => Object.fromEntries(AI_LIMITS.map(({ key }) => [key, draft[key] ? String(draft[key]) : ''])) as Record<AiLimitKey, string>,
  );
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>();
  const [plugins, setPlugins] = useState<PluginSummary[]>();
  const nodeTypes = useEditor((s) => s.nodes.map((n) => n.data.wf.type).join('\n'));
  const [saving, setSaving] = useState(false);
  const governance = useWorkflowGovernance(workflowId);
  const zones = useMemo(timeZones, []);
  const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  useEffect(() => {
    api<{ workflows: WorkflowSummary[] }>('/api/workflows')
      .then(({ workflows: list }) => setWorkflows(list.filter((w) => w.id !== workflowId)))
      .catch(() => setWorkflows([]));
  }, [workflowId]);

  useEffect(() => {
    api<{ plugins: PluginSummary[] }>('/api/plugins')
      .then(({ plugins: list }) => setPlugins(list))
      .catch(() => setPlugins([]));
  }, []);
  // The out-of-process plugins the workflow's nodes use (in-process core nodes have no transport), and any with an override already.
  const transportPlugins = useMemo(() => {
    const ids = new Set([...nodeTypes.split('\n').map((type) => type.slice(0, type.indexOf('.'))), ...Object.keys(draft.transports ?? {})]);
    return (plugins ?? []).filter((p) => ids.has(p.id) && p.transports);
  }, [plugins, nodeTypes, draft.transports]);

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
  const aiLimitValue = (key: AiLimitKey) => (aiLimits[key].trim() === '' ? undefined : Number(aiLimits[key]));
  const aiLimitInvalid = (key: AiLimitKey, cost: boolean) => {
    const value = aiLimitValue(key);
    return value !== undefined && (cost ? !Number.isFinite(value) || value < 0 || value > 1_000_000 : intIn(value, 0, 1_000_000_000));
  };
  const aiLimitsInvalid = AI_LIMITS.some(({ key, cost }) => aiLimitInvalid(key, cost));
  const invalid = timeoutInvalid || minutesInvalid || limitInvalid || queueSizeInvalid || attemptsInvalid || retryDelayInvalid || aiLimitsInvalid;
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
      // 0 or empty: no cap.
      ...Object.fromEntries(AI_LIMITS.map(({ key }) => [key, aiLimitValue(key) || undefined])),
    };
    // Leave out what is at its default, so the saved document stays small and defaults can change.
    for (const key of Object.keys(settings) as Array<keyof WorkflowSettings>) if (settings[key] === undefined || settings[key] === '') delete settings[key];
    if (settings.callerPolicy !== 'list') delete settings.callerIds;
    if (settings.callerPolicy === 'any') delete settings.callerPolicy;
    for (const key of ['saveSuccessfulExecutions', 'saveFailedExecutions', 'saveManualExecutions'] as const) if (settings[key] === true) delete settings[key];
    if (!settings.concurrencyLimit && !settings.singleton) delete settings.concurrencyOverflow;
    if (settings.concurrencyOverflow === 'queue') delete settings.concurrencyOverflow;
    if (settings.priority === 'normal') delete settings.priority;
    if (!limited || settings.concurrencyOverflow === 'skip') delete settings.concurrencyQueueSize;
    if (!settings.retryMaxAttempts) delete settings.retryBaseDelaySeconds;
    setSaving(true);
    // The workflow's policy first: the save's governance warnings then follow it.
    if (!(await governance.save())) return setSaving(false);
    useEditor.getState().setSettings(settings);
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
        <NotifyOnFailure workflowId={workflowId} />

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
          <Field
            id="wf-priority"
            label="Priority"
            hint="Which runs get a turn first when places are scarce: when the instance caps its runs (LANDFLOW_MAX_RUNS) and, in queue mode, which jobs workers take first. Low runs are not starved."
          >
            <Select id="wf-priority" value={draft.priority ?? 'normal'} onChange={(e) => patch({ priority: e.target.value as 'high' | 'normal' | 'low' })}>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </Select>
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

        <div className="space-y-2">
          <div className="text-[12px] font-semibold text-t2">AI usage limits</div>
          <div className="grid grid-cols-2 gap-3">
            {AI_LIMITS.map(({ key, label, unit, cost }) => {
              const bad = aiLimitInvalid(key, cost);
              return (
                <Field key={key} id={`wf-${key}`} label={label} hint={bad ? <span className="text-rd">{cost ? 'An amount in US dollars, 0 or more.' : 'A whole number of tokens, 0 or more.'}</span> : undefined}>
                  <div className="relative">
                    <Input
                      id={`wf-${key}`}
                      inputMode={cost ? 'decimal' : 'numeric'}
                      value={aiLimits[key]}
                      onChange={(e) => setAiLimits((current) => ({ ...current, [key]: e.target.value.replace(cost ? /[^\d.]/g : /[^\d]/g, '') }))}
                      placeholder="No cap"
                      className={cn('pr-16', bad && 'border-rd')}
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-t3">{unit}</span>
                  </div>
                </Field>
              );
            })}
          </div>
          <p className="text-[12px] leading-snug text-t3">
            Input and output tokens of every model call (sub-workflows included), cost estimated from the price table in Settings. A run that goes over stops with an error; the day is the instance time zone. Empty or 0: no cap.
          </p>
        </div>

        <RunTraceSettings value={draft} onChange={patch} />

        {transportPlugins.length > 0 && <TransportOverrides plugins={transportPlugins} value={draft.transports} onChange={(transports) => patch({ transports })} />}

        <WorkflowGovernanceSection state={governance} />
      </div>
    </Dialog>
  );
}

/** Workflow settings → Run Trace (docs/run-trace.md): how much the run's journal keeps, and the Run report's profile. */
function RunTraceSettings({ value, onChange }: { value: WorkflowSettings; onChange: (next: Partial<WorkflowSettings>) => void }) {
  const setting = value.runProfile;
  const custom = setting !== undefined && typeof setting === 'object';
  const [text, setText] = useState(() => JSON.stringify(custom ? setting : { ...RUN_PROFILES.software, id: 'my-profile', name: 'My profile' }, null, 2));
  const [bad, setBad] = useState<string>();
  const editCustom = (next: string) => {
    setText(next);
    try {
      const parsed = JSON.parse(next) as Partial<RunProfile>;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string' || typeof parsed.name !== 'string') throw new Error('A profile needs an "id" and a "name".');
      setBad(undefined);
      onChange({ runProfile: parsed as WorkflowSettings['runProfile'] });
    } catch (e) {
      setBad((e as Error).message);
    }
  };
  const choice = custom ? 'custom' : (setting ?? 'generic');
  return (
    <div className="space-y-2">
      <div className="text-[12px] font-semibold text-t2">Run trace</div>
      <div className="grid grid-cols-2 gap-3">
        <Field id="wf-run-profile" label="Profile" hint={custom ? 'A custom profile, as JSON.' : RUN_PROFILES[choice as keyof typeof RUN_PROFILES]?.description}>
          <Select
            id="wf-run-profile"
            value={choice}
            onChange={(e) => {
              const next = e.target.value;
              if (next === 'custom') editCustom(text);
              else onChange({ runProfile: next === 'generic' ? undefined : (next as 'software' | 'support') });
            }}
          >
            <option value="generic">Generic</option>
            <option value="software">Software delivery</option>
            <option value="support">Customer support</option>
            <option value="custom">Custom (JSON)</option>
          </Select>
        </Field>
        <Field
          id="wf-trace-content"
          label="Content kept"
          hint={value.traceContent === 'off' ? 'Only who did what and when.' : value.traceContent === 'summaries' ? 'The first 400 characters of each message.' : 'Redacted, up to 32 KB per event.'}
        >
          <Select id="wf-trace-content" value={value.traceContent ?? 'full'} onChange={(e) => onChange({ traceContent: e.target.value === 'full' ? undefined : (e.target.value as 'summaries' | 'off') })}>
            <option value="full">Full</option>
            <option value="summaries">Summaries</option>
            <option value="off">Off</option>
          </Select>
        </Field>
      </div>
      {custom && (
        <Field id="wf-run-profile-json" label="Custom profile" hint={bad ? <span className="text-rd">{bad}</span> : 'Claims, role rules and deliveries the Run report checks; patterns are regular expressions.'}>
          <Textarea id="wf-run-profile-json" value={text} onChange={(e) => editCustom(e.target.value)} rows={10} spellCheck={false} className={cn('font-mono text-[12px]', bad && 'border-rd')} />
        </Field>
      )}
      <p className="text-[12px] leading-snug text-t3">
        Every run keeps a journal of who did what: steps, requests between agents, waits for people, artifacts and checks. The profile gives the Run report node its checks and words. Journals are kept 30 days.
      </p>
    </div>
  );
}
