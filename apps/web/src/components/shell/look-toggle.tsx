'use client';
/**
 * The look (docs/ui-review.md#the-look): **New**, the run cards and timelines drawn after blocks.diy (a run as a
 * timeline, what a run did in one line, approvals with their evidence, members as cards, the analyst's charts, building
 * step by step), or **Classic**, the screens as they were before them. Only the drawing changes: every feature works the
 * same in both. Kept per browser, like the theme; the git branch `design-before-blocks` keeps the classic look too.
 */
import { useSyncExternalStore } from 'react';
import { LayoutList, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

export type Look = 'new' | 'classic';
const KEY = 'landflow-look';
const EVENT = 'landflow-look';

/** Runs before paint (inlined in <head>) so a classic page never flashes the new look. */
export const lookScript = `try{if(localStorage.getItem('${KEY}')==='classic')document.documentElement.dataset.look='classic'}catch(e){}`;

const read = (): Look => (typeof document !== 'undefined' && document.documentElement.dataset.look === 'classic' ? 'classic' : 'new');

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function setLook(look: Look) {
  if (look === 'classic') document.documentElement.dataset.look = 'classic';
  else delete document.documentElement.dataset.look;
  try {
    if (look === 'classic') localStorage.setItem(KEY, 'classic');
    else localStorage.removeItem(KEY);
  } catch {}
  window.dispatchEvent(new Event(EVENT));
}

/** The look this browser shows; the server draws the new one. */
export function useLook(): Look {
  return useSyncExternalStore(subscribe, read, () => 'new');
}

/** True where the new look draws something the classic one doesn't. */
export const useNewLook = () => useLook() === 'new';

const OPTIONS: Array<{ value: Look; icon: typeof Sparkles; label: string }> = [
  { value: 'new', icon: Sparkles, label: 'New look: run cards and timelines' },
  { value: 'classic', icon: LayoutList, label: 'Classic look' },
];

export function LookToggle() {
  const look = useLook();
  return (
    <div className="flex w-fit gap-0.5 rounded-lg border border-hair bg-wl p-0.5" role="radiogroup" aria-label="Look">
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          role="radio"
          aria-checked={look === value}
          title={label}
          onClick={() => setLook(value)}
          className={cn('flex h-6 items-center gap-1 rounded-md border border-transparent px-1.5 text-[11px] text-t3 transition-colors hover:text-t1', look === value && 'border-bd bg-sf text-t1 shadow-[0_1px_2px_var(--hair)]')}
        >
          <Icon className="size-3.5" />
          {value === 'new' ? 'New' : 'Classic'}
        </button>
      ))}
    </div>
  );
}
