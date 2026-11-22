/**
 * The data grid's logic without a DOM (components/ui/data-grid.tsx renders it): what a key does to the cell being
 * edited, how a typed draft becomes a value of the column's type, how rows sort and how a selection grows. A cell is
 * `(row, col)`, indexes into the rows and columns as drawn. Plain module: no React, no server imports.
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
  cursor?: { row: number; col: number };
  /** The cell being edited, its draft text and the text it started with (a draft that equals it commits nothing). */
  editing?: { row: number; col: number; draft: string; initial: string };
  sort?: { key: string; dir: 'asc' | 'desc' };
  selected: Set<string>;
}

export type GridKey = 'Enter' | 'Tab' | 'Shift+Tab' | 'Escape' | 'Blur';

export interface GridContext {
  cols: GridModelColumn[];
  rows: number;
  /** A cell's value, for the text an editor starts with and for a boolean to flip. */
  value: (row: number, col: number) => unknown;
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

export function startEdit(state: GridState, row: number, col: number, initial: string): GridState {
  return { ...state, cursor: { row, col }, editing: { row, col, draft: initial, initial } };
}

/** The next cell with an editor after (row, col) in `step` direction, wrapping to the next or previous row; undefined past the ends. */
function neighbour(ctx: GridContext, row: number, col: number, step: 1 | -1): { row: number; col: number } | undefined {
  let r = row;
  let c = col + step;
  while (r >= 0 && r < ctx.rows) {
    while (c >= 0 && c < ctx.cols.length) {
      if (hasEditor(ctx.cols[c])) return { row: r, col: c };
      c += step;
    }
    r += step;
    c = step === 1 ? 0 : ctx.cols.length - 1;
  }
  return undefined;
}

/**
 * What a key does to the grid: the next state, and the edit to save when there is one. Enter on a cell opens its editor
 * (a boolean flips instead, a read-only cell does nothing) and, in the editor, saves; Tab saves and opens the next cell
 * to the right (Shift+Tab the left), wrapping at the row's end and stopping at the grid's; Escape cancels; Blur saves
 * where the editor stands. An unchanged draft saves nothing.
 */
export function gridKey(state: GridState, key: GridKey, ctx: GridContext): { state: GridState; commit?: { row: number; col: number; value: unknown } } {
  const editing = state.editing;
  if (!editing) {
    if (key !== 'Enter' || !state.cursor) return { state };
    const { row, col } = state.cursor;
    const column = ctx.cols[col];
    if (!column?.editable || row >= ctx.rows) return { state };
    if (column.type === 'boolean') return { state, commit: { row, col, value: ctx.value(row, col) !== true } };
    return { state: startEdit(state, row, col, valueToDraft(column.type, ctx.value(row, col))) };
  }
  const { row, col, draft, initial } = editing;
  if (key === 'Escape') return { state: { ...state, cursor: { row, col }, editing: undefined } };
  const column = ctx.cols[col];
  const commit = column && draft !== initial ? { row, col, value: draftToValue(column.type, draft) } : undefined;
  const done: GridState = { ...state, cursor: { row, col }, editing: undefined };
  if (key === 'Enter' || key === 'Blur') return { state: done, ...(commit && { commit }) };
  const to = neighbour(ctx, row, col, key === 'Tab' ? 1 : -1);
  if (!to) return { state: done, ...(commit && { commit }) };
  // The next cell opens on the value it has now: the commit of this one touches another cell.
  const next = ctx.cols[to.col];
  return { state: startEdit(done, to.row, to.col, valueToDraft(next.type, ctx.value(to.row, to.col))), ...(commit && { commit }) };
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
