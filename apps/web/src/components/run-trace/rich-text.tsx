'use client';
/**
 * Text from the journal with references made links, and documents formatted. A reply that names a commit, a branch or a
 * pull request gets GitHub links when the run names a repository (lib/shared/run-repo.ts); a Markdown artifact is formatted
 * by `Doc` (react-markdown, loaded when first shown).
 */
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { linkRefs, type RunGitHub } from '@/lib/shared/run-repo';

export const Doc = dynamic(() => import('./doc-markdown'), {
  ssr: false,
  loading: () => <p className="text-[13px] text-t3">Loading…</p>,
});

/** The text with its commit SHAs, pull request numbers and the run's branch as links. */
export function LinkedText({ text, repo }: { text: string; repo?: RunGitHub }) {
  if (!repo) return <>{text}</>;
  return (
    <>
      {linkRefs(text, repo).map((part, i) =>
        'href' in part ? (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer" className="text-ac underline underline-offset-2">
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/** A reply or request as text, cut to a few lines until opened, with its references linked. */
export function TextBlock({ label, text, repo }: { label: string; text: string; repo?: RunGitHub }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 360 || text.split('\n').length > 6;
  return (
    <section className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex min-h-7 w-full items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 hover:text-t2"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {label}
      </button>
      <div className="mt-1 overflow-hidden rounded-xl border border-hair bg-sf2 px-3 py-2 text-[13px] text-t1">
        <p className={cn('whitespace-pre-wrap break-words', !open && long && 'line-clamp-5')}>
          <LinkedText text={text} repo={repo} />
        </p>
      </div>
    </section>
  );
}
