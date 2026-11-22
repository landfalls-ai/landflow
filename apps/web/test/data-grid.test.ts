/** C23: the data grid's model (keys, edit, sort, selection) and static markup, and what the data table and AI prices pages keep when they use it. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cycleSort, draftToValue, gridKey, selectAll, sortRows, startEdit, toggleSelect, valueToDraft, type GridModelColumn, type GridState } from '../src/components/ui/data-grid-model';
import { DataGrid, type GridColumn } from '../src/components/ui/data-grid';

const cols: GridModelColumn[] = [
  { key: 'name', type: 'text', editable: true },
  { key: 'seats', type: 'number', editable: true },
  { key: 'active', type: 'boolean', editable: true },
  { key: 'plan', type: 'select', editable: true, options: ['free', 'pro'] },
  { key: 'id', type: 'number' },
];
const rows = [
  { id: 'a', name: 'Acme', seats: 3, active: true, plan: 'free' },
  { id: 'b', name: 'Beta', seats: 12, active: false, plan: 'pro' },
];
const ctx = { cols, rows: rows.length, value: (row: number, col: number) => (rows[row] as Record<string, unknown>)[cols[col].key] };
const idle: GridState = { selected: new Set() };

describe('gridKey', () => {
  it('Enter starts editing the cursor cell with its text', () => {
    const out = gridKey({ ...idle, cursor: { row: 0, col: 0 } }, 'Enter', ctx);
    expect(out.state.editing).toEqual({ row: 0, col: 0, draft: 'Acme', initial: 'Acme' });
    expect(out.commit).toBeUndefined();
  });

  it('Enter commits the draft and stops editing', () => {
    const editing = startEdit(idle, 0, 0, 'Acme');
    const out = gridKey({ ...editing, editing: { ...editing.editing!, draft: 'Acme Corp' } }, 'Enter', ctx);
    expect(out.commit).toEqual({ row: 0, col: 0, value: 'Acme Corp' });
    expect(out.state.editing).toBeUndefined();
    expect(out.state.cursor).toEqual({ row: 0, col: 0 });
  });

  it('Tab commits and moves right to the next editable cell, skipping booleans and read-only columns', () => {
    const at = (draft: string) => ({ ...startEdit(idle, 0, 0, 'Acme'), editing: { row: 0, col: 0, draft, initial: 'Acme' } });
    const out = gridKey(at('Acme Corp'), 'Tab', ctx);
    expect(out.commit).toEqual({ row: 0, col: 0, value: 'Acme Corp' });
    expect(out.state.editing).toMatchObject({ row: 0, col: 1, initial: '3' });
    // seats -> (active is a checkbox, no editor) -> plan
    const next = gridKey({ ...out.state }, 'Tab', ctx);
    expect(next.state.editing).toMatchObject({ row: 0, col: 3, initial: 'free' });
  });

  it('Tab at the end of a row goes to the first cell of the next row, and from the last cell ends editing', () => {
    const lastCol = startEdit(idle, 0, 3, 'free');
    expect(gridKey(lastCol, 'Tab', ctx).state.editing).toMatchObject({ row: 1, col: 0 });
    const end = startEdit(idle, 1, 3, 'pro');
    const out = gridKey(end, 'Tab', ctx);
    expect(out.state.editing).toBeUndefined();
  });

  it('Shift+Tab moves left and wraps to the previous row', () => {
    expect(gridKey(startEdit(idle, 0, 3, 'free'), 'Shift+Tab', ctx).state.editing).toMatchObject({ row: 0, col: 1 });
    expect(gridKey(startEdit(idle, 1, 0, 'Beta'), 'Shift+Tab', ctx).state.editing).toMatchObject({ row: 0, col: 3 });
    expect(gridKey(startEdit(idle, 0, 0, 'Acme'), 'Shift+Tab', ctx).state.editing).toBeUndefined();
  });

  it('commits nothing when the draft is as it was, and still moves', () => {
    const out = gridKey(startEdit(idle, 0, 0, 'Acme'), 'Tab', ctx);
    expect(out.commit).toBeUndefined();
    expect(out.state.editing).toMatchObject({ row: 0, col: 1 });
  });

  it('Escape cancels without a commit', () => {
    const editing = startEdit(idle, 0, 0, 'Acme');
    const out = gridKey({ ...editing, editing: { ...editing.editing!, draft: 'changed' } }, 'Escape', ctx);
    expect(out.commit).toBeUndefined();
    expect(out.state.editing).toBeUndefined();
  });

  it('Blur commits a change and ends editing without moving', () => {
    const editing = startEdit(idle, 1, 1, '12');
    const out = gridKey({ ...editing, editing: { ...editing.editing!, draft: '15' } }, 'Blur', ctx);
    expect(out.commit).toEqual({ row: 1, col: 1, value: 15 });
    expect(out.state.editing).toBeUndefined();
  });

  it('a boolean cell toggles on Enter without an editor; a read-only cell does nothing', () => {
    const toggled = gridKey({ ...idle, cursor: { row: 0, col: 2 } }, 'Enter', ctx);
    expect(toggled.commit).toEqual({ row: 0, col: 2, value: false });
    expect(toggled.state.editing).toBeUndefined();
    const readOnly = gridKey({ ...idle, cursor: { row: 0, col: 4 } }, 'Enter', ctx);
    expect(readOnly.state.editing).toBeUndefined();
    expect(readOnly.commit).toBeUndefined();
  });
});

describe('draft and value', () => {
  it('turns a draft into the column’s type', () => {
    expect(draftToValue('number', '12.5')).toBe(12.5);
    expect(draftToValue('number', '  ')).toBeNull();
    expect(draftToValue('number', 'abc')).toBe('abc');
    expect(draftToValue('text', 'x')).toBe('x');
    expect(draftToValue('select', 'pro')).toBe('pro');
    expect(draftToValue('date', '')).toBeNull();
    expect(draftToValue('date', '2026-11-03T10:30')).toBe(new Date('2026-11-03T10:30').toISOString());
  });

  it('shows a value as its draft text', () => {
    expect(valueToDraft('text', null)).toBe('');
    expect(valueToDraft('number', 3)).toBe('3');
    expect(valueToDraft('boolean', true)).toBe('true');
  });
});

describe('sort and selection', () => {
  it('cycles asc, desc, none, and starts over on another column', () => {
    expect(cycleSort(undefined, 'name')).toEqual({ key: 'name', dir: 'asc' });
    expect(cycleSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' });
    expect(cycleSort({ key: 'name', dir: 'desc' }, 'name')).toBeUndefined();
    expect(cycleSort({ key: 'name', dir: 'desc' }, 'seats')).toEqual({ key: 'seats', dir: 'asc' });
  });

  it('sorts rows by a typed column, empty last', () => {
    const data = [{ id: 'a', seats: 12 }, { id: 'b', seats: 3 }, { id: 'c', seats: null }, { id: 'd', seats: 7 }];
    const c: GridModelColumn[] = [{ key: 'seats', type: 'number' }];
    expect(sortRows(data, c, { key: 'seats', dir: 'asc' }).map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(sortRows(data, c, { key: 'seats', dir: 'desc' }).map((r) => r.id)).toEqual(['a', 'd', 'b', 'c']);
    expect(sortRows(data, c, undefined)).toBe(data);
  });

  it('selects by row id, all at once, and clears', () => {
    const one = toggleSelect(new Set<string>(), 'a');
    expect([...one]).toEqual(['a']);
    expect([...toggleSelect(one, 'a')]).toEqual([]);
    expect([...selectAll(new Set(['a']), ['a', 'b'])].sort()).toEqual(['a', 'b']);
    expect([...selectAll(new Set(['a', 'b']), ['a', 'b'])]).toEqual([]);
  });
});

describe('DataGrid markup', () => {
  type Row = { id: string; name: string; seats: number | null; active: boolean };
  const columns: Array<GridColumn<Row>> = [
    { key: 'name', label: 'Name', type: 'text', editable: true, sortable: true },
    { key: 'seats', label: 'Seats', type: 'number', editable: true },
    { key: 'active', label: 'Active', type: 'boolean', editable: true },
  ];
  const data: Row[] = [{ id: 'a', name: 'Acme', seats: 3, active: true }, { id: 'b', name: 'Beta', seats: null, active: false }];

  it('draws a sticky header, the rows, a checkbox per row, and a boolean as a checkbox', () => {
    const html = renderToStaticMarkup(createElement(DataGrid<Row>, { columns, rows: data, selectable: true, selected: ['b'] }));
    expect(html).toContain('sticky top-0');
    expect(html).toContain('scope="col"');
    expect(html).toContain('Acme');
    expect(html).toContain('Select row a');
    expect(html).toContain('Select all rows');
    expect(html).toMatch(/aria-label="active of row a"[^>]*checked|checked[^>]*aria-label="active of row a"/);
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain('overflow-auto');
  });

  it('marks the sorted column', () => {
    const html = renderToStaticMarkup(createElement(DataGrid<Row>, { columns, rows: data, sort: { key: 'name', dir: 'desc' } }));
    expect(html).toContain('aria-sort="descending"');
  });

  it('draws the empty state instead of rows, headers kept', () => {
    const html = renderToStaticMarkup(createElement(DataGrid<Row>, { columns, rows: [], empty: createElement('p', null, 'No rows yet') }));
    expect(html).toContain('No rows yet');
    expect(html).toContain('Name');
    expect(html).not.toContain('<tbody><tr');
  });

  it('scrolls sideways: the table has a minimum width inside an overflow container', () => {
    const html = renderToStaticMarkup(createElement(DataGrid<Row>, { columns, rows: data, minWidth: 640 }));
    expect(html).toContain('min-width:640px');
  });
});

describe('the pages that use the grid', () => {
  const src = (p: string) => readFileSync(join(import.meta.dirname, '../src/components', p), 'utf8');

  it('the data table page uses the grid, with no hand-made table or cell editor left', () => {
    const view = src('data-tables/table-view.tsx');
    expect(view).toContain('<DataGrid');
    expect(view).not.toContain('<table');
    expect(view).not.toContain('function CellEditor');
  });

  it('Settings → AI prices draws its overrides with the grid and still saves the same prices', async () => {
    const prices = src('settings/ai-prices-settings.tsx');
    expect(prices).toContain('<DataGrid');
    expect(prices).not.toContain('<table className="w-full min-w-[720px]');
    const { editRow, parseOverrides } = await import('../src/components/settings/ai-prices-settings');
    const rows = [
      { id: 'r1', provider: 'ollama', model: 'qwen3-coder', input: '0', output: '0', cacheRead: '', cacheWrite: '' },
      { id: 'r2', provider: 'Anthropic', model: 'claude-sonnet-5-5', input: '3', output: '15', cacheRead: '0.3', cacheWrite: '' },
    ];
    // What Save sends is what it sent before the grid: trimmed, lower-cased providers, numbers, empty cache prices left out.
    expect(parseOverrides(rows)).toEqual({ prices: [{ provider: 'ollama', model: 'qwen3-coder', input: 0, output: 0 }, { provider: 'anthropic', model: 'claude-sonnet-5-5', input: 3, output: 15, cacheRead: 0.3 }] });
    // A grid edit sets the text of one cell of one row; a number, null or the text typed.
    const edited = editRow(rows, 'r1', 'input', 2.5);
    expect(edited[0].input).toBe('2.5');
    expect(editRow(edited, 'r2', 'cacheRead', null)[1].cacheRead).toBe('');
    expect(editRow(rows, 'r1', 'input', 'abc')[0].input).toBe('abc');
    expect(parseOverrides(editRow(rows, 'r1', 'input', 'abc'))).toHaveProperty('error');
    expect(editRow(rows, 'r1', 'id', 'x')).toBe(rows);
    expect(parseOverrides(editRow(rows, 'r2', 'model', ' '))).toEqual({ error: 'Every override needs a provider and a model' });
  });
});
