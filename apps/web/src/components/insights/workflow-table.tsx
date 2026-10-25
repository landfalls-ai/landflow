'use client';
/**
 * Insights per workflow: sortable by any column, with the minutes a workflow
 * saves per successful run editable in place (it is the workflow's
 * `settings.timeSavedMinutes`), and the estimated AI cost of its model calls
 * in the period (`usage`, from /api/insights/ai-usage).
 */
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import type { InsightsWorkflowRow } from '@/lib/shared/platform';
import { formatCost, formatTokens, type AiUsageTotals } from '@/lib/shared/ai-usage';
import { formatMinutes, formatRate, formatRunTime } from './format';

type SortKey = 'name' | 'runs' | 'failed' | 'failureRate' | 'avgDurationMs' | 'cost' | 'timeSavedMinutes' | 'minutesSavedPerRun';

const COLUMNS: { key: SortKey; label: string; numeric?: boolean; title?: string }[] = [
  { key: 'name', label: 'Workflow' },
  { key: 'runs', label: 'Runs', numeric: true },
  { key: 'failed', label: 'Failed', numeric: true },
  { key: 'failureRate', label: 'Failure rate', numeric: true },
  { key: 'avgDurationMs', label: 'Avg run time', numeric: true },
  { key: 'cost', label: 'AI cost', numeric: true, title: 'Estimated cost of the model calls in the period (Settings → AI prices), test runs included' },
  { key: 'timeSavedMinutes', label: 'Time saved', numeric: true },
  { key: 'minutesSavedPerRun', label: 'Saves per run', numeric: true, title: 'Minutes of manual work one successful run saves' },
];

function MinutesEditor({ row, onSaved }: { row: InsightsWorkflowRow; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const done = useRef(false);

  const open = () => {
    done.current = false;
    setText(row.minutesSavedPerRun === undefined ? '' : String(row.minutesSavedPerRun));
    setEditing(true);
  };
  const save = async () => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const value = text.trim() === '' ? null : Number(text);
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100_000)) return toast.error('Enter a number of minutes from 0 to 100000');
    if ((value ?? undefined) === row.minutesSavedPerRun) return;
    try {
      await api(`/api/insights/workflows/${row.workflowId}`, { method: 'PATCH', json: { timeSavedMinutes: value } });
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (!row.exists) return <span className="text-t3">—</span>;
  if (editing) {
    return (
      <span className="inline-flex items-center justify-end gap-1">
        <input
          autoFocus
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') {
              done.current = true;
              setEditing(false);
            }
          }}
          placeholder="0"
          aria-label={`Minutes saved per run by ${row.name}`}
          className="h-7 w-16 rounded-md border border-ac bg-sf px-2 text-right font-mono text-[12px] text-t1 outline-none"
        />
        <span className="text-[12px] text-t3">min</span>
      </span>
    );
  }
  return (
    <button onClick={open} className="group/edit inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-acdim" title="Set the minutes one successful run saves">
      <Pencil className="size-3 text-t3 opacity-0 transition-opacity group-hover/edit:opacity-100" />
      {row.minutesSavedPerRun === undefined ? <span className="text-t3">Set</span> : <span className="font-mono tabular-nums">{row.minutesSavedPerRun} min</span>}
    </button>
  );
}

/** Estimated AI cost, tokens and calls in the title. */
function CostCell({ usage }: { usage?: AiUsageTotals }) {
  if (!usage?.calls) return <td className="px-4 py-2.5 text-right font-mono tabular-nums text-t3">—</td>;
  const title = `${formatTokens(usage.inputTokens)} input + ${formatTokens(usage.outputTokens)} output tokens in ${usage.calls.toLocaleString()} model call${usage.calls === 1 ? '' : 's'}`;
  return (
    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-t1" title={title}>
      {formatCost(usage.cost)}
      <div className="text-[11px] text-t3">{formatTokens(usage.inputTokens + usage.outputTokens)} tok</div>
    </td>
  );
}

export function WorkflowTable({ rows, usage = {}, onChanged }: { rows: InsightsWorkflowRow[]; usage?: Record<string, AiUsageTotals>; onChanged: () => void }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'runs', desc: true });

  const sorted = useMemo(() => {
    const value = (row: InsightsWorkflowRow) =>
      sort.key === 'minutesSavedPerRun' ? (row.minutesSavedPerRun ?? -1) : sort.key === 'cost' ? (usage[row.workflowId]?.cost ?? -1) : row[sort.key];
    return [...rows].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const order = typeof x === 'string' ? x.localeCompare(String(y)) : (x as number) - (y as number);
      return (sort.desc ? -order : order) || a.name.localeCompare(b.name);
    });
  }, [rows, sort, usage]);

  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'name' }));

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-hair">
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                scope="col"
                aria-sort={sort.key === column.key ? (sort.desc ? 'descending' : 'ascending') : undefined}
                className={cn('h-10 px-4 font-semibold', column.numeric ? 'text-right' : 'text-left')}
              >
                <button
                  onClick={() => toggle(column.key)}
                  title={column.title}
                  className={cn('inline-flex items-center gap-1 text-[12px] transition-colors hover:text-t1', sort.key === column.key ? 'text-t1' : 'text-t2', column.numeric && 'flex-row-reverse')}
                >
                  {column.label}
                  {sort.key === column.key && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.workflowId} className="border-b border-hair last:border-b-0 hover:bg-sf2">
              <td className="max-w-[280px] px-4 py-2.5">
                {row.exists ? (
                  <Link href={`/workflows/${row.workflowId}`} className="block truncate font-medium text-t1 hover:underline">
                    {row.name}
                  </Link>
                ) : (
                  <span className="block truncate text-t3" title="This workflow was deleted; its history stays in Insights">
                    {row.name} <span className="text-[12px]">(deleted)</span>
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-t1">{row.runs.toLocaleString()}</td>
              <td className={cn('px-4 py-2.5 text-right font-mono tabular-nums', row.failed ? 'text-rd' : 'text-t3')}>{row.failed.toLocaleString()}</td>
              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-t2">{formatRate(row.failureRate)}</td>
              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-t2">{formatRunTime(row.avgDurationMs)}</td>
              <CostCell usage={usage[row.workflowId]} />
              <td className={cn('px-4 py-2.5 text-right font-mono tabular-nums', row.timeSavedMinutes ? 'text-t1' : 'text-t3')}>
                {row.minutesSavedPerRun === undefined ? '—' : formatMinutes(row.timeSavedMinutes)}
              </td>
              <td className="px-4 py-1.5 text-right text-[12px]">
                <MinutesEditor row={row} onSaved={onChanged} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
