/**
 * The data grid's logic without a DOM (components/ui/data-grid.tsx renders it): what a key does to the cell being
 * edited, how a typed draft becomes a value of the column's type, how rows sort and how a selection grows. A cell is
 * `(rowId, col)`: the row by its id (so a re-sort or an insert while editing leaves the edit where it was) and the
 * column by its index. Plain module: no React, no server imports.
 */

export type GridColumnType = 'text' | 'number' | 'boolean' | 'select' | 'date';

/** What the model needs to know of a column. */
export interface GridModelColumn {
  key: string;
  type: GridColumnType;
  editable?: boolean;
  options?: string[];
}

export interface GridState {
  /** The cell a key acts on: the last one clicked or edited. */
  cursor?: { rowId: string; col: number };
  /** The cell being edited, its draft text and the text it started with (a draft that equals it commits nothing). */
  editing?: { rowId: string; col: number; draft: string; initial: string };
  sort?: { key: string; dir: 'asc' | 'desc' };
  selected: Set<string>;
}

export type GridKey = 'Enter' | 'Tab' | 'Shift+Tab' | 'Escape' | 'Blur';
export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export interface GridContext {
  cols: GridModelColumn[];
  /** The ids of the rows as drawn now, top to bottom. */
  rowIds: string[];
  /** Tab past the last editable cell of a row goes to the next row (Shift+Tab, the previous); off, editing ends there. */
  wrapRows?: boolean;
  /** A cell's value, for the text an editor starts with and for a boolean to flip. */
  value: (rowId: string, col: number) => unknown;
}

/** A value as the text an editor starts with. */
export function valueToDraft(type: GridColumnType, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (type === 'date' && typeof value === 'string') {
    // <input type="datetime-local"> wants the local time as YYYY-MM-DDTHH:mm.
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return String(value);
}

/**
 * A draft as the column's value. Empty is null for every type but text; a number that is not one stays the text typed, so
 * whoever saves can say what is wrong with it; a date is the ISO time of the local time typed.
 */
export function draftToValue(type: GridColumnType, draft: string): unknown {
  if (type === 'text' || type === 'select') return draft;
  if (draft.trim() === '') return null;
  if (type === 'number') {
    const n = Number(draft);
    return Number.isFinite(n) ? n : draft;
  }
  if (type === 'date') {
    const d = new Date(draft);
    return Number.isNaN(d.getTime()) ? draft : d.toISOString();
  }
  return draft;
}

/** Whether a column opens an editor: a boolean is a checkbox in its cell and takes no editor. */
export const hasEditor = (column: GridModelColumn): boolean => Boolean(column.editable) && column.type !== 'boolean';

export function startEdit(state: GridState, rowId: string, col: number, initial: string): GridState {
  return { ...state, cursor: { rowId, col }, editing: { rowId, col, draft: initial, initial } };
}

/** The next cell with an editor after the cell in `step` direction; past the row's end it goes to the next or previous row when `wrapRows`, else nowhere. */
function neighbour(ctx: GridContext, rowId: string, col: number, step: 1 | -1): { rowId: string; col: number } | undefined {
  let r = ctx.rowIds.indexOf(rowId);
  if (r < 0) return undefined;
  let c = col + step;
  while (r >= 0 && r < ctx.rowIds.length) {
    while (c >= 0 && c < ctx.cols.length) {
      if (hasEditor(ctx.cols[c])) return { rowId: ctx.rowIds[r], col: c };
      c += step;
    }
    if (!ctx.wrapRows) return undefined;
    r += step;
    c = step === 1 ? 0 : ctx.cols.length - 1;
  }
  return undefined;
}

/** An arrow key moves the cursor to the next cell with an editor: along the row (skipping checkboxes and read-only cells) or down and up the column. Undefined when there is no cursor; the cursor stays at an edge. */
export function moveCursor(state: GridState, key: ArrowKey, ctx: GridContext): GridState | undefined {
  const at = state.cursor;
  const r = at ? ctx.rowIds.indexOf(at.rowId) : -1;
  if (!at || r < 0) return undefined;
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const next = ctx.rowIds[r + (key === 'ArrowDown' ? 1 : -1)];
    return { ...state, cursor: { rowId: next ?? at.rowId, col: at.col } };
  }
  const step = key === 'ArrowRight' ? 1 : -1;
  for (let c = at.col + step; c >= 0 && c < ctx.cols.length; c += step) if (hasEditor(ctx.cols[c])) return { ...state, cursor: { rowId: at.rowId, col: c } };
  return { ...state, cursor: at };
}

