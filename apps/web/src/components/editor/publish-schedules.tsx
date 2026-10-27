'use client';
/**
 * Scheduled publishes in the editor (lib/server/publish-schedule.ts): a form that publishes the saved draft (or one
 * version) or unpublishes at a chosen time, and the list of a workflow's schedules with Cancel. Used by the Publish
 * menu and the version history. With four-eyes publishing on, a schedule waits for its request's approval first.
 */
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import type { ScheduledPublish } from '@/lib/shared/publish';
import { Button } from '../ui/button';
import { Input } from '../ui/inputs';

const LIVE = new Set(['pending', 'awaiting_approval', 'running']);

/** A workflow's schedules and a reload function; `version` bumps reload it (after another part of the UI changed them). */
export function useSchedules(workflowId: string | undefined, enabled = true) {
  const [schedules, setSchedules] = useState<ScheduledPublish[]>();
  const reload = useCallback(async () => {
    if (!workflowId) return;
    try {
      setSchedules((await api<{ schedules: ScheduledPublish[] }>(`/api/workflows/${workflowId}/schedules`)).schedules);
    } catch {
      setSchedules([]);
    }
  }, [workflowId]);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  return { schedules, reload };
}

/** A local `datetime-local` value (minute precision) to an ISO instant. */
const toIso = (local: string) => new Date(local).toISOString();

function defaultLocal() {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleForm({
  workflowId,
  action,
  versionId,
  note,
  label,
  beforeSchedule,
  onScheduled,
}: {
  workflowId: string;
  action: 'publish' | 'unpublish';
  /** The version to publish (default: the saved draft). */
  versionId?: string;
  note?: string;
  label?: string;
  /** Save unsaved edits first; false stops. */
  beforeSchedule?: () => Promise<boolean>;
  onScheduled: (schedule: ScheduledPublish) => void;
}) {
  const [at, setAt] = useState(defaultLocal);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      if (beforeSchedule && !(await beforeSchedule())) return;
      const { scheduled } = await api<{ scheduled: ScheduledPublish }>(`/api/workflows/${workflowId}/schedules`, {
        method: 'POST',
        json: { action, at: toIso(at), ...(versionId && { versionId }), ...(note?.trim() && { note: note.trim() }) },
      });
      toast.success(scheduled.status === 'awaiting_approval' ? 'Scheduled, waiting for approval' : `Scheduled for ${new Date(scheduled.runAt).toLocaleString()}`, {
        description: scheduled.status === 'awaiting_approval' ? 'Someone else has to approve it; it goes live at the chosen time.' : undefined,
      });
      onScheduled(scheduled);
    } catch (e) {
      toast.error(`Could not schedule: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label={`${action === 'publish' ? 'Publish' : 'Unpublish'} at`} className="h-8 min-w-0 flex-1 text-[12px]" />
      <Button size="sm" variant="outline" onClick={() => void submit()} loading={busy} disabled={!at}>
        <CalendarClock className="size-3.5" /> {label ?? 'Schedule'}
      </Button>
    </div>
  );
}

const STATUS_TEXT: Record<ScheduledPublish['status'], string> = {
  awaiting_approval: 'waiting for approval',
  pending: 'scheduled',
  running: 'running',
  done: 'ran',
  requested: 'became a request',
  failed: 'failed',
  canceled: 'canceled',
};

export function ScheduleRows({ schedules, workflowId, onChanged, onlyVersion, includePast = true, className }: { schedules: ScheduledPublish[]; workflowId: string; onChanged: () => void; onlyVersion?: string; includePast?: boolean; className?: string }) {
  const shown = schedules.filter((s) => (!onlyVersion || s.versionId === onlyVersion) && (includePast || LIVE.has(s.status))).slice(0, includePast ? 8 : 20);
  if (!shown.length) return null;
  const cancel = async (schedule: ScheduledPublish) => {
    try {
      await api(`/api/workflows/${workflowId}/schedules/${schedule.id}`, { method: 'DELETE' });
      onChanged();
    } catch (e) {
      toast.error(`Could not cancel: ${(e as Error).message}`);
    }
  };
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {shown.map((s) => (
        <div key={s.id} className="flex items-start gap-2 text-[12px]" title={s.result ?? undefined}>
          <CalendarClock className={cn('mt-0.5 size-3.5 shrink-0', s.status === 'failed' ? 'text-rd' : LIVE.has(s.status) ? 'text-ac' : 'text-t3')} />
          <span className="min-w-0 flex-1">
            <span className="text-t1">
              {s.action === 'unpublish' ? 'Unpublish' : `Publish version ${s.versionNumber ?? ''}`.trim()} · {new Date(s.runAt).toLocaleString()}
            </span>{' '}
            <span className="text-t3">{STATUS_TEXT[s.status]}{s.status === 'failed' && s.result ? `: ${s.result}` : ''}</span>
          </span>
          {(s.status === 'pending' || s.status === 'awaiting_approval') && (
            <Button size="icon-sm" variant="ghost" onClick={() => void cancel(s)} aria-label="Cancel this schedule" title="Cancel this schedule">
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
