'use client';
/**
 * A single-select combobox on cmdk (docs/ui-review.md#controls): a trigger that shows the pick, and a list under it with
 * a search box: type to filter, arrows, Home, End and Enter, grouped options with a hint line and an icon, an empty line,
 * and, with `creation`, a "Create “text”" row for text nothing matches. Below `md` the list is a full-width bottom sheet
 * with the search on top. The filter and the keys are `combobox-model.ts`; cmdk only draws the listbox (its roles and
 * `aria-activedescendant`), and its own keys are taken over so there is one source of truth. Written fresh on cmdk;
 * nothing is copied from another code base.
 */
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Command } from 'cmdk';
import { Check, ChevronDown, Plus, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePhone } from '@/lib/client/use-phone';
import { NodeIcon } from './icon';
import { Sheet } from './sheet';
import { creationVisible, narrowLine, onKey, visibleOptions, type ComboKey, type ComboOption, type ComboState } from './combobox-model';

export type { ComboOption } from './combobox-model';

/** cmdk's value for the creation row: no option may carry it. */
const CREATE_ROW = 'combobox:create';
const KEYS: ReadonlySet<string> = new Set<ComboKey>(['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape']);

export interface ComboboxCreation {
  /** The row's words; default `Create “text”`. */
  label?: (text: string) => string;
  onCreate: (text: string) => void;
}

interface PanelProps {
  id: string;
  label: string;
  options: ComboOption[];
  value: string | undefined;
  query: string;
  active: number;
  onActive: (row: number) => void;
  onQuery: (query: string) => void;
  onPick: (value: string) => void;
  onCreate: (text: string) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  creation?: ComboboxCreation | { label?: (text: string) => string; onCreate: () => void };
  emptyText?: string;
  autoFocus?: boolean;
  className?: string;
}

/** The search box and the list: what the popover and the phone sheet both hold. Exported for the tests, which render it to static markup. */
export function ComboboxPanel({ id, label, options, value, query, active, onActive, onQuery, onPick, onCreate, onKeyDown, creation, emptyText, autoFocus, className }: PanelProps) {
  const view = useMemo(() => visibleOptions(options, query), [options, query]);
  const offerCreate = Boolean(creation) && creationVisible(options, query);
  const text = query.trim();
  const activeValue = active < 0 ? '' : active < view.shown.length ? view.shown[active].value : CREATE_ROW;
  const narrow = narrowLine(view);
  // Groups in the order they first appear; options without one come first, flat.
  const groups = useMemo(() => {
    const map = new Map<string, ComboOption[]>();
    for (const option of view.shown) map.set(option.group ?? '', [...(map.get(option.group ?? '') ?? []), option]);
    return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : 0));
  }, [view]);

  const item = (option: ComboOption) => (
    <Command.Item
      key={option.value}
      value={option.value}
      disabled={option.disabled}
      onSelect={() => onPick(option.value)}
      className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-t1 aria-disabled:cursor-not-allowed aria-disabled:opacity-45 data-[selected=true]:bg-acdim max-md:min-h-11"
    >
      {option.icon && <NodeIcon icon={option.icon} size={16} className="shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{option.label}</span>
        {option.hint && <span className="block truncate text-[11px] text-t3">{option.hint}</span>}
      </span>
      {option.value === value && <Check className="size-3.5 shrink-0 text-ac" aria-label="Selected" />}
    </Command.Item>
  );

  return (
    <Command
      shouldFilter={false}
      loop
      value={activeValue}
      onValueChange={(next) => {
        // The pointer moved over a row: it becomes the active one.
        const row = next === CREATE_ROW ? view.shown.length : view.shown.findIndex((o) => o.value === next);
        if (row >= 0 && row !== active) onActive(row);
      }}
      onKeyDownCapture={onKeyDown}
      // cmdk names its search box by this (aria-labelledby), so it is not the trigger's name too.
      label={`Search ${label}`}
      className={cn('flex min-h-0 flex-col', className)}
    >
      <div className="relative shrink-0">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
        <Command.Input
          id={`${id}-search`}
          value={query}
          onValueChange={onQuery}
          autoFocus={autoFocus}
          placeholder="Type to filter…"
          aria-label={`Search ${label}`}
          className="h-9 w-full rounded-[10px] border border-hair bg-wl pl-8 pr-3 text-[13px] text-t1 outline-none placeholder:text-t3 focus:border-ac max-md:h-11 max-md:text-[16px]"
        />
      </div>
      <Command.List label={label} className="mt-1.5 min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {groups.map(([group, rows]) =>
          group ? (
            <Command.Group key={group} heading={group} className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-0.5 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-t3">
              {rows.map(item)}
            </Command.Group>
          ) : (
            rows.map(item)
          ),
        )}
        {offerCreate && (
          <Command.Item
            value={CREATE_ROW}
            onSelect={() => onCreate(text)}
            className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-t1 data-[selected=true]:bg-acdim max-md:min-h-11"
          >
            <Plus className="size-3.5 shrink-0 text-ac" />
            <span className="min-w-0 flex-1 truncate">{creation?.label ? creation.label(text) : `Create “${text}”`}</span>
          </Command.Item>
        )}
      </Command.List>
      {view.shown.length === 0 && !offerCreate && <p className="px-2.5 py-3 text-center text-[12px] text-t3">{emptyText ?? 'Nothing matches'}</p>}
      {narrow && <p className="px-2.5 py-1.5 text-center text-[11px] text-t3">{narrow}</p>}
    </Command>
  );
}

