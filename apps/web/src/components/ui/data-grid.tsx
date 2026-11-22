'use client';
/**
 * A grid of typed columns (docs/ui-review.md#controls), drawn from the data tables page's editable table: click a cell to
 * edit it (Enter or Tab saves and Tab moves right, Escape cancels, a boolean is a checkbox), sort by a header, select
 * rows, a sticky header, an empty state, and sideways scrolling on a phone. It fetches nothing and saves nothing: a
 * saved cell calls `onEdit`, a sort `onSort`, a selection `onSelect`; each can be controlled by the page (a server-side
 * sort, a selection a toolbar shows) or left to the grid. The keys are `data-grid-model.ts`.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cycleSort, gridKey, hasEditor, selectAll, sortRows, startEdit, toggleSelect, valueToDraft, type GridColumnType, type GridContext, type GridKey, type GridState } from './data-grid-model';

export type { GridColumnType } from './data-grid-model';

export interface GridColumn<R> {
  key: string;
  label: ReactNode;
  type: GridColumnType;
  /** `select` columns: what the editor offers. */
  options?: string[];
  editable?: boolean;
  sortable?: boolean;
  /** Pixels. */
  width?: number;
  /** Drawn before the label. */
  icon?: ReactNode;
  /** The header's tooltip. */
  title?: string;
  /** Replaces the whole header content (a column with its own menu); the grid still wraps it in the `th`. */
  header?: ReactNode;
  /** The value of a row (default: `row[key]`). */
  value?: (row: R) => unknown;
  /** A read-only cell's text (default: the value as text). */
  format?: (value: unknown, row: R) => string;
  /** Replaces the cell's content when it is not being edited. */
  render?: (row: R) => ReactNode;
  /** An editor suggestion list (`<datalist>`) and the placeholder of an empty cell. */
  suggestions?: string[];
  placeholder?: string;
  /** Right-align (numbers do by default). */
  align?: 'left' | 'right';
  /** Classes of the column's cells. */
  className?: string;
}

export interface DataGridProps<R extends { id: string | number }> {
  columns: Array<GridColumn<R>>;
  rows: R[];
  rowKey?: (row: R) => string;
  /** A cell was edited: its row, column key and the value as the column's type. May be async; the grid does not wait. */
  onEdit?: (rowId: string, key: string, value: unknown) => void | Promise<void>;
  /** Nothing can be edited. */
  readOnly?: boolean;
  selectable?: boolean;
  selected?: string[];
  onSelect?: (ids: string[]) => void;
  /** Controlled sort: with `onSort` the rows are not reordered here (the server did). Without them the grid sorts its rows. */
  sort?: GridState['sort'];
  onSort?: (sort: GridState['sort']) => void;
  /** Drawn below the header when there are no rows. */
  empty?: ReactNode;
  /** An extra control at the end of each row (a Remove button), and the header cell above it. */
  rowActions?: (row: R) => ReactNode;
  trailingHeader?: ReactNode;
  /** Open a cell for editing, once, when this changes (a row just added). */
  openCell?: { rowId: string; key: string };
  /** The table's minimum width in pixels: narrower screens scroll sideways. */
  minWidth?: number;
  /** The scroll box's classes (a height cap, the border). */
  className?: string;
  label?: string;
}

const defaultKey = (row: { id: string | number }) => String(row.id);

