'use client';
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="text-t3">null</span>;
  if (typeof value === 'string') return <span className="break-all text-gn">&quot;{value.length > 400 ? `${value.slice(0, 400)}…` : value}&quot;</span>;
  if (typeof value === 'number') return <span className="text-viz-1">{value}</span>;
  if (typeof value === 'boolean') return <span className="text-viz-7">{String(value)}</span>;
  return <span className="text-t2">{String(value)}</span>;
}

function Node({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const isObject = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < 2);
  const entries = isObject ? Object.entries(value as Record<string, unknown>) : [];
  const isArray = Array.isArray(value);
  return (
    <div className="leading-6">
      <div className={cn('flex items-start gap-1', isObject && 'cursor-pointer')} onClick={() => isObject && setOpen(!open)}>
        <span className="w-3 shrink-0 pt-1.5 text-t3">{isObject && <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />}</span>
        {name !== undefined && <span className="shrink-0 text-t2">{name}:&nbsp;</span>}
        {isObject ? (
          <span className="text-t3">
            {isArray ? `Array(${entries.length})` : `{${entries.length}}`}
            {!open && <span className="ml-1">…</span>}
          </span>
        ) : (
          <Primitive value={value} />
        )}
      </div>
      {isObject && open && (
        <div className="ml-[7px] border-l border-hair pl-3">
          {entries.slice(0, 200).map(([key, child]) => (
            <Node key={key} name={key} value={child} depth={depth + 1} />
          ))}
          {entries.length > 200 && <div className="text-t3">… {entries.length - 200} more</div>}
        </div>
      )}
    </div>
  );
}

export function JsonView({ value, className }: { value: unknown; className?: string }) {
  return (
    <div className={cn('font-mono text-[12px] text-t1', className)}>
      <Node value={value} depth={0} />
    </div>
  );
}