/**
 * What a key does to the grid: the next state, and the edit to save when there is one. Enter on a cell opens its editor
 * (a boolean flips instead, a read-only cell does nothing) and, in the editor, saves; Tab saves and opens the next cell
 * to the right (Shift+Tab the left), wrapping at the row's end when `wrapRows` and stopping at the grid's; Escape cancels; Blur saves
 * where the editor stands. An unchanged draft saves nothing.
 */
export function gridKey(state: GridState, key: GridKey, ctx: GridContext): { state: GridState; commit?: { rowId: string; col: number; value: unknown } } {
  const editing = state.editing;
  if (!editing) {
    if (key !== 'Enter' || !state.cursor) return { state };
    const { rowId, col } = state.cursor;
    const column = ctx.cols[col];
    if (!column?.editable || !ctx.rowIds.includes(rowId)) return { state };
    if (column.type === 'boolean') return { state, commit: { rowId, col, value: ctx.value(rowId, col) !== true } };
    return { state: startEdit(state, rowId, col, valueToDraft(column.type, ctx.value(rowId, col))) };
  }
  const { rowId, col, draft, initial } = editing;
  const done: GridState = { ...state, cursor: { rowId, col }, editing: undefined };
  if (key === 'Escape') return { state: done };
  const column = ctx.cols[col];
  const commit = column && draft !== initial ? { rowId, col, value: draftToValue(column.type, draft) } : undefined;
  if (key === 'Enter' || key === 'Blur') return { state: done, ...(commit && { commit }) };
  const to = neighbour(ctx, rowId, col, key === 'Tab' ? 1 : -1);
  if (!to) return { state: done, ...(commit && { commit }) };
  // The next cell opens on the value it has now: the commit of this one touches another cell.
  const next = ctx.cols[to.col];
  return { state: startEdit(done, to.rowId, to.col, valueToDraft(next.type, ctx.value(to.rowId, to.col))), ...(commit && { commit }) };
}

/** Sort by a column: ascending, then descending, then none; another column starts ascending. */
export function cycleSort(sort: GridState['sort'], key: string): GridState['sort'] {
  if (sort?.key !== key) return { key, dir: 'asc' };
  return sort.dir === 'asc' ? { key, dir: 'desc' } : undefined;
}

/** Rows ordered by a column's values (numbers as numbers, the rest as text), empty ones last either way. */
export function sortRows<R>(rows: R[], columns: GridModelColumn[], sort: GridState['sort'], value: (row: R, key: string) => unknown = (row, key) => (row as Record<string, unknown>)[key]): R[] {
  if (!sort) return rows;
  const column = columns.find((c) => c.key === sort.key);
  const sign = sort.dir === 'asc' ? 1 : -1;
  const empty = (v: unknown) => v === null || v === undefined || v === '';
  return [...rows].sort((a, b) => {
    const x = value(a, sort.key);
    const y = value(b, sort.key);
    if (empty(x) || empty(y)) return Number(empty(x)) - Number(empty(y));
    if (column?.type === 'number' || (typeof x === 'number' && typeof y === 'number')) return (Number(x) - Number(y)) * sign;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }) * sign;
  });
}

export function toggleSelect(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Every id selected, or, when they all are, none. */
export function selectAll(selected: ReadonlySet<string>, ids: string[]): Set<string> {
  return ids.length > 0 && ids.every((id) => selected.has(id)) ? new Set() : new Set([...selected, ...ids]);
}