export interface ComboboxProps {
  id: string;
  /** For a screen reader, and the sheet's heading on a phone. */
  label: string;
  value: string | undefined;
  options: ComboOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  emptyText?: string;
  creation?: ComboboxCreation;
  disabled?: boolean;
  className?: string;
}

/** Where the list sits: under the trigger, or over it when the screen below is short. */
type Place = { left: number; width: number; top?: number; bottom?: number };

export function Combobox({ id, label, value, options, onChange, placeholder = 'Select…', emptyText, creation, disabled, className }: ComboboxProps) {
  const [state, setState] = useState<ComboState>({ open: false, query: '', active: -1 });
  const [place, setPlace] = useState<Place>();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  const uid = useId();
  const picked = options.find((o) => o.value === value);

  const view = useMemo(() => visibleOptions(options, state.query), [options, state.query]);
  const offerCreate = Boolean(creation) && creationVisible(options, state.query);
  const shape = useMemo(() => ({ shown: view.shown, creation: offerCreate }), [view, offerCreate]);

  const close = useCallback((refocus = true) => {
    setState({ open: false, query: '', active: -1 });
    if (refocus) trigger.current?.focus();
  }, []);

  // Opening puts the picked option under the cursor, else the first.
  const openList = () => {
    const at = view.shown.findIndex((o) => o.value === value);
    setState({ open: true, query: '', active: at >= 0 ? at : onKey({ open: true, query: '', active: -1 }, 'Home', { shown: view.shown, creation: false }).state.active });
  };

  useLayoutEffect(() => {
    if (!state.open || phone || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    setPlace(below < 340 && rect.top > below ? { left: rect.left, width: Math.max(rect.width, 260), bottom: window.innerHeight - rect.top + 4 } : { left: rect.left, width: Math.max(rect.width, 260), top: rect.bottom + 4 });
  }, [state.open, phone]);

  // Desktop: a press outside, a scroll outside or a resize closes it, as a Popover does.
  useLayoutEffect(() => {
    if (!state.open || phone) return;
    const down = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    const scroll = (e: Event) => !panel.current?.contains(e.target as Node) && close(false);
    const resize = () => close(false);
    document.addEventListener('mousedown', down);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('mousedown', down);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [state.open, phone, close]);

  const pick = (next: string) => {
    close();
    if (next !== value) onChange(next);
  };
  const create = (text: string) => {
    close(false);
    creation?.onCreate(text);
  };

  const query = (text: string) => {
    const shown = visibleOptions(options, text).shown;
    const wants = Boolean(creation) && creationVisible(options, text);
    setState({ open: true, query: text, active: onKey({ open: true, query: text, active: -1 }, 'Home', { shown, creation: wants }).state.active });
  };

  /** Our keys first: cmdk never sees them, so what the model says is what happens. */
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Tab') return close();
    if (!KEYS.has(e.key) || e.nativeEvent.isComposing) return;
    e.preventDefault();
    // Only this list handles the key: the dialog or sheet around it stays open.
    e.stopPropagation();
    const out = onKey(state, e.key as ComboKey, shape);
    setState(out.state);
    if (out.pick !== undefined) pick(out.pick);
    else if (out.create !== undefined) create(out.create);
    else if (out.close) trigger.current?.focus();
  };

  const panelProps: PanelProps = {
    id,
    label,
    options,
    value,
    query: state.query,
    active: state.active,
    onActive: (row) => setState((s) => ({ ...s, active: row })),
    onQuery: query,
    onPick: pick,
    onCreate: create,
    onKeyDown: keys,
    creation,
    emptyText,
    autoFocus: true,
  };

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={state.open}
        aria-controls={state.open ? `${uid}-popup` : undefined}
        disabled={disabled}
        onClick={() => (state.open ? close() : openList())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            openList();
          }
        }}
        className={cn(
          'flex h-9 w-full items-center gap-2 rounded-[10px] border border-hair bg-wl px-3 text-left text-[13px] text-t1 outline-none transition-colors duration-[120ms] focus-visible:border-ac disabled:cursor-not-allowed disabled:opacity-50 max-md:h-11 max-md:text-[16px]',
          className,
        )}
      >
        {picked?.icon && <NodeIcon icon={picked.icon} size={16} className="shrink-0" />}
        <span className={cn('min-w-0 flex-1 truncate', !picked && 'text-t3')}>{picked ? picked.label : placeholder}</span>
        {picked?.hint && <span className="hidden max-w-[40%] shrink-0 truncate text-[11px] text-t3 sm:block">{picked.hint}</span>}
        <ChevronDown className="size-4 shrink-0 text-t3" />
      </button>
      {phone ? (
        <Sheet open={state.open} onClose={() => close()} title={label} className="max-h-[85dvh]">
          <div id={`${uid}-popup`} className="flex max-h-[60dvh] min-h-0 flex-col">
            <ComboboxPanel {...panelProps} />
          </div>
        </Sheet>
      ) : (
        state.open &&
        place &&
        createPortal(
          // role=dialog + aria-modal: the Dialog and Sheet around it (use-dialog-focus.ts, dialog.tsx) answer Escape and Tab only for the topmost one.
          <div
            ref={panel}
            id={`${uid}-popup`}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            style={place}
            className="fixed z-[70] flex max-h-[340px] flex-col rounded-xl border border-hair bg-sf p-1.5 shadow-pop animate-in"
          >
            <ComboboxPanel {...panelProps} />
          </div>,
          document.body,
        )
      )}
    </>
  );
}
