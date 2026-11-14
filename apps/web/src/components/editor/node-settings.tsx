import { useEffect, useState } from 'react';
import { ChevronRight, CircleDot, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkflowNode } from '@/lib/shared/types';
import { Button } from '../ui/button';
import { FieldLabel, Input, Select, Switch, Textarea } from '../ui/inputs';
import type { useEditor } from './store';

/**
 * The node panel's Settings pane. Props only, so a test can render it: On error, Retry on fail and Notes come first,
 * the rest (Disabled, Timeout, Rate limit, triggers' Debounce and Batch, Always output data, Execute once) sit under More.
 */
export function NodeSettingsPane({
  wf,
  update,
  usableAsTool,
  isTrigger,
  isSubnode,
  breakpoint,
  running,
  more,
  onToggleMore,
  onToggleBreakpoint,
  onRunFrom,
}: {
  wf: Omit<WorkflowNode, 'position'>;
  update: (patch: NodeSettings) => void;
  usableAsTool?: boolean;
  isTrigger: boolean;
  isSubnode: boolean;
  breakpoint: boolean;
  running: boolean;
  more: boolean;
  onToggleMore: () => void;
  onToggleBreakpoint: () => void;
  onRunFrom: () => void;
}) {
  return (
    <div className="space-y-2">
      {!isSubnode && (
        // Breakpoint and Run from here lead the Settings pane, on a phone and at a desk.
        <div className="flex flex-wrap gap-2 pb-2">
          <Button className={cn('max-md:h-11', breakpoint && 'text-rd')} title="Pause here when debugging (F9)" onClick={onToggleBreakpoint}>
            <CircleDot className="size-4" /> {breakpoint ? 'Breakpoint on' : 'Breakpoint'}
          </Button>
          <Button
            className="max-md:h-11"
            disabled={running}
            title="Re-run this step and everything after it, reusing the data before it"
            onClick={onRunFrom}
          >
            <SkipForward className="size-4" /> Run from here
          </Button>
        </div>
      )}
      <SettingRow label="On error" hint="Stop the workflow or continue with the error attached to items">
        <Select value={wf.onError ?? 'stop'} onChange={(e) => update({ onError: e.target.value as 'stop' | 'continue' })} className="w-40">
          <option value="stop">Stop workflow</option>
          <option value="continue">Continue</option>
        </Select>
      </SettingRow>
      <SettingRow label="Retry on fail" hint="Run the step again when it errors">
        <Switch checked={Boolean(wf.retryOnFail)} onChange={(v) => update({ retryOnFail: v })} />
      </SettingRow>
      {wf.retryOnFail && (
        <>
          <SettingRow label="Max tries">
            <Input type="number" min={1} max={10} value={wf.maxTries ?? 3} onChange={(e) => update({ maxTries: Number(e.target.value) })} className="w-24" />
          </SettingRow>
          <SettingRow label="Wait between tries (ms)" hint="Before the first retry; the most is a minute">
            <Input
              type="number"
              min={0}
              max={60_000}
              value={wf.waitBetweenTriesMs ?? 1000}
              onChange={(e) =>
                update({
                  waitBetweenTriesMs: Math.max(0, Math.min(60_000, Math.round(Number(e.target.value) || 0))),
                })
              }
              aria-label="Wait between tries (ms)"
              className="w-24"
            />
          </SettingRow>
          <SettingRow label="Backoff" hint="Exponential doubles the wait after each failed try, up to a minute">
            <Select
              value={wf.retryBackoff ?? 'fixed'}
              onChange={(e) =>
                update({
                  retryBackoff: e.target.value as 'fixed' | 'exponential',
                })
              }
              className="w-40"
            >
              <option value="fixed">Fixed</option>
              <option value="exponential">Exponential</option>
            </Select>
          </SettingRow>
        </>
      )}
      <div className="pt-2">
        <FieldLabel>Notes</FieldLabel>
        <Textarea
          rows={3}
          value={wf.notes ?? ''}
          onChange={(e) => update({ notes: e.target.value })}
          placeholder={usableAsTool ? 'Also used as the tool description for AI agents' : 'Notes for your team'}
        />
      </div>
      <button type="button" aria-expanded={more} onClick={onToggleMore} className="flex w-full items-center gap-1.5 pt-2 text-[13px] font-semibold text-t2 hover:text-t1 max-md:h-11">
        <ChevronRight className={cn('size-4 transition-transform', more && 'rotate-90')} /> More
      </button>
      {more && (
        <div className="space-y-2">
          <SettingRow label="Disabled" hint="Pass input straight through without running">
            <Switch checked={Boolean(wf.disabled)} onChange={(v) => update({ disabled: v })} />
          </SettingRow>
          <SettingRow label="Timeout (seconds)" hint="Fail a try that takes longer; retries and On error apply. Empty: no timeout">
            <Input
              type="number"
              min={0.1}
              max={86_400}
              step="any"
              value={wf.timeoutSeconds ?? ''}
              onChange={(e) =>
                update({
                  timeoutSeconds: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
              // Out of range once typing is done: 0 or less is no timeout, the most is a day.
              onBlur={() => {
                const seconds = wf.timeoutSeconds;
                if (seconds !== undefined && !(seconds >= 0.1)) update({ timeoutSeconds: undefined });
                else if (seconds !== undefined && seconds > 86_400) update({ timeoutSeconds: 86_400 });
              }}
              placeholder="None"
              aria-label="Timeout (seconds)"
              className="w-24"
            />
          </SettingRow>
          <RateLimitSetting value={wf.rateLimit} onChange={(rateLimit) => update({ rateLimit })} />
          {isTrigger && <TriggerBufferSettings debounce={wf.debounce} batch={wf.batch} onChange={(patch) => update(patch)} />}
          <SettingRow label="Always output data" hint="Continue down the branch even with zero items">
            <Switch checked={Boolean(wf.alwaysOutputData)} onChange={(v) => update({ alwaysOutputData: v })} />
          </SettingRow>
          <SettingRow label="Execute once" hint="Only process the first item">
            <Switch checked={Boolean(wf.executeOnce)} onChange={(v) => update({ executeOnce: v })} />
          </SettingRow>
        </div>
      )}
    </div>
  );
}

export type NodeSettings = Parameters<ReturnType<typeof useEditor.getState>['updateNode']>[1];

/**
 * A number input for a node setting. While typing, valid numbers go through at once; an empty field is `undefined`
 * when the setting is `optional`, otherwise the last value comes back on blur. Out-of-range values are fixed on blur.
 */
function NumberField(props: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min: number;
  max: number;
  step?: string;
  placeholder?: string;
  label: string;
  optional?: boolean;
}) {
  const { value, onChange, min, max, step, placeholder, label, optional } = props;
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft((current) => (current !== '' && Number(current) === value ? current : value === undefined ? '' : String(value))), [value]);
  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step ?? 'any'}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (e.target.value === '') {
          if (optional) onChange(undefined);
        } else if (Number.isFinite(Number(e.target.value))) onChange(Number(e.target.value));
      }}
      onBlur={() => {
        if (draft === '' && !optional) setDraft(value === undefined ? '' : String(value));
        else if (value !== undefined && value < min) onChange(min);
        else if (value !== undefined && value > max) onChange(max);
      }}
      placeholder={placeholder}
      aria-label={label}
      className="w-20"
    />
  );
}

