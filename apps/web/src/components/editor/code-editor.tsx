'use client';
/**
 * The code editor of the Code node (JavaScript, Python) and other `code` / `json` parameters: a plain textarea, so the
 * value stays a string and the browser's editing (undo, selection, IME, spellcheck off) just works, over a highlight
 * layer drawn from the same text (./code-highlight.ts), as the expression field does. No editor dependency.
 *
 * Tab and ⇧Tab indent and outdent (the selected lines too), Enter keeps the line's indentation (one more after `{`,
 * `[`, `(` or Python's `:`), ⌘/ toggles line comments. In JavaScript, typing `$` suggests the workflow's names
 * (`$json` fields from the node's input, `$input`, `$('Node')`…), in Python the `_` ones; ↑↓ choose, Enter or Tab
 * insert, Esc closes, ⌃Space opens. The list follows the caret.
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { applyCompletion, type Completion, type CompletionData, type CompletionResult } from './expression-completions';
import { CompletionMenu, ExpressionDataContext, loadVars } from './expression-input';
import { codeEditorCompletions, highlightCode, type CodeLanguage, type TokenKind } from './code-highlight';

const field = 'w-full rounded-[10px] border px-3 py-2 transition-colors duration-[120ms]';

/** Colours mixed towards the text colour, so they keep their contrast in light and dark mode. */
const TOKEN_CLASS: Record<TokenKind, string | undefined> = {
  plain: undefined,
  keyword: 'text-[color-mix(in_oklab,var(--viz-7)_80%,var(--t1))]',
  literal: 'text-[color-mix(in_oklab,var(--viz-2)_78%,var(--t1))]',
  number: 'text-[color-mix(in_oklab,var(--viz-2)_78%,var(--t1))]',
  string: 'text-[color-mix(in_oklab,var(--viz-3)_70%,var(--t1))]',
  comment: 'text-t3',
  variable: 'text-[color-mix(in_oklab,var(--viz-1)_82%,var(--t1))]',
  function: 'text-[color-mix(in_oklab,var(--viz-5)_68%,var(--t1))]',
  property: 'text-[color-mix(in_oklab,var(--viz-1)_70%,var(--t1))]',
  expression: 'rounded-sm bg-[color-mix(in_oklab,var(--viz-7)_12%,transparent)] text-viz-7',
  brace: 'text-t3',
};

const COMMENT: Partial<Record<CodeLanguage, string>> = { javascript: '//', python: '#' };
const OPENERS: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
const TAB_SIZE = 2;

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: CodeLanguage;
  rows?: number;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}

/** Where a character offset is drawn in the field: its line and column (tabs expanded). */
function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  let column = 0;
  for (const c of before.slice(before.lastIndexOf('\n') + 1)) column = c === '\t' ? column + TAB_SIZE - (column % TAB_SIZE) : column + 1;
  return { line, column };
}

