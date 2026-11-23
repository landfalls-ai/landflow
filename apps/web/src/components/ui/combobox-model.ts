/**
 * The combobox's logic without a DOM (components/ui/combobox.tsx renders it): which options a typed text leaves, and what
 * a key does. A "row" is an option shown, then the "Create “text”" row when it is offered; `active` is a row's index, -1
 * for none. Plain module: no React, no server imports.
 */

export interface ComboOption {
  value: string;
  label: string;
  /** A second line: for a credential, the project it belongs to. */
  hint?: string;
  group?: string;
  /** An Iconify name or an emoji drawn before the label. */
  icon?: string;
  disabled?: boolean;
}

export interface ComboState {
  open: boolean;
  query: string;
  active: number;
}

/** More than this many matches are not drawn: the list says "type to narrow" (no virtualisation library). */
export const MAX_SHOWN = 200;

/** Lower case without accents, for a match that ignores both. */
export const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export interface ComboView {
  shown: ComboOption[];
  /** How many options matched, which is more than `shown` past MAX_SHOWN. */
  total: number;
}

/**
 * The options a query leaves: a substring of the label, hint or group (case and accents ignored). Options whose label
 * starts with the query come first; the rest keep their order. An empty query leaves them all.
 */
export function visibleOptions(options: ComboOption[], query: string): ComboView {
  const q = fold(query.trim());
  if (!q) return { shown: options.slice(0, MAX_SHOWN), total: options.length };
  const prefix: ComboOption[] = [];
  const rest: ComboOption[] = [];
  for (const option of options) {
    const label = fold(option.label);
    if (label.startsWith(q)) prefix.push(option);
    else if (label.includes(q) || (option.hint && fold(option.hint).includes(q)) || (option.group && fold(option.group).includes(q))) rest.push(option);
  }
  const all = prefix.concat(rest);
  return { shown: all.slice(0, MAX_SHOWN), total: all.length };
}

/** The last row of a list cut at MAX_SHOWN. */
export function narrowLine(view: ComboView): string | undefined {
  return view.total > view.shown.length ? `Showing ${view.shown.length.toLocaleString('en-US')} of ${view.total.toLocaleString('en-US')}: type to narrow` : undefined;
}

/** Whether "Create “text”" is offered: there is text, and no option is called exactly that. */
export function creationVisible(options: ComboOption[], query: string): boolean {
  const q = fold(query.trim());
  return q !== '' && !options.some((o) => fold(o.label) === q);
}

export type ComboKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | 'Enter' | 'Escape';

/** The rows a key moves over: the shown options, then the creation row. */
export const rowsOf = (view: { shown: ComboOption[]; creation: boolean }): number => view.shown.length + (view.creation ? 1 : 0);

const enabled = (view: { shown: ComboOption[]; creation: boolean }, row: number): boolean => (row < view.shown.length ? !view.shown[row].disabled : view.creation);

const edge = (view: { shown: ComboOption[]; creation: boolean }, step: 1 | -1): number => {
  const n = rowsOf(view);
  for (let i = 0; i < n; i++) {
    const row = step === 1 ? i : n - 1 - i;
    if (enabled(view, row)) return row;
  }
  return -1;
};

/** The next enabled row from `from` in `step` direction, wrapping; from no row, the first (down) or the last (up). -1 when none is enabled. */
function move(view: { shown: ComboOption[]; creation: boolean }, from: number, step: 1 | -1): number {
  const n = rowsOf(view);
  if (from < 0 || from >= n) return edge(view, step);
  let row = from;
  for (let i = 0; i < n; i++) {
    row = (row + step + n) % n;
    if (enabled(view, row)) return row;
  }
  return -1;
}

/**
 * What a key does: the next state, and what happened: an option picked, text to create with, or a close. A closed list
 * opens on the arrows and Enter. Enter on no row does nothing; Escape closes and empties the query.
 */
export function onKey(state: ComboState, key: ComboKey, view: { shown: ComboOption[]; creation: boolean }): { state: ComboState; pick?: string; create?: string; close?: boolean } {
  if (key === 'Escape') return { state: { open: false, query: '', active: -1 }, close: true };
  if (!state.open) return { state: { ...state, open: true, active: -1 } };
  switch (key) {
    case 'ArrowDown':
      return { state: { ...state, active: move(view, state.active, 1) } };
    case 'ArrowUp':
      return { state: { ...state, active: move(view, state.active, -1) } };
    case 'Home':
      return { state: { ...state, active: edge(view, 1) } };
    case 'End':
      return { state: { ...state, active: edge(view, -1) } };
    case 'Enter': {
      if (state.active < 0 || state.active >= rowsOf(view) || !enabled(view, state.active)) return { state };
      const done = { open: false, query: '', active: -1 };
      if (state.active < view.shown.length) return { state: done, pick: view.shown[state.active].value };
      return { state: done, create: state.query.trim() };
    }
  }
}
