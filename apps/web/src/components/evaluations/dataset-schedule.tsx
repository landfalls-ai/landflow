'use client';
/**
 * The Evaluations tab's dataset file and schedule. The file (CSV or JSON) is what an Evaluation Trigger with Dataset "Uploaded
 * file" runs over; it is kept in the binary store and replaced by uploading another. The schedule is a cron that starts a run by
 * itself (the leader evaluates it in queue mode); “Alert on a falling score” is a rule of kind Evaluation score in Settings → Alerts.
 */
import { useRef, useState } from 'react';
import Link from 'next/link';
import { CalendarClock, FileSpreadsheet, TriangleAlert, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { EvaluationFile, EvaluationSchedule, EvaluationsOverview } from '@/lib/shared/evaluations';
import { Button } from '../ui/button';
import { Input, Switch } from '../ui/inputs';
import { formatStamp } from '../run/run-status';

const PRESETS = [
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Daily 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays 08:00', cron: '0 8 * * 1-5' },
  { label: 'Weekly (Mon 09:00)', cron: '0 9 * * 1' },
];

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** The uploaded dataset file: its name and rows, upload and remove. Shown when the trigger reads the file (or none exists yet). */
export function FileDataset({ workflowId, overview, onChanged }: { workflowId: string; overview: EvaluationsOverview; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const file: EvaluationFile | undefined = overview.file;
  const reads = overview.trigger?.source === 'file';
  if (!reads && !file) return null;

  const upload = async (selected: File) => {
    setBusy(true);
    try {
      const { file: saved } = await api<{ file: EvaluationFile }>(`/api/workflows/${workflowId}/evaluations/dataset`, {
        method: 'PUT',
        body: selected,
        headers: { 'x-file-name': selected.name, 'content-type': selected.type || 'application/octet-stream' },
      });
      toast.success(`${saved.fileName}: ${saved.rows.toLocaleString()} test cases`);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const remove = async () => {
    try {
      await api(`/api/workflows/${workflowId}/evaluations/dataset`, { method: 'DELETE' });
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="rounded-[10px] border border-hair bg-sf px-3 py-2 text-[12px]">
      <div className="flex items-center gap-1.5 text-t1">
        <FileSpreadsheet className="size-3.5 text-t3" />
        <span className="truncate font-semibold">{file ? file.fileName : 'No file uploaded'}</span>
        {file && <span className="ml-auto shrink-0 tabular-nums text-t3">{file.rows.toLocaleString()} rows</span>}
      </div>
      <div className="mt-0.5 text-t3">
        {file ? `${file.format.toUpperCase()} · ${size(file.fileSize)} · ${file.columns.length} columns · ${timeAgo(file.uploadedAt)}` : 'CSV (first row = column names) or JSON (an array of objects), up to 10 MB'}
      </div>
      {file && <div className="mt-0.5 truncate font-mono text-[11px] text-t3" title={file.columns.join(', ')}>{file.columns.join(', ')}</div>}
      {!reads && file && <div className="mt-1 text-warn">The Evaluation Trigger reads a Data Table: switch its Dataset to “Uploaded file” to use this.</div>}
      <div className="mt-2 flex items-center gap-1.5">
        <input ref={input} type="file" accept=".csv,.tsv,.json,.jsonl,.ndjson,text/csv,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <Button size="sm" onClick={() => input.current?.click()} loading={busy}>
          <Upload className="size-3" /> {file ? 'Replace file' : 'Upload file'}
        </Button>
        {file && (
          <Button size="icon-sm" variant="ghost" aria-label="Remove the file" title="Remove the file" onClick={() => void remove()}>
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** The schedule: a switch, a cron (with presets), and what the last start did. */
export function ScheduleCard({ workflowId, overview, onChanged }: { workflowId: string; overview: EvaluationsOverview; onChanged: () => void }) {
  const schedule: EvaluationSchedule | undefined = overview.schedule;
  const [open, setOpen] = useState(false);
  const [cron, setCron] = useState(schedule?.cron ?? '0 9 * * *');
  const [timezone, setTimezone] = useState(schedule?.timezone ?? '');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();

  const save = async (enabled: boolean, nextCron = cron) => {
    setSaving(true);
    setProblem(undefined);
    try {
      await api(`/api/workflows/${workflowId}/evaluations/schedule`, { method: 'PUT', json: { enabled, cron: nextCron.trim(), ...(timezone.trim() && { timezone: timezone.trim() }) } });
      toast.success(enabled ? 'Evaluation scheduled' : 'Schedule saved (off)');
      setOpen(false);
      onChanged();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    await api(`/api/workflows/${workflowId}/evaluations/schedule`, { method: 'DELETE' }).catch((e: Error) => toast.error(e.message));
    setOpen(false);
    onChanged();
  };

  return (
    <div className="rounded-[10px] border border-hair bg-sf px-3 py-2 text-[12px]">
      <div className="flex items-center gap-1.5 text-t1">
        <CalendarClock className="size-3.5 text-t3" />
        <span className="font-semibold">Schedule</span>
        {schedule ? (
          <>
            <code className="truncate font-mono text-[11px] text-t2">{schedule.cron}</code>
            <span className="ml-auto">
              <Switch checked={schedule.enabled} onChange={(enabled) => void save(enabled, schedule.cron)} label="Scheduled evaluation on" />
            </span>
          </>
        ) : (
          <span className="text-t3">Off</span>
        )}
      </div>
      {schedule?.enabled && schedule.lastRunAt && <div className="mt-0.5 text-t3">Last started {formatStamp(schedule.lastRunAt)}</div>}
      {schedule?.lastError && (
        <div className="mt-0.5 flex items-start gap-1 text-warn">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" /> <span>{schedule.lastError}</span>
        </div>
      )}
      {open ? (
        <div className="mt-2 space-y-2">
          <Input value={cron} onChange={(e) => setCron(e.target.value)} aria-label="Cron expression" className="h-8 font-mono text-[12px]" placeholder="0 9 * * *" />
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((preset) => (
              <button key={preset.cron} type="button" onClick={() => setCron(preset.cron)} className="h-6 rounded-full border border-hair px-2 text-[11px] text-t2 hover:border-ac hover:text-ac">
                {preset.label}
              </button>
            ))}
          </div>
          <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} aria-label="Time zone" className="h-8 text-[12px]" placeholder="Time zone (empty: the workflow’s)" />
          <p className="leading-snug text-t3">Minute hour day-of-month month day-of-week. A run that is still going makes the next start wait.</p>
          {problem && <div className="text-rd">{problem}</div>}
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="primary" onClick={() => void save(true)} loading={saving}>
              Save and turn on
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {schedule && (
              <Button size="sm" variant="ghost" className="ml-auto hover:text-rd" onClick={() => void remove()}>
                Remove
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-1.5 flex items-center gap-2">
          <Button size="sm" onClick={() => setOpen(true)}>
            {schedule ? 'Change' : 'Schedule runs'}
          </Button>
          <Link href="/settings#alerts" className="text-[11px] text-ac hover:underline">
            Alert on a falling score
          </Link>
        </div>
      )}
    </div>
  );
}
