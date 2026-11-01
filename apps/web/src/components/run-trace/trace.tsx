'use client';
/** The Trace tab: the timed span tree down to remote steps, collapsible, with a duration bar per row. */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cut, fmtMs, resultOf, type RunModel, type RunSpan } from '@/lib/shared/run-trace-model';
import { EmptyState } from '../ui/empty-state';
import { actorColor, clock } from './parts';
import type { Open } from './sheet';

const OP: Record<string, string> = {
  run: 'invoke_workflow',
  step: 'step',
  agent: 'invoke_agent',
  delegate: 'invoke_agent · A2A',
  handoff: 'handoff',
  wait: 'input-required',
  tool: 'execute_tool',
  model: 'chat',
};

function nameOf(s: RunSpan) {
  if (s.kind === 'delegate' || s.kind === 'handoff') return `${s.caller ? `${s.caller.name} → ` : ''}${s.actor.name}`;
  if (s.kind === 'wait') return `waits for ${s.actor.name}`;
  if (s.kind === 'model' && s.usage) return `${s.name} · ${s.usage.inputTokens.toLocaleString()} in · ${s.usage.outputTokens.toLocaleString()} out`;
  return s.name;
}

export function Trace({ model, open }: { model: RunModel; open: (o: Open) => void }) {
  // The user's toggles; the rest opens by default for agents and small branches.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const run = model.run;
  if (!run) return <EmptyState compact title="Nothing recorded yet" hint="The trace appears as the run starts." />;
  const total = Math.max(1, model.t1 - model.t0);
  const isOpen = (s: RunSpan) => {
    if (toggled[s.id] !== undefined) return toggled[s.id];
    const n = s.children.filter((id) => !model.spans[id].hidden).length;
    return s.id === 'run' || s.kind === 'agent' || n <= 6;
  };
  const rows: React.ReactNode[] = [];
  const walk = (s: RunSpan) => {
    const kids = s.children.map((id) => model.spans[id]).filter((k) => !k.hidden);
    const expanded = kids.length > 0 && isOpen(s);
    const running = s.status === 'running' || s.status === 'waiting';
    const left = ((s.t0 - model.t0) / total) * 100;
    const width = Math.max(0.8, ((s.t1 - s.t0) / total) * 100);
    const color =
      s.status === 'error' ? 'var(--rd)' : actorColor(s.kind === 'delegate' || s.kind === 'agent' || s.kind === 'wait' ? s.actor : (s.caller ?? s.actor));
    const label = s.kind === 'delegate' || s.kind === 'handoff' ? ` · ${resultOf(s)[0]}` : '';
    rows.push(
      <div
        key={s.id}
        className={cn('border-b border-hair last:border-b-0', s.status === 'error' && 'bg-rddim')}
        style={{ paddingLeft: Math.min(s.depth, 5) * 12 }}
      >
        <div className="flex items-center">
          {kids.length > 0 ? (
            <button
              type="button"
              onClick={() => setToggled({ ...toggled, [s.id]: !expanded })}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${s.name}`}
              className="grid size-11 shrink-0 place-items-center text-t3 hover:text-t1"
            >
              {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </button>
          ) : (
            <span className="size-3 shrink-0" />
          )}
          <button type="button" onClick={() => open({ kind: 'span', id: s.id })} className="min-w-0 flex-1 py-2 pr-3 text-left">
            <div className="flex items-center gap-2">
              <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-t1">{cut(nameOf(s), 80)}</span>
              <span className={cn('shrink-0 font-mono text-[11px] tabular-nums', running ? 'text-warn' : 'text-t3')}>
                {s.ms < 500 && !running ? clock(s.startedAt) : `${fmtMs(s.ms)}${running ? ' …' : ''}`}
              </span>
            </div>
            {typeof s.attrs.reason === 'string' && s.attrs.reason && <p className="mt-0.5 line-clamp-2 break-words text-[12px] text-t2">Why: {cut(s.attrs.reason, 160)}</p>}
            <div className="mt-1 flex items-center gap-2">
              <span className="shrink-0 text-[11px] text-t3">
                {OP[s.kind] ?? s.kind}
                {label}
              </span>
              <div className="relative h-1.5 min-w-0 flex-1 rounded-full bg-nudim" aria-hidden>
                <i
                  className={cn('absolute inset-y-0 rounded-full', running && 'animate-pulse-soft')}
                  style={{
                    left: `${left}%`,
                    width: `${Math.min(width, 100 - left)}%`,
                    background: color,
                  }}
                />
              </div>
            </div>
          </button>
        </div>
      </div>,
    );
    if (expanded) kids.forEach(walk);
  };
  walk(run);
  return (
    <div>
      <div className="mb-1.5 flex justify-between px-1 font-mono text-[11px] text-t3" aria-hidden>
        <span>{clock(model.t0)}</span>
        <span>{fmtMs(total / 2)}</span>
        <span>{fmtMs(total)}</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-hair bg-sf">{rows}</div>
    </div>
  );
}
