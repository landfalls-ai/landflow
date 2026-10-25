'use client';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'outline' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'icon' | 'icon-sm';

const variants: Record<Variant, string> = {
  primary: 'bg-ac2 text-on-ac hover:bg-ac2-hover',
  outline: 'border-bd text-t1 hover:border-ac hover:text-ac',
  ghost: 'text-t2 hover:text-ac hover:bg-acdim',
  danger: 'bg-rddim border-rdbd text-rd hover:border-rd',
};
const sizes: Record<Size, string> = {
  sm: 'h-7 px-[11px] text-[12px] gap-1.5',
  md: 'h-8 px-[15px] text-[13px] gap-[7px]',
  icon: 'size-8',
  'icon-sm': 'size-7',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

/** Pill button (Landfall `.ds-btn`). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size = 'md', loading, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-full border border-transparent font-semibold transition-colors duration-[120ms] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ac disabled:cursor-not-allowed disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
});
