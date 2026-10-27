'use client';
/**
 * The find and replace bar of the code editor (⌘/Ctrl-F, ⌘/Ctrl-H): a query with case, whole-word and regular-expression
 * toggles, a match counter, previous and next, and a replace row. The editor owns the state and does the searching
 * (./code-editing.ts); this only draws it and reports keys.
 */
import { forwardRef, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SearchOptions } from './code-editing';

export interface SearchState {
  query: string;
  replacement: string;
  replacing: boolean;
  options: SearchOptions;
}

interface Props {
  state: SearchState;
  /** Matches found and the current one (-1: none); `error` is a bad regular expression. */
  count: number;
  current: number;
  truncated?: boolean;
  error?: string;
  onChange: (state: SearchState) => void;
  onStep: (direction: 1 | -1) => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

const input = 'min-w-0 flex-1 rounded-md border border-hair bg-wl px-2 py-1 text-[12px] text-t1 outline-none placeholder:text-t3 focus:border-ac';
const tool = 'inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1 text-[11px] font-medium text-t2 transition-colors hover:bg-acdim hover:text-t1 disabled:opacity-40 disabled:hover:bg-transparent';

export const CodeSearchBar = forwardRef<HTMLInputElement, Props>(function CodeSearchBar({ state, count, current, truncated, error, onChange, onStep, onReplace, onReplaceAll, onClose }, ref) {
  const set = (patch: Partial<SearchState>) => onChange({ ...state, ...patch });
  const toggle = (key: keyof SearchOptions) => set({ options: { ...state.options, [key]: !state.options[key] } });
  const onKeys = (e: KeyboardEvent<HTMLInputElement>, enter: () => void) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      enter();
    } else if ((e.key === 'g' || e.key === 'G') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onStep(e.shiftKey ? -1 : 1);
    }
  };
  const label = error ? 'Invalid' : !state.query ? '' : count === 0 ? 'No results' : `${current + 1} of ${count}${truncated ? '+' : ''}`;
  const toggleClass = (on?: boolean) => cn(tool, on && 'bg-acdim text-t1');

  return (
    <div role="search" className="absolute right-2 top-2 z-10 flex w-[min(22rem,calc(100%-1rem))] flex-col gap-1 rounded-xl border border-hair bg-sf p-1.5 shadow-pop">
      <div className="flex items-center gap-1">
        <button type="button" className={tool} aria-label="Toggle replace" aria-expanded={state.replacing} onClick={() => set({ replacing: !state.replacing })}>
          <ChevronRight className={cn('size-3.5 transition-transform', state.replacing && 'rotate-90')} />
        </button>
        <input
          ref={ref}
          className={cn(input, error && 'border-rd')}
          placeholder="Find"
          aria-label="Find"
          aria-invalid={Boolean(error)}
          title={error}
          value={state.query}
          spellCheck={false}
          onChange={(e) => set({ query: e.target.value })}
          onKeyDown={(e) => onKeys(e, () => onStep(e.shiftKey ? -1 : 1))}
        />
        <span className="w-[4.5rem] shrink-0 text-right text-[11px] tabular-nums text-t3" aria-live="polite">
          {label}
        </span>
        <button type="button" className={toggleClass(state.options.caseSensitive)} aria-label="Match case" aria-pressed={Boolean(state.options.caseSensitive)} title="Match case" onClick={() => toggle('caseSensitive')}>
          Aa
        </button>
        <button type="button" className={toggleClass(state.options.wholeWord)} aria-label="Whole word" aria-pressed={Boolean(state.options.wholeWord)} title="Whole word" onClick={() => toggle('wholeWord')}>
          <span className="underline underline-offset-2">ab</span>
        </button>
        <button type="button" className={toggleClass(state.options.regex)} aria-label="Regular expression" aria-pressed={Boolean(state.options.regex)} title="Regular expression" onClick={() => toggle('regex')}>
          .*
        </button>
        <button type="button" className={tool} aria-label="Previous match" title="Previous (⇧Enter)" disabled={!count} onClick={() => onStep(-1)}>
          <ArrowUp className="size-3.5" />
        </button>
        <button type="button" className={tool} aria-label="Next match" title="Next (Enter)" disabled={!count} onClick={() => onStep(1)}>
          <ArrowDown className="size-3.5" />
        </button>
        <button type="button" className={tool} aria-label="Close search" title="Close (Esc)" onClick={onClose}>
          <X className="size-3.5" />
        </button>
      </div>
      {state.replacing && (
        <div className="flex items-center gap-1 pl-7">
          <input
            className={input}
            placeholder="Replace"
            aria-label="Replace with"
            value={state.replacement}
            spellCheck={false}
            onChange={(e) => set({ replacement: e.target.value })}
            onKeyDown={(e) => onKeys(e, onReplace)}
          />
          <button type="button" className={cn(tool, 'px-2')} disabled={!count} onClick={onReplace}>
            Replace
          </button>
          <button type="button" className={cn(tool, 'px-2')} disabled={!count} onClick={onReplaceAll}>
            All
          </button>
        </div>
      )}
    </div>
  );
});
