'use client';
/**
 * Filters that take a phone's first screen (docs/mobile.md#filters): on a desktop the children render where they are,
 * unchanged; on a phone a **Filters** button (with how many are on) opens them in a sheet, so the content starts near the
 * top.
 */
import { useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { usePhone } from '@/lib/client/use-phone';
import { cn } from '@/lib/utils';
import { Sheet } from './sheet';

export function PhoneFilters({
  children,
  active = 0,
  onClear,
  onApply,
  className,
}: {
  children: ReactNode;
  active?: number;
  onClear?: () => void;
  /** Run when **Show results** closes the sheet, for filters that only apply on a search. */
  onApply?: () => void;
  className?: string;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  if (!phone) return <>{children}</>;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={cn('inline-flex h-10 items-center gap-2 self-start rounded-full border px-4 text-[14px]', active ? 'border-ac bg-acdim font-semibold text-ac' : 'border-hair bg-sf text-t1', className)}
      >
        <SlidersHorizontal className="size-4" /> Filters
        {active > 0 && <span className="rounded-full bg-ac2 px-1.5 text-[11px] font-semibold leading-[18px] text-on-ac">{active}</span>}
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Filters"
        footer={
          <div className="flex items-center gap-2">
            {onClear && active > 0 && (
              <button type="button" onClick={onClear} className="h-11 rounded-full px-4 text-[14px] font-semibold text-t2 hover:text-t1">
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onApply?.();
              }}
              className="ml-auto h-11 rounded-full bg-ac2 px-5 text-[14px] font-semibold text-on-ac">
              Show results
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">{children}</div>
      </Sheet>
    </>
  );
}
