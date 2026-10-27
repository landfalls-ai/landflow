'use client';
/**
 * The parameter editor's text field with expression support: `{{ }}`
 * segments are highlighted (a mirror layer under a transparent input), typing
 * `{{` closes the braces, and inside an expression a list suggests `$json`
 * fields from the node's input, upstream nodes (`$('Name').item.json.…`),
 * `$input`, `$now`, `$vars`, `$secrets` names (credential fields, and node
 * parameters when the instance allows it) and methods for the value's type. ↑/↓ choose,
 * Enter or Tab accept, Escape closes, ⌃Space opens. No editor dependency.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Box, Braces, Hash, Workflow } from 'lucide-react';
import { cn } from '@/lib/utils';
import { applyCompletion, completionsAt, expressionSegments, type Completion, type CompletionData, type CompletionResult } from './expression-completions';

/** Sample data for suggestions; ParamForm provides it from the node's input and upstream runs. */
export const ExpressionDataContext = createContext<CompletionData | undefined>(undefined);

/** The workflow being edited (or the project something goes to): pickers list its project's data tables, `$vars` its project's variables. */
export interface ParamScope {
  workflowId?: string;
  projectId?: string;
  /** The agent being edited: pickers of project-scoped things list its project's. */
  agentId?: string;
}
export const ParamScopeContext = createContext<ParamScope | undefined>(undefined);

