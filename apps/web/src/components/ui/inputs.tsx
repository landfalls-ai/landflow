'use client';
import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
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
