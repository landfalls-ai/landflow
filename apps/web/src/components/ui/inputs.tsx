'use client';
import { forwardRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type RefObject, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const field = 'w-full rounded-[10px] border border-hair bg-wl px-3 text-[13px] text-t1 placeholder:text-t3 outline-none transition-colors duration-[120ms] focus:border-ac';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(field, 'h-9', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(field, 'resize-y py-2 leading-relaxed', className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return (
    <div className="relative">
      <select ref={ref} className={cn(field, 'h-9 appearance-none pr-8', className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-t3" />
    </div>
  );
});

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-[120ms] disabled:opacity-50', checked ? 'border-ac2 bg-ac2' : 'border-bd bg-wl')}
    >
      <span className={cn('size-3.5 rounded-full shadow-sm transition-transform duration-[120ms]', checked ? 'translate-x-[18px] bg-on-ac' : 'translate-x-[2px] bg-t3')} />
    </button>
  );
}

/**
 * The search field above a list (docs/ui-review.md#controls): a pill with the magnifier, × to clear, Escape clears too
 * (and only then lets Escape through to close a dialog). 32 px, 44 px on a phone; `className` sets its width.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  className,
  autoFocus,
  inputRef,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** For a screen reader; the placeholder when not given. */
  label?: string;
  className?: string;
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className={cn('relative w-[240px] max-md:w-full', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented || e.key !== 'Escape' || !value) return;
          e.preventDefault();
          e.stopPropagation();
          onChange('');
        }}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className={cn(field, 'h-8 rounded-full pl-8 pr-8 max-md:h-11 [&::-webkit-search-cancel-button]:appearance-none')}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:right-0 max-md:size-11"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** A checkbox in the accent colour, with its label beside it when given (a 44 px row on a phone). */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  className,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const box = (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.checked)}
      className="size-4 shrink-0 cursor-pointer accent-[var(--ac2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ac disabled:cursor-not-allowed"
    />
  );
  if (!label) return box;
  return (
    <label className={cn('flex w-fit cursor-pointer select-none items-center gap-2 text-[13px] text-t2 max-md:min-h-11', disabled && 'cursor-not-allowed opacity-60', className)}>
      {box}
      {label}
    </label>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-hair bg-wl px-1.5 py-px font-mono text-[10px] text-t3">{children}</kbd>;
}

export function FieldLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mb-[5px] text-[12px] font-semibold text-t2', className)}>{children}</div>;
}

/** Small uppercase section label — the one place the type scale allows uppercase. */
export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('text-[11px] font-semibold uppercase tracking-[0.06em] text-t3', className)}>{children}</div>;
}
