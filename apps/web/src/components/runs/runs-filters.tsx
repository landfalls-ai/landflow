'use client';
/**
 * The Runs list's filter row (docs/run-trace.md#the-runs-list): one search box (workflow name, error text, node), a Status
 * and a Workflow chip, and More filters in a popover (a sheet on a phone). The state lives in the URL, in the parent.
 */
import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Checkbox, FieldLabel, Input, SearchInput } from '@/components/ui/inputs';
import { Button } from '@/components/ui/button';
import { MenuItem, Popover } from '@/components/ui/popover';
import { NO_FILTERS, STATUS_CHOICES, moreCount, type RunFilters } from './runs-query';

function Chip({ label, value, active, open, toggle }: { label: string; value: string; active: boolean; open: boolean; toggle: () => void }) {
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label={`${label}: ${value}`}
      className={cn(
        'inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors max-md:h-11 max-md:px-4 max-md:text-[14px]',
        active ? 'border-ac bg-acdim font-semibold text-ac' : 'border-hair bg-sf text-t1 hover:border-bd',
      )}
    >
      <span className="text-t3">{label}</span>
      <span className="truncate">{value}</span>
      <ChevronDown className="size-3.5 shrink-0" />
    </button>
  );
}

export function RunsFilters({ filters, onChange, workflows }: { filters: RunFilters; onChange: (next: RunFilters) => void; workflows: Array<{ id: string; name: string }> }) {
  const set = <K extends keyof RunFilters>(key: K, value: RunFilters[K]) => onChange({ ...filters, [key]: value });
  const status = STATUS_CHOICES.find((s) => s.value === filters.status);
  const workflow = workflows.find((w) => w.id === filters.workflowId);
  const more = moreCount(filters);
  return (
    <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter runs">
      <SearchInput value={filters.q} onChange={(v) => set('q', v)} placeholder="Search by workflow, error or node" label="Search runs" className="w-[320px] max-md:w-full" />
      <Popover
        title="Status"
        align="start"
        className="w-[200px]"
        trigger={({ open, toggle }) => <Chip label="Status" value={status?.label.replace('Any status', 'Any') ?? filters.status} active={Boolean(filters.status)} open={open} toggle={toggle} />}
      >
        {(close) =>
          STATUS_CHOICES.map((choice) => (
            <MenuItem
              key={choice.value}
              onClick={() => {
                close();
                set('status', choice.value);
              }}
            >
              {filters.status === choice.value ? <Check /> : <span className="size-3.5" />} {choice.label}
            </MenuItem>
          ))
        }
      </Popover>
      <Popover
        title="Workflow"
        align="start"
        className="max-h-[360px] w-[260px] overflow-y-auto"
        trigger={({ open, toggle }) => <Chip label="Workflow" value={filters.workflowId ? (workflow?.name ?? filters.workflowId) : 'Any'} active={Boolean(filters.workflowId)} open={open} toggle={toggle} />}
      >
        {(close) => (
          <>
            {[{ id: '', name: 'Any workflow' }, ...workflows].map((w) => (
              <MenuItem
                key={w.id}
                onClick={() => {
                  close();
                  set('workflowId', w.id);
                }}
              >
                {filters.workflowId === w.id ? <Check /> : <span className="size-3.5" />} <span className="truncate">{w.name}</span>
              </MenuItem>
            ))}
          </>
        )}
      </Popover>
      <Popover
        title="More filters"
        align="start"
        className="w-[320px] p-3"
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors max-md:h-11 max-md:px-4 max-md:text-[14px]',
              more ? 'border-ac bg-acdim font-semibold text-ac' : 'border-hair bg-sf text-t2 hover:border-bd hover:text-t1',
            )}
          >
            <SlidersHorizontal className="size-3.5" /> More filters
            {more > 0 && <span className="rounded-full bg-ac2 px-1.5 text-[11px] font-semibold leading-[18px] text-on-ac">{more}</span>}
          </button>
        )}
      >
        <div className="space-y-3 max-md:px-1 max-md:pb-2">
          <div>
            <FieldLabel>Agent or actor</FieldLabel>
            <Input value={filters.actor} onChange={(e) => set('actor', e.target.value)} placeholder="Developer" className="max-md:h-11" />
          </div>
          <div>
            <FieldLabel>Tool</FieldLabel>
            <Input value={filters.tool} onChange={(e) => set('tool', e.target.value)} placeholder="Bash" className="max-md:h-11" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>From</FieldLabel>
              <Input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} className="max-md:h-11" />
            </div>
            <div>
              <FieldLabel>To</FieldLabel>
              <Input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} className="max-md:h-11" />
            </div>
          </div>
          <Checkbox checked={filters.failedSteps} onChange={(v) => set('failedSteps', v)} label="Has failed steps" />
          <Checkbox checked={Boolean(filters.failedCheck)} onChange={(v) => set('failedCheck', v ? '*' : '')} label="A check failed" />
          {filters.failedCheck && (
            <Input value={filters.failedCheck === '*' ? '' : filters.failedCheck} onChange={(e) => set('failedCheck', e.target.value || '*')} placeholder="Which check (empty for any)" className="max-md:h-11" />
          )}
          {more > 0 && (
            <Button size="sm" variant="ghost" onClick={() => onChange({ ...filters, actor: '', tool: '', from: '', to: '', failedSteps: false, failedCheck: '' })}>
              Clear more filters
            </Button>
          )}
        </div>
      </Popover>
      {(filters.q || filters.status || filters.workflowId || more > 0) && (
        <button type="button" onClick={() => onChange(NO_FILTERS)} className="h-8 rounded-full px-2 text-[13px] text-t2 hover:text-t1 max-md:h-11">
          Clear
        </button>
      )}
    </div>
  );
}
