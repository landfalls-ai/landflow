'use client';
/**
 * The pill switch between views or filters (docs/ui-review.md#controls): one of a few options, the chosen one raised.
 * A tab list to a screen reader (← → move between options); a visible focus ring; on a phone it scrolls sideways
 * instead of wrapping its labels.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  /** For an option drawn as an icon. */
  ariaLabel?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  stretch,
  size = 'md',
  className,
}: {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** What the options choose ("Period", "Status"), for a screen reader. */
  label: string;
  /** Fill the width, the options sharing it. */
  stretch?: boolean;
  /** `sm`: inside a dense panel (the logs, a data view). */
  size?: 'sm' | 'md';
  className?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const at = options.findIndex((o) => o.value === value);
    const next = options[(at + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length];
    onChange(next.value);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      onKeyDown={onKey}
      className={cn(
        'flex items-center gap-0.5 rounded-full border border-hair bg-sf2 p-0.5',
        stretch ? 'w-full' : 'w-fit',
        'max-md:max-w-full max-md:overflow-x-auto max-md:[scrollbar-width:none]',
        className,
      )}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            title={option.title}
            aria-label={option.ariaLabel}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex shrink-0 items-center justify-center whitespace-nowrap rounded-full text-t2 transition-all duration-200 hover:text-t1',
              size === 'sm' ? 'h-6 gap-1 px-2.5 text-[12px] max-md:h-8' : 'h-7 gap-1.5 px-3.5 text-[13px] max-md:h-9',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ac',
              stretch && 'flex-1',
              on && 'bg-sf font-semibold text-t1 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_var(--hair)]',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A count beside an option's label. */
export function SegmentedCount({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11px] font-normal tabular-nums text-t3">{children}</span>;
}
