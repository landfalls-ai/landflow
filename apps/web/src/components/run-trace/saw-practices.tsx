'use client';
/**
 * The practices row of "What it saw" (docs/run-trace.md#what-it-saw): each approved practice the run was given, as
 * `handle@version`. With a run (`executionId`) it says per practice whether the run cited it and how its check went
 * (GET /api/executions/:id/practices); until that answers, or without a run, it lists the practices alone. It is mounted
 * inside "What it saw" (components/run-trace/what-it-saw.tsx). Nothing is drawn when the run was given none.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import type { RunPracticeRow } from '@/lib/shared/practice-compliance';
import type { SawPracticesRowProps } from '@/lib/shared/what-it-saw';
import { Badge, type Tone } from '../ui/badge';

const CHECK: Record<NonNullable<RunPracticeRow['check']>, { label: string; tone: Tone }> = {
  pass: { label: 'Check passed', tone: 'success' },
  fail: { label: 'Check failed', tone: 'danger' },
  waived: { label: 'Check waived', tone: 'warning' },
};

/** The row as markup: `rows` are what the run's route answered (undefined while it loads or when there is no run). */
export function PracticesRowView({ practices, rows }: { practices: SawPracticesRowProps['practices']; rows?: RunPracticeRow[] }) {
  if (!practices.length) return null;
  const byKey = new Map((rows ?? []).map((r) => [`${r.handle}@${r.version}`, r]));
  return (
    <div className="space-y-1.5" data-testid="saw-practices">
      <p className="text-[12px] font-semibold text-t2">Practices given</p>
      <ul className="space-y-1">
        {practices.map((p) => {
          const row = byKey.get(`${p.handle}@${p.version}`);
          return (
            <li key={`${p.handle}@${p.version}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
              <code className="break-all font-mono text-[12px] text-t1">
                {p.handle}@{p.version}
              </code>
              {rows && (
                <>
                  <Badge tone={row?.cited ? 'success' : 'muted'}>{row?.cited ? 'Cited' : 'Not cited'}</Badge>
                  {row?.check && <Badge tone={CHECK[row.check].tone}>{CHECK[row.check].label}</Badge>}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SawPracticesRow({ practices, executionId }: SawPracticesRowProps) {
  const [rows, setRows] = useState<RunPracticeRow[]>();
  useEffect(() => {
    setRows(undefined);
    if (!executionId || !practices.length) return;
    let live = true;
    api<{ practices: RunPracticeRow[] }>(`/api/executions/${encodeURIComponent(executionId)}/practices`, { background: true })
      .then((r) => live && setRows(r.practices))
      .catch(() => live && setRows(undefined));
    return () => {
      live = false;
    };
  }, [executionId, practices.length]);
  return <PracticesRowView practices={practices} rows={rows} />;
}
