'use client';
/**
 * Tagging with @ (docs/assistant.md#tagging-with-): the listbox the `@` opens above the box and the chips a choice
 * leaves. The listbox is a 320 px popover on a desktop (the host puts it inside a `relative` wrapper around the composer)
 * and a full-width sheet above the keyboard on a phone. The behaviour (keys, search, recents) is in
 * lib/client/use-mention-picker.ts; this file only draws.
 */
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { flatHits, mentionKey, optionId, type MentionHit, type MentionRef, type PickerSection } from '@/lib/shared/mentions';

export function MentionListbox({
  id,
  sections,
  activeIndex,
  onChoose,
  phone,
  loading,
  keyboardInset = 0,
}: {
  id: string;
  sections: readonly PickerSection[];
  activeIndex: number;
  onChoose: (hit: MentionHit) => void;
  phone: boolean;
  loading?: boolean;
  /** Phone: how far the on-screen keyboard covers the bottom of the page, so the sheet sits above it. */
  keyboardInset?: number;
}) {
  const total = flatHits(sections).length;
  let index = -1;
  const list = (
    <div
      id={id}
      role="listbox"
      aria-label="Tag something"
      className={cn(
        'overflow-y-auto border border-hair bg-sf shadow-pop',
        phone ? 'fixed inset-x-0 z-[60] max-h-[50dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]' : 'absolute bottom-full left-0 z-30 mb-2 max-h-72 w-[320px] rounded-xl',
      )}
      style={phone ? { bottom: keyboardInset } : undefined}
    >
      {sections.map((section) => (
        <div key={section.key} role="group" aria-label={section.label}>
          <div className="px-3 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-t3">{section.label}</div>
          {section.items.map((hit) => {
            index++;
            const active = index === activeIndex;
            return (
              <div
                key={`${section.key}-${mentionKey(hit)}`}
                id={optionId(id, index)}
                role="option"
                aria-selected={active}
                // Keep the focus in the box: a press on an option must not blur it.
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => onChoose(hit)}
                className={cn('flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-[13px] max-md:min-h-11 max-md:items-center', active ? 'bg-acdim text-t1' : 'text-t2 hover:bg-acdim')}
              >
                <span className="min-w-0 truncate font-medium text-t1">{hit.name}</span>
                {hit.hint && <span className="min-w-0 shrink-[2] truncate text-[11.5px] text-t3">{hit.hint}</span>}
              </div>
            );
          })}
        </div>
      ))}
      {!total && <div className="px-3 py-3 text-[12px] text-t3">{loading ? 'Looking…' : 'Nothing found'}</div>}
    </div>
  );
  // On a phone the sheet is portalled, so no scrolling parent clips it.
  return phone && typeof document !== 'undefined' ? createPortal(list, document.body) : list;
}

/** The tags chosen so far, for the composer's `top` slot. Each has an × (a 44 px hit area on a phone). */
export function MentionChips({ chips, onRemove }: { chips: readonly MentionHit[]; onRemove: (ref: MentionRef) => void }) {
  if (!chips.length) return null;
  return (
    <ul className="mb-1.5 flex flex-wrap gap-1.5" aria-label="Tagged">
      {chips.map((chip) => (
        <li key={mentionKey(chip)} className="inline-flex h-7 max-w-full items-center gap-0.5 rounded-full border border-hair bg-sf pl-2.5 pr-0.5 text-[12px] text-t1">
          <span className="min-w-0 truncate">@{chip.name}</span>
          <button
            type="button"
            onClick={() => onRemove(chip)}
            aria-label={`Remove @${chip.name}`}
            className="grid size-6 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:-my-2 max-md:size-11"
          >
            <X className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}