/** `node.rateLimit`: at most `limit` calls per `intervalSeconds`, shared by every run; calls over it wait their turn. */
function RateLimitSetting({ value, onChange }: { value: NodeSettings['rateLimit']; onChange: (value: NodeSettings['rateLimit']) => void }) {
  return (
    <SettingRow label="Rate limit" hint="At most this many calls per interval, across all runs; calls over it wait their turn. Empty: no limit">
      <div className="flex shrink-0 items-center gap-1.5 text-[12px] text-t3">
        <NumberField
          label="Calls per interval"
          optional
          min={1}
          max={100_000}
          step="1"
          placeholder="None"
          value={value?.limit}
          onChange={(limit) =>
            onChange(
              limit === undefined || !(limit >= 1)
                ? undefined
                : {
                    limit: Math.floor(limit),
                    intervalSeconds: value?.intervalSeconds ?? 1,
                  },
            )
          }
        />
        per
        <NumberField
          label="Interval (seconds)"
          min={0.1}
          max={86_400}
          placeholder="1"
          value={value?.intervalSeconds}
          onChange={(intervalSeconds) => value && onChange({ ...value, intervalSeconds: intervalSeconds ?? 1 })}
        />
        s
      </div>
    </SettingRow>
  );
}

/** Trigger nodes: debounce (`node.debounce`) or batch (`node.batch`) the events of production runs. */
function TriggerBufferSettings({ debounce, batch, onChange }: { debounce: NodeSettings['debounce']; batch: NodeSettings['batch']; onChange: (patch: NodeSettings) => void }) {
  const held = 'Production runs only (webhooks, schedules, polls, public chats); manual runs are never held.';
  return (
    <>
      <SettingRow label="Debounce" hint={`Collapse events that arrive close together into one run, after a quiet window. ${held}`}>
        <Switch checked={Boolean(debounce)} onChange={(on) => onChange(on ? { debounce: { windowSeconds: 10 }, batch: undefined } : { debounce: undefined })} />
      </SettingRow>
      {debounce && (
        <div className="space-y-2 rounded-[10px] border border-hair bg-wl px-3 py-2.5 text-[12px] text-t2">
          <div className="flex items-center justify-between gap-3">
            <span>Quiet window (seconds)</span>
            <NumberField
              label="Quiet window (seconds)"
              min={0.1}
              max={86_400}
              value={debounce.windowSeconds}
              onChange={(windowSeconds) =>
                onChange({
                  debounce: { ...debounce, windowSeconds: windowSeconds ?? 10 },
                })
              }
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span title="Events with different keys are debounced separately">Key (expression)</span>
            <Input
              value={debounce.key ?? ''}
              onChange={(e) =>
                onChange({
                  debounce: { ...debounce, key: e.target.value || undefined },
                })
              }
              placeholder="{{ $json.body.userId }}"
              aria-label="Debounce key"
              className="w-56 font-mono text-[12px]"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>The run gets</span>
            <Select
              value={debounce.mode ?? 'last'}
              onChange={(e) =>
                onChange({
                  debounce: {
                    ...debounce,
                    mode: e.target.value as 'last' | 'all',
                  },
                })
              }
              className="w-40"
            >
              <option value="last">The last event</option>
              <option value="all">All events</option>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Start at the latest after (seconds)</span>
            <NumberField
              label="Maximum wait (seconds)"
              optional
              min={0}
              max={604_800}
              placeholder="No max"
              value={debounce.maxWaitSeconds}
              onChange={(maxWaitSeconds) => onChange({ debounce: { ...debounce, maxWaitSeconds } })}
            />
          </div>
          <div className="text-t3">Empty key: one window for all events. Held webhook calls are answered 202 with when the run starts.</div>
        </div>
      )}
      <SettingRow label="Batch" hint={`Collect events and start one run with all of them, when the batch is full or on a timeout. ${held}`}>
        <Switch
          checked={Boolean(batch)}
          onChange={(on) =>
            onChange(
              on
                ? {
                    batch: { size: 10, timeoutSeconds: 30 },
                    debounce: undefined,
                  }
                : { batch: undefined },
            )
          }
        />
      </SettingRow>
      {batch && (
        <div className="space-y-2 rounded-[10px] border border-hair bg-wl px-3 py-2.5 text-[12px] text-t2">
          <div className="flex items-center justify-between gap-3">
            <span>Events per batch</span>
            <NumberField label="Batch size" min={1} max={10_000} step="1" value={batch.size} onChange={(size) => onChange({ batch: { ...batch, size: Math.floor(size ?? 10) } })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Timeout after the first event (seconds)</span>
            <NumberField
              label="Batch timeout (seconds)"
              min={0.1}
              max={86_400}
              value={batch.timeoutSeconds}
              onChange={(timeoutSeconds) =>
                onChange({
                  batch: { ...batch, timeoutSeconds: timeoutSeconds ?? 30 },
                })
              }
            />
          </div>
        </div>
      )}
    </>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[10px] border border-hair bg-wl px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-t1">{label}</div>
        {hint && (
          <div className="truncate text-[12px] text-t3 max-md:whitespace-normal" title={hint}>
            {hint}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
