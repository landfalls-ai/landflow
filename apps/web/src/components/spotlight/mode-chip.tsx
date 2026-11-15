'use client';
/** The chip in Spotlight's header that says what it is doing here (docs/spotlight.md#the-mode-chip). */
import { useState } from 'react';
import { Brain, ChevronDown, Hammer, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SpotlightMode } from './context';

/** "Building Ticket router", "Asking the brain", "About run #12". */
export function chipLabel(mode: SpotlightMode): string {
  switch (mode.kind) {
    case 'build':
      return `Building ${mode.name}`;
    case 'brain':
      return 'Asking the brain';
    case 'about':
      return `About ${mode.ref.name}`;
  }
}

const ICONS = { build: Hammer, brain: Brain, about: Sparkles } as const;

/** With `switchTo` the chip is a button that offers the other mode ("Ask the brain instead"); without, it only says. */
export function ModeChip({ mode, switchTo, className }: { mode: SpotlightMode; switchTo?: { label: string; run: () => void }; className?: string }) {
  const [menu, setMenu] = useState(false);
  const Icon = ICONS[mode.kind];
  const look = 'inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-hair bg-bg px-2 py-0.5 text-[12px] font-medium text-t1';
  const body = (
    <>
      <Icon className="size-3.5 shrink-0 text-viz-7" aria-hidden />
      <span className="truncate" data-mode={mode.kind}>
        {chipLabel(mode)}
      </span>
    </>
  );
  if (!switchTo) return <span className={cn(look, className)}>{body}</span>;
  return (
    <span className={cn('relative inline-flex min-w-0 max-w-full', className)}>
      <button type="button" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu} className={cn(look, 'hover:border-ac')}>
        {body}
        <ChevronDown className="size-3 shrink-0 text-t3" aria-hidden />
      </button>
      {menu && (
        <span role="menu" className="absolute left-0 top-full z-50 mt-1 min-w-[180px] rounded-lg border border-hair bg-sf p-1 shadow-pop">
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              setMenu(false);
              switchTo.run();
            }}
            onKeyDown={(e) => e.key === 'Escape' && setMenu(false)}
            className="flex min-h-8 w-full items-center rounded-md px-2 text-left text-[12.5px] text-t1 hover:bg-acdim max-md:min-h-11"
          >
            {switchTo.label}
          </button>
        </span>
      )}
    </span>
  );
}
