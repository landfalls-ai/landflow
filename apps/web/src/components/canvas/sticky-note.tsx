'use client';
/**
 * How a sticky note looks, shared by the editor and the read-only canvases
 * (executions, version previews). Notes never run: they live in
 * `workflow.stickyNotes`, outside the engine's nodes. The palette is a set of
 * light tints mixed from the theme tokens, so each colour works in light and
 * dark mode and stays quiet next to the monochrome shell.
 */
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Markdown } from './markdown';

export const STICKY_DEFAULT_SIZE = { width: 260, height: 180 };
export const STICKY_MIN_SIZE = { width: 120, height: 80 };
export const STICKY_DEFAULT_CONTENT = '## Note\n**Double-click** to edit. Notes take Markdown: lists, `code`, [links](https://example.com).';

/** Index 0–6, the same order as n8n's sticky colours (n8n's 7, grey, is our 0). */
export const STICKY_COLORS = [
  { name: 'Neutral', base: 'var(--t2)' },
  { name: 'Yellow', base: 'var(--viz-4)' },
  { name: 'Orange', base: 'var(--viz-2)' },
  { name: 'Red', base: 'var(--rd)' },
  { name: 'Green', base: 'var(--viz-3)' },
  { name: 'Blue', base: 'var(--viz-1)' },
  { name: 'Purple', base: 'var(--viz-7)' },
] as const;

/** Background, border and swatch colours of palette entry `index`. */
export function stickyColors(index = 0) {
  const { base } = STICKY_COLORS[Math.max(0, Math.min(STICKY_COLORS.length - 1, index))] ?? STICKY_COLORS[0];
  const neutral = index === 0;
  return {
    background: `color-mix(in oklab, ${base} ${neutral ? 6 : 13}%, var(--sf))`,
    border: `color-mix(in oklab, ${base} ${neutral ? 18 : 34}%, var(--sf))`,
    swatch: neutral ? 'var(--bd)' : `color-mix(in oklab, ${base} 55%, var(--sf))`,
  };
}

export interface StickyNoteViewProps {
  content: string;
  color?: number;
  selected?: boolean;
  /** Replaces the rendered Markdown (the editor's textarea while editing). */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  onDoubleClick?: () => void;
}

/** The note itself: fills its React Flow node, Markdown inside, scrolls when the text is longer than the note. */
export function StickyNoteView({ content, color = 0, selected, children, className, style, onDoubleClick }: StickyNoteViewProps) {
  const colors = stickyColors(color);
  return (
    <div
      onDoubleClick={onDoubleClick}
      className={cn(
        'size-full overflow-hidden rounded-xl border text-[13px] leading-relaxed text-t1 transition-shadow duration-150',
        selected && 'shadow-[0_0_0_2px_var(--sf),0_0_0_4px_var(--acbd)]',
        className,
      )}
      style={{ background: colors.background, borderColor: colors.border, ...style }}
    >
      {children ?? (
        <div className="nowheel size-full overflow-y-auto px-3.5 py-3 [overflow-wrap:anywhere]">
          {content.trim() ? <Markdown text={content} className="space-y-1.5" /> : <span className="text-t3">Empty note</span>}
        </div>
      )}
    </div>
  );
}