function Editor({ type, options, suggestions, placeholder, initial, onKey }: { type: GridColumnType; options?: string[]; suggestions?: string[]; placeholder?: string; initial: string; onKey: (key: GridKey, draft: string) => void }) {
  const [text, setText] = useState(initial);
  // One answer per editor: Tab commits and the blur it causes must not commit again.
  const done = useRef(false);
  const finish = (key: GridKey) => {
    if (done.current) return;
    done.current = true;
    onKey(key, text);
  };
  const list = useRef(`grid-suggest-${Math.random().toString(36).slice(2, 8)}`).current;
  const common = {
    autoFocus: true,
    value: text,
    onBlur: () => finish('Blur'),
    onKeyDown: (e: React.KeyboardEvent) => {
      const key: GridKey | undefined = e.key === 'Enter' ? 'Enter' : e.key === 'Escape' ? 'Escape' : e.key === 'Tab' ? (e.shiftKey ? 'Shift+Tab' : 'Tab') : undefined;
      if (!key) return;
      e.preventDefault();
      // Only the grid answers: a dialog around it stays open on Escape.
      e.stopPropagation();
      finish(key);
    },
    className: cn('h-8 w-full rounded-md border border-ac bg-sf px-2 text-[13px] text-t1 outline-none', type !== 'text' && type !== 'select' && 'font-mono'),
  };
  if (type === 'select') {
    return (
      <select {...common} onChange={(e) => setText(e.target.value)}>
        {options?.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <>
      <input {...common} type={type === 'date' ? 'datetime-local' : 'text'} inputMode={type === 'number' ? 'decimal' : undefined} placeholder={placeholder} list={suggestions ? list : undefined} onChange={(e) => setText(e.target.value)} />
      {suggestions && (
        <datalist id={list}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </>
  );
}

export function DataGrid<R extends { id: string | number }>({
  columns,
  rows,
  rowKey = defaultKey,
  onEdit,
  readOnly,
  selectable,
  selected: selectedProp,
  onSelect,
  sort: sortProp,
  onSort,
  empty,
  rowActions,
  trailingHeader,
  openCell,
  minWidth,
  className,
  label,
}: DataGridProps<R>) {
  const [state, setState] = useState<GridState>({ selected: new Set() });
  const controlledSort = onSort !== undefined;
  const sort = controlledSort ? sortProp : (state.sort ?? sortProp);
  const selected = useMemo(() => (selectedProp ? new Set(selectedProp) : state.selected), [selectedProp, state.selected]);

  const modelColumns = useMemo(() => columns.map((c) => ({ key: c.key, type: c.type, editable: c.editable && !readOnly, options: c.options })), [columns, readOnly]);
  const valueOf = (column: GridColumn<R>, row: R): unknown => (column.value ? column.value(row) : (row as unknown as Record<string, unknown>)[column.key]);
  const shown = useMemo(() => (controlledSort ? rows : sortRows(rows, modelColumns, sort, (row, key) => { const c = columns.find((x) => x.key === key); return c ? valueOf(c, row) : undefined; })), [rows, controlledSort, modelColumns, sort, columns]);
  const ctx: GridContext = { cols: modelColumns, rows: shown.length, value: (row, col) => valueOf(columns[col], shown[row]) };

  // Open a cell asked for from outside, once per request.
  const opened = useRef<string>('');
  useEffect(() => {
    if (!openCell) return;
    const mark = `${openCell.rowId}:${openCell.key}`;
    const row = shown.findIndex((r) => rowKey(r) === openCell.rowId);
    const col = columns.findIndex((c) => c.key === openCell.key);
    if (row < 0 || col < 0 || opened.current === mark || !hasEditor(modelColumns[col])) return;
    opened.current = mark;
    setState((s) => startEdit(s, row, col, valueToDraft(columns[col].type, valueOf(columns[col], shown[row]))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCell, shown]);

  const apply = (key: GridKey, draft?: string) => {
    const current: GridState = state.editing && draft !== undefined ? { ...state, editing: { ...state.editing, draft } } : state;
    const out = gridKey(current, key, ctx);
    setState(out.state);
    if (out.commit) {
      const row = shown[out.commit.row];
      const column = columns[out.commit.col];
      if (row && column) void onEdit?.(rowKey(row), column.key, out.commit.value);
    }
  };

  const changeSort = (key: string) => {
    const next = cycleSort(sort, key);
    if (controlledSort) onSort?.(next);
    else setState((s) => ({ ...s, sort: next }));
  };
  const select = (next: Set<string>) => {
    if (!selectedProp) setState((s) => ({ ...s, selected: next }));
    onSelect?.([...next]);
  };
  const ids = shown.map(rowKey);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));

  const sortIcon = (key: string) => (sort?.key === key ? sort.dir === 'asc' ? <ArrowUp className="size-3 shrink-0 text-t1" /> : <ArrowDown className="size-3 shrink-0 text-t1" /> : null);
  const ariaSort = (key: string, sortable?: boolean) => (!sortable ? undefined : sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');

  return (
    <div className={cn('overflow-auto rounded-2xl border border-hair bg-sf', className)}>
      <table aria-label={label} className="w-full border-separate border-spacing-0 text-[13px]" style={minWidth ? { minWidth } : undefined}>
        <thead className="sticky top-0 z-10">
          <tr>
            {selectable && (
              <th scope="col" className="w-10 border-b border-r border-hair bg-sf2 px-2.5">
                <input type="checkbox" checked={allSelected} onChange={() => select(selectAll(selected, ids))} aria-label="Select all rows on this page" className="size-3.5" />
              </th>
            )}
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                aria-sort={ariaSort(column.key, column.sortable)}
                style={column.width ? { width: column.width } : undefined}
                className={cn('group border-b border-r border-hair bg-sf2 px-2.5 py-0 text-left font-semibold last:border-r-0')}
              >
                {column.header ??
                  (column.sortable ? (
                    <button type="button" onClick={() => changeSort(column.key)} className="flex h-9 w-full min-w-0 items-center gap-1.5 text-[12px] text-t2 hover:text-t1" title={column.title ?? `Sort by ${typeof column.label === 'string' ? column.label : column.key}`}>
                      {column.icon}
                      <span className="truncate">{column.label}</span>
                      {sortIcon(column.key)}
                    </button>
                  ) : (
                    <div className="flex h-9 items-center gap-1.5 text-[12px] text-t2" title={column.title}>
                      {column.icon}
                      <span className="truncate">{column.label}</span>
                    </div>
                  ))}
              </th>
            ))}
            {rowActions && (
              <th scope="col" className="sticky right-0 w-11 border-b border-hair bg-sf2 px-1.5 text-center">
                {trailingHeader}
              </th>
            )}
          </tr>
        </thead>
        {shown.length > 0 && (
          <tbody>
            {shown.map((row, r) => {
              const id = rowKey(row);
              return (
                <tr key={id} className={cn('group/row', selected.has(id) ? 'bg-acdim' : 'hover:bg-sf2')}>
                  {selectable && (
                    <td className="border-b border-r border-hair px-2.5">
                      <input type="checkbox" checked={selected.has(id)} onChange={() => select(toggleSelect(selected, id))} aria-label={`Select row ${id}`} className="size-3.5" />
                    </td>
                  )}
                  {columns.map((column, c) => {
                    const value = valueOf(column, row);
                    const editable = modelColumns[c].editable;
                    if (column.type === 'boolean' && editable) {
                      return (
                        <td key={column.key} className="h-9 border-b border-r border-hair px-2.5">
                          <input
                            type="checkbox"
                            checked={value === true}
                            ref={(el) => {
                              if (el) el.indeterminate = value === null || value === undefined;
                            }}
                            onChange={() => void onEdit?.(id, column.key, value !== true)}
                            aria-label={`${column.key} of row ${id}`}
                            title={value === null || value === undefined ? 'Empty — click to set' : String(value)}
                            className="size-3.5"
                          />
                        </td>
                      );
                    }
                    const isEditing = state.editing?.row === r && state.editing.col === c;
                    const text = column.format ? column.format(value, row) : value === null || value === undefined ? '' : String(value);
                    return (
                      <td
                        key={column.key}
                        className={cn('h-9 max-w-0 border-b border-r border-hair', isEditing ? 'px-0.5' : cn(editable ? 'cursor-text' : '', 'px-2.5'), column.className)}
                        onClick={() => editable && !isEditing && setState((s) => startEdit(s, r, c, valueToDraft(column.type, value)))}
                      >
                        {isEditing ? (
                          <Editor type={column.type} options={column.options} suggestions={column.suggestions} placeholder={column.placeholder} initial={state.editing!.draft} onKey={apply} />
                        ) : (
                          <div className={cn('truncate', (column.align === 'right' || (column.type === 'number' && column.align !== 'left')) && 'text-right font-mono text-[12px]', column.type === 'date' && 'tabular-nums')} title={value === null || value === undefined ? undefined : String(value)}>
                            {column.render ? column.render(row) : text || (editable && <span className="text-t3 opacity-0 group-hover/row:opacity-60">{column.placeholder ?? 'empty'}</span>)}
                          </div>
                        )}
                      </td>
                    );
                  })}
                  {rowActions && <td className="border-b border-hair px-1.5 text-center">{rowActions(row)}</td>}
                </tr>
              );
            })}
          </tbody>
        )}
      </table>
      {shown.length === 0 && empty}
    </div>
  );
}
