'use client';
/** A small icon button that copies `text` and shows a check for a moment. */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error('Could not copy to the clipboard'),
    );
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={copied ? 'Copied' : label}
      className={cn('grid size-7 shrink-0 place-items-center rounded-full text-t3 transition-colors duration-[120ms] hover:bg-acdim hover:text-ac', className)}
    >
      {copied ? <Check className="size-3.5 text-gn" /> : <Copy className="size-3.5" />}
    </button>
  );
}