export function CodeEditor({ value, onChange, language, rows = 8, placeholder, className, ...aria }: CodeEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const charWidth = useRef<number>(undefined);
  const data = useContext(ExpressionDataContext);
  const [vars, setVars] = useState<string[]>([]);
  const [menu, setMenu] = useState<(CompletionResult & { active: number }) | null>(null);
  const [anchor, setAnchor] = useState<DOMRect>();
  const tokens = useMemo(() => highlightCode(value, language), [value, language]);
  const unit = language === 'python' ? '    ' : '  ';
  const completes = language === 'javascript' || language === 'python';
  const fullData = useMemo<CompletionData>(() => ({ json: data?.json, nodes: data?.nodes ?? [], vars }), [data, vars]);

  useEffect(() => {
    if (completes) void loadVars().then(setVars);
  }, [completes]);

  /** Keep the highlight layer scrolled like the field. */
  const sync = useCallback(() => {
    const el = ref.current;
    if (!el || !mirror.current) return;
    mirror.current.scrollTop = el.scrollTop;
    mirror.current.scrollLeft = el.scrollLeft;
  }, []);
  useLayoutEffect(sync, [value, sync]);

  /** The caret's line on screen, for the suggestion list (monospace: columns times the width of a character). */
  const caretRect = useCallback((text: string, caret: number): DOMRect | undefined => {
    const el = ref.current;
    if (!el) return undefined;
    const style = getComputedStyle(el);
    if (charWidth.current === undefined) {
      const context = document.createElement('canvas').getContext('2d');
      if (context) context.font = `${style.fontSize} ${style.fontFamily}`;
      charWidth.current = context ? context.measureText('0000000000').width / 10 : 7.5;
    }
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const { line, column } = lineAndColumn(text, caret);
    const box = el.getBoundingClientRect();
    const left = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) + column * charWidth.current - el.scrollLeft;
    const top = box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) + line * lineHeight - el.scrollTop;
    return new DOMRect(Math.min(left, window.innerWidth - 336), top, 320, lineHeight);
  }, []);

  const refresh = useCallback(
    (text: string, caret: number, force = false) => {
      if (!completes) return setMenu(null);
      const result = codeEditorCompletions(text, caret, language, fullData, highlightCode(text, language));
      if (!result || (!result.items.length && !(force && result.hint))) return setMenu(null);
      setAnchor(caretRect(text, caret));
      setMenu({ ...result, active: 0 });
    },
    [completes, language, fullData, caretRect],
  );

  // The list is fixed-positioned: close it when something scrolls or the window resizes.
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e.target instanceof Node && document.getElementById('lf-expression-menu')?.contains(e.target)) return;
      setMenu(null);
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  /** Replace `start`–`end` with `text` through the browser's editing, so ⌘Z undoes it; select `select` afterwards. */
  const edit = (start: number, end: number, text: string, select?: [number, number]) => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(start, end);
    // insertText fires the input event (and so onChange); without it, write the value ourselves.
    const done = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
    if (!done) {
      el.setRangeText(text, start, end, 'end');
      onChange(el.value);
    }
    if (select) el.setSelectionRange(select[0], select[1]);
  };

  /** The selected lines (or the caret's): where they start and end. */
  const selectedLines = (el: HTMLTextAreaElement) => {
    const { selectionStart, selectionEnd } = el;
    const from = value.lastIndexOf('\n', selectionStart - 1) + 1;
    // A selection ending at the start of a line doesn't take that line.
    const last = selectionEnd > selectionStart && value[selectionEnd - 1] === '\n' ? selectionEnd - 1 : selectionEnd;
    const lineEnd = value.indexOf('\n', last);
    return { from, to: lineEnd < 0 ? value.length : lineEnd, selectionStart, selectionEnd };
  };

  const accept = (item: Completion) => {
    if (!menu) return;
    // As applyCompletion does it, but as an edit of the field (so ⌘Z takes it back).
    const next = applyCompletion(value, menu, item);
    const from = item.replaceDot && value[menu.from - 1] === '.' ? menu.from - 1 : menu.from;
    edit(from, menu.to, item.insert, [next.caret, next.caret]);
    if (item.reopen) requestAnimationFrame(() => refresh(next.text, next.caret, true));
    else setMenu(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (menu?.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setMenu({ ...menu, active: (menu.active + step + menu.items.length) % menu.items.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept(menu.items[menu.active]);
        return;
      }
    }
    if (menu && e.key === 'Escape') {
      // Close the list, not the node panel.
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
      return;
    }
    if (e.key === ' ' && e.ctrlKey && completes) {
      e.preventDefault();
      refresh(value, el.selectionStart, true);
      return;
    }
    if (e.key === 'Tab' && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const { from, to, selectionStart, selectionEnd } = selectedLines(el);
      const block = value.slice(from, to);
      if (e.shiftKey) {
        // Outdent: up to one level of leading spaces (or a tab) off each line.
        const lines = block.split('\n');
        const removed = lines.map((line) => (line.startsWith('\t') ? 1 : Math.min(unit.length, /^ */.exec(line)![0].length)));
        const next = lines.map((line, i) => line.slice(removed[i])).join('\n');
        if (next === block) return;
        edit(from, to, next, [Math.max(from, selectionStart - removed[0]), Math.max(from, selectionEnd - (block.length - next.length))]);
      } else if (selectionStart !== selectionEnd && block.includes('\n')) {
        const next = block.replace(/^/gm, unit);
        edit(from, to, next, [selectionStart + unit.length, selectionEnd + (next.length - block.length)]);
      } else edit(selectionStart, selectionEnd, unit);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
      // Keep the line's indentation; one level more after an opening bracket (or Python's colon).
      const { selectionStart, selectionEnd } = el;
      const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
      const indent = /^[ \t]*/.exec(value.slice(lineStart, selectionStart))![0];
      const before = value.slice(lineStart, selectionStart).trimEnd();
      const opener = before.at(-1) ?? '';
      const deeper = Boolean(OPENERS[opener]) || (language === 'python' && opener === ':');
      e.preventDefault();
      if (deeper && OPENERS[opener] && value[selectionEnd] === OPENERS[opener]) {
        // Between a pair of brackets: the closing one goes on its own line.
        const text = `\n${indent}${unit}\n${indent}`;
        const caret = selectionStart + 1 + indent.length + unit.length;
        edit(selectionStart, selectionEnd, text, [caret, caret]);
      } else edit(selectionStart, selectionEnd, `\n${indent}${deeper ? unit : ''}`);
      return;
    }
    if (e.key === '/' && (e.metaKey || e.ctrlKey) && COMMENT[language]) {
      e.preventDefault();
      const mark = COMMENT[language]!;
      const { from, to, selectionStart, selectionEnd } = selectedLines(el);
      const block = value.slice(from, to);
      const lines = block.split('\n');
      const commented = lines.filter((l) => l.trim()).every((l) => l.trimStart().startsWith(mark));
      const next = lines
        .map((line) => {
          if (!line.trim()) return line;
          const lead = /^[ \t]*/.exec(line)![0];
          const rest = line.slice(lead.length);
          return commented ? lead + rest.slice(mark.length).replace(/^ /, '') : `${lead}${mark} ${rest}`;
        })
        .join('\n');
      const delta = next.length - block.length;
      edit(from, to, next, [Math.max(from, selectionStart + (lines.length === 1 ? delta : 0)), selectionEnd + delta]);
    }
  };

  const highlighted = tokens.map((token, i) => {
    const className = TOKEN_CLASS[token.kind];
    return className ? (
      <span key={i} className={className}>
        {token.text}
      </span>
    ) : (
      token.text
    );
  });

  return (
    <div className="relative">
      <div ref={mirror} aria-hidden className={cn(field, 'code-area pointer-events-none absolute inset-0 overflow-hidden whitespace-pre border-transparent bg-wl text-t1')}>
        {/* Room past the end, so the layer can scroll as far as the field (whose scrollbars take space). */}
        <div className="w-max min-w-full pb-5 pr-5">
          {highlighted}
          {value.endsWith('\n') ? ' ' : null}
        </div>
      </div>
      <textarea
        ref={ref}
        rows={rows}
        wrap="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={value}
        placeholder={placeholder}
        data-language={language}
        {...aria}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          sync();
          if (menu && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) setMenu(null);
        }}
        onScroll={sync}
        onSelect={sync}
        onClick={() => setMenu(null)}
        onBlur={() => setTimeout(() => setMenu(null), 120)}
        className={cn(
          field,
          'code-area relative block min-h-[120px] resize-y overflow-auto whitespace-pre border-hair bg-transparent text-transparent caret-t1 outline-none placeholder:text-t3 selection:bg-acbd focus:border-ac',
          className,
        )}
      />
      {menu && anchor && <CompletionMenu menu={menu} rect={anchor} onPick={accept} onHover={(active) => setMenu({ ...menu, active })} />}
    </div>
  );
}