// `$vars` names (of a workflow: its project's and the instance's), fetched once per page load and workflow (the
// variables API may not exist yet: then there are none).
const varsPromises = new Map<string, Promise<string[]>>();
export function loadVars(workflowId?: string): Promise<string[]> {
  const key = workflowId ?? '';
  const cached = varsPromises.get(key);
  if (cached) return cached;
  const varsPromise = fetch(`/api/variables${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ''}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : undefined))
    .then((body: unknown) => {
      const list = Array.isArray(body) ? body : (body as { variables?: unknown[] } | undefined)?.variables;
      return (list ?? []).map((v) => (typeof v === 'string' ? v : ((v as { key?: string; name?: string }).key ?? (v as { name?: string }).name))).filter((v): v is string => Boolean(v));
    })
    .catch(() => [] as string[]);
  varsPromises.set(key, varsPromise);
  return varsPromise;
}

// External secrets names by provider (GET /api/external-secrets, never values) and whether node parameters may read
// them (Settings → External secrets); once per page load.
interface SecretsAccess {
  names: Record<string, string[]>;
  allowInParameters: boolean;
}
let secretsPromise: Promise<SecretsAccess> | undefined;
function loadSecretsAccess(): Promise<SecretsAccess> {
  secretsPromise ??= fetch('/api/external-secrets', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : undefined))
    .then((body: { providers?: Array<{ name: string; enabled: boolean; names: string[] }>; allowInParameters?: boolean } | undefined) => ({
      names: Object.fromEntries((body?.providers ?? []).filter((p) => p.enabled).map((p) => [p.name, p.names])),
      allowInParameters: body?.allowInParameters === true,
    }))
    .catch(() => ({ names: {}, allowInParameters: false }));
  return secretsPromise;
}
export const loadSecretNames = (): Promise<Record<string, string[]>> => loadSecretsAccess().then((access) => access.names);

const field = 'w-full rounded-[10px] border px-3 text-[13px] transition-colors duration-[120ms]';
const KIND_ICON: Record<Completion['kind'], ReactNode> = {
  variable: <Braces className="size-3" />,
  field: <Box className="size-3" />,
  method: <span className="font-mono text-[10px] leading-none">ƒ</span>,
  node: <Workflow className="size-3" />,
  keyword: <Hash className="size-3" />,
};

export interface ExpressionInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** A textarea with this many rows instead of a single line. */
  rows?: number;
  className?: string;
  /** Plain field: no highlighting or suggestions (noDataExpression parameters). */
  plain?: boolean;
  'aria-label'?: string;
}

export function ExpressionInput({ value, onChange, placeholder, rows, className, plain, ...aria }: ExpressionInputProps) {
  const multiline = Boolean(rows && rows > 1);
  const expression = !plain && value.includes('{{');
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | undefined>(undefined);
  const data = useContext(ExpressionDataContext);
  const workflowId = useContext(ParamScopeContext)?.workflowId;
  const [vars, setVars] = useState<string[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string[]>>();
  const [menu, setMenu] = useState<(CompletionResult & { active: number }) | null>(null);
  const [rect, setRect] = useState<DOMRect>();

  const credentialField = data?.scope === 'credential';
  const fullData = useMemo<CompletionData>(
    () => ({ json: data?.json, nodes: data?.nodes ?? [], vars, ...(credentialField ? { scope: 'credential' as const, secrets: secrets ?? {} } : secrets && { secrets }) }),
    [data, vars, credentialField, secrets],
  );

  useEffect(() => {
    if (expression && credentialField) void loadSecretNames().then(setSecrets);
    else if (expression) {
      void loadVars(workflowId).then(setVars);
      // Node parameters: $secrets names only when the instance allows them there.
      void loadSecretsAccess().then((access) => setSecrets(access.allowInParameters ? access.names : undefined));
    }
  }, [expression, credentialField, workflowId]);

  /** Keep the highlight layer scrolled like the field. */
  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (multiline && mirror.current) mirror.current.scrollTop = el.scrollTop;
    if (!multiline && inner.current) inner.current.style.transform = `translateX(${-el.scrollLeft}px)`;
  }, [multiline]);

  const refresh = useCallback(
    (text: string, caret: number, force = false) => {
      if (plain) return setMenu(null);
      const result = completionsAt(text, caret, fullData);
      if (!result || (!result.items.length && !(force && result.hint))) return setMenu(null);
      setRect(ref.current?.getBoundingClientRect());
      setMenu({ ...result, active: 0 });
    },
    [fullData, plain],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pendingCaret.current !== undefined) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = undefined;
    }
    sync();
  }, [value, sync]);

  // The list is fixed-positioned: close it when the page under it scrolls or resizes.
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

  const write = (text: string, caret: number, reopen = false) => {
    pendingCaret.current = caret;
    onChange(text);
    if (reopen) requestAnimationFrame(() => refresh(text, caret, true));
    else setMenu(null);
  };

  const accept = (item: Completion) => {
    if (!menu) return;
    const next = applyCompletion(value, menu, item);
    write(next.text, next.caret, item.reopen);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (menu && menu.items.length) {
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
    if (plain) return;
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      refresh(value, el.selectionStart ?? value.length, true);
      return;
    }
    // `{{` → `{{ | }}`
    const start = el.selectionStart ?? 0;
    if (e.key === '{' && start === el.selectionEnd && value[start - 1] === '{' && !value.slice(start).startsWith('}')) {
      e.preventDefault();
      const text = `${value.slice(0, start)}{  }}${value.slice(start)}`;
      write(text, start + 2);
      requestAnimationFrame(() => refresh(text, start + 2));
    }
  };

  const shared = {
    ref,
    value,
    placeholder,
    spellCheck: false,
    ...aria,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(e.target.value);
      refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
    },
    onKeyDown,
    onKeyUp: (e: KeyboardEvent) => {
      sync();
      if (menu && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) setMenu(null);
    },
    onScroll: sync,
    onSelect: sync,
    onClick: () => setMenu(null),
    onBlur: () => setTimeout(() => setMenu(null), 120),
    className: cn(
      field,
      'relative block border-hair bg-wl text-t1 outline-none placeholder:text-t3 focus:border-ac',
      multiline ? 'resize-y py-2 leading-relaxed' : 'h-9',
      expression && 'border-acbd bg-transparent font-mono text-transparent caret-t1 selection:bg-acbd focus:border-ac',
      className,
    ),
  };

  const segments = expression ? expressionSegments(value) : [];
  const highlighted = segments.map((s, i) =>
    s.kind === 'text' ? (
      <span key={i}>{s.text}</span>
    ) : s.kind === 'brace' ? (
      <span key={i} className="text-t3">
        {s.text}
      </span>
    ) : (
      <span key={i} className="rounded-sm bg-[color-mix(in_oklab,var(--viz-7)_12%,transparent)] text-viz-7">
        {s.text}
      </span>
    ),
  );

  return (
    <div className="relative">
      {expression &&
        (multiline ? (
          <div
            ref={mirror}
            aria-hidden
            className={cn(field, 'pointer-events-none absolute inset-0 overflow-y-auto whitespace-pre-wrap border-transparent bg-acdim py-2 font-mono leading-relaxed text-t1 [overflow-wrap:break-word] [scrollbar-color:transparent_transparent]')}
          >
            {highlighted}
            {value.endsWith('\n') ? ' ' : null}
          </div>
        ) : (
          <div aria-hidden className={cn(field, 'pointer-events-none absolute inset-0 border-transparent bg-acdim font-mono leading-[34px] text-t1')}>
            <div className="size-full overflow-hidden">
              <div ref={inner} className="whitespace-pre">
                {highlighted}
              </div>
            </div>
          </div>
        ))}
      {multiline ? <textarea rows={rows} {...shared} /> : <input type="text" {...shared} />}
      {menu && rect && <CompletionMenu menu={menu} rect={rect} onPick={accept} onHover={(active) => setMenu({ ...menu, active })} />}
    </div>
  );
}

export function CompletionMenu({ menu, rect, onPick, onHover }: { menu: CompletionResult & { active: number }; rect: DOMRect; onPick: (item: Completion) => void; onHover: (index: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${menu.active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [menu.active]);
  const below = window.innerHeight - rect.bottom > 260 || rect.top < 260;
  return createPortal(
    <div
      id="lf-expression-menu"
      role="listbox"
      ref={list}
      onMouseDown={(e) => e.preventDefault()}
      style={{ left: rect.left, width: Math.max(rect.width, 320), ...(below ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }) }}
      className="fixed z-[60] max-h-[240px] animate-in overflow-y-auto rounded-xl border border-hair bg-sf p-1 shadow-pop"
    >
      {menu.items.map((item, i) => (
        <button
          key={`${item.label}-${i}`}
          data-index={i}
          role="option"
          aria-selected={i === menu.active}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(item)}
          className={cn('flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left', i === menu.active ? 'bg-acdim' : 'hover:bg-acdim')}
        >
          <span className={cn('grid size-5 shrink-0 place-items-center rounded-md border border-hair', item.kind === 'node' ? 'text-viz-1' : item.kind === 'method' ? 'text-viz-7' : 'text-t2')}>
            {KIND_ICON[item.kind]}
          </span>
          <span className="min-w-0 truncate font-mono text-[12px] text-t1">{item.label}</span>
          {item.detail && <span className="ml-auto min-w-0 shrink truncate pl-2 text-[11px] text-t3">{item.detail}</span>}
        </button>
      ))}
      {!menu.items.length && menu.hint && <div className="px-2 py-1.5 text-[12px] text-t3">{menu.hint}</div>}
      <div className="mt-1 flex items-center gap-2 border-t border-hair px-2 pb-0.5 pt-1.5 text-[10px] text-t3">
        <span>↑↓ choose</span>
        <span>↵ or Tab insert</span>
        <span>Esc close</span>
      </div>
    </div>,
    document.body,
  );
}
