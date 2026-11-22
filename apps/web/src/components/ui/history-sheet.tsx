'use client';
/**
 * A history sheet (docs/ui-review.md#controls): a Sheet with a list of versions (who, when, label), two of which can be
 * picked and compared. It holds no data and no diff: the caller gives the entries and a `compare(older, newer)` that
 * answers the changed fields, drawn with FieldDiff. An agent's published versions use it; any list of saves can.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { stamp } from '@/lib/client/format';
import { Button } from './button';
import { Checkbox } from './inputs';
import { FieldDiff, type FieldChange } from './field-diff';
import { Sheet } from './sheet';

export interface HistoryEntry {
  id: string;
  label: string;
  by?: string;
  /** ISO time. */
  at: string;
  /** A short line under it: "live", "used by Alert intake v4". */
  note?: string;
}

export interface HistoryCompare {
  changes: FieldChange[];
  unchanged: number;
}

/** The newest first; entries with the same time keep their order. */
const newestFirst = (entries: HistoryEntry[]): HistoryEntry[] => [...entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

/** Two may be compared: a third pick drops the earliest pick, a picked entry picked again is let go. */
export function toggleSelected(selected: string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((s) => s !== id);
  return [...selected, id].slice(-2);
}

/** The two picked entries as [older, newer] by their times. */
export function pairOf(entries: HistoryEntry[], selected: string[]): [HistoryEntry, HistoryEntry] | undefined {
  if (selected.length !== 2) return undefined;
  const picked = selected.map((id) => entries.find((e) => e.id === id));
  if (!picked[0] || !picked[1]) return undefined;
  return Date.parse(picked[0].at) <= Date.parse(picked[1].at) ? [picked[0], picked[1]] : [picked[1], picked[0]];
}

/** Compare the two picked entries, older first; nothing when two are not picked. */
export async function compareSelected(entries: HistoryEntry[], selected: string[], compare: (a: string, b: string) => Promise<HistoryCompare>): Promise<HistoryCompare | undefined> {
  const pair = pairOf(entries, selected);
  return pair ? compare(pair[0].id, pair[1].id) : undefined;
}

/** The list and the Compare line: what the sheet holds, apart from the sheet (and so testable to static markup). */
export function HistoryList({ entries, selected, onToggle, onCompare, comparing, actions }: { entries: HistoryEntry[]; selected: string[]; onToggle: (id: string) => void; onCompare?: () => void; comparing?: boolean; actions?: (entry: HistoryEntry) => ReactNode }) {
  const sorted = useMemo(() => newestFirst(entries), [entries]);
  const pair = pairOf(entries, selected);
  return (
    <div>
      <ul className="divide-y divide-hair rounded-xl border border-hair">
        {sorted.map((entry) => (
          <li key={entry.id} className={cn('flex items-start gap-2.5 px-3 py-2', selected.includes(entry.id) && 'bg-acdim')}>
            <Checkbox checked={selected.includes(entry.id)} onChange={() => onToggle(entry.id)} ariaLabel={`Pick ${entry.label} to compare`} className="mt-0.5" />
            <div className="min-w-0 flex-1 text-[13px]">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono font-semibold text-t1">{entry.label}</span>
                <span className="text-[12px] text-t3">{stamp(entry.at)}</span>
                {entry.by && <span className="text-[12px] text-t3">by {entry.by}</span>}
              </div>
              {entry.note && <div className="text-[11px] text-t3 [overflow-wrap:anywhere]">{entry.note}</div>}
            </div>
            {actions?.(entry)}
          </li>
        ))}
      </ul>
      <div className="mt-2.5 flex items-center gap-2 text-[12px] text-t3">
        {pair ? (
          <Button size="sm" variant="primary" onClick={onCompare} loading={comparing}>
            Compare {pair[0].label} and {pair[1].label}
          </Button>
        ) : (
          <span>{selected.length === 1 ? 'Pick one more to compare' : 'Pick two versions to compare'}</span>
        )}
      </div>
    </div>
  );
}

export function HistorySheet({
  open,
  onClose,
  title,
  entries,
  compare,
  actions,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  entries: HistoryEntry[];
  compare: (older: string, newer: string) => Promise<HistoryCompare>;
  /** A button per entry, such as Restore. */
  actions?: (entry: HistoryEntry) => ReactNode;
  footer?: ReactNode;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<{ ids: [string, string]; diff?: HistoryCompare; failed?: boolean }>();
  const [comparing, setComparing] = useState(false);
  const latest = useRef(0);
  // A closed sheet starts over next time.
  useEffect(() => {
    if (open) return;
    setSelected([]);
    setResult(undefined);
  }, [open]);

  const run = async () => {
    const pair = pairOf(entries, selected);
    if (!pair) return;
    const ids: [string, string] = [pair[0].label, pair[1].label];
    const request = ++latest.current;
    setComparing(true);
    try {
      const diff = await compareSelected(entries, selected, compare);
      if (request === latest.current) setResult({ ids, diff });
    } catch {
      if (request === latest.current) setResult({ ids, failed: true });
    } finally {
      if (request === latest.current) setComparing(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={title} footer={footer} className="md:max-w-[560px]">
      {entries.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-t3">Nothing here yet</p>
      ) : (
        <HistoryList
          entries={entries}
          selected={selected}
          onToggle={(id) => {
            setSelected((s) => toggleSelected(s, id));
            setResult(undefined);
          }}
          onCompare={() => void run()}
          comparing={comparing}
          actions={actions}
        />
      )}
      <div role="status" aria-live="polite" className="mt-3">
        {comparing && !result && (
          <p className="flex items-center gap-1.5 text-[12px] text-t3">
            <Loader2 className="size-3.5 animate-spin" /> Comparing…
          </p>
        )}
        {result?.failed && <p className="text-[12px] text-warn">Couldn’t compare {result.ids[0]} and {result.ids[1]}. Try again.</p>}
        {result?.diff && (
          <div className="rounded-xl border border-hair bg-sf2 px-3 py-2.5">
            <div className="mb-1.5 text-[12px] font-semibold text-t1">
              {result.ids[0]} → {result.ids[1]}
            </div>
            <FieldDiff changes={result.diff.changes} unchanged={result.diff.unchanged} />
          </div>
        )}
      </div>
    </Sheet>
  );
}
