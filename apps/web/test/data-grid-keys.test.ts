// @vitest-environment happy-dom
/** C23: the data grid with its handlers running (a DOM): keyboard-only editing, and an edit that stays on its row when the rows reorder. */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataGrid, type GridColumn } from '../src/components/ui/data-grid';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { id: string; name: string; seats: number };
const columns: Array<GridColumn<Row>> = [
  { key: 'name', label: 'Name', type: 'text', editable: true },
  { key: 'seats', label: 'Seats', type: 'number', editable: true },
];
const data: Row[] = [
  { id: 'a', name: 'Acme', seats: 3 },
  { id: 'b', name: 'Beta', seats: 12 },
];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (props: Partial<Parameters<typeof DataGrid<Row>>[0]> = {}) => act(() => root.render(createElement(DataGrid<Row>, { columns, rows: data, ...props })));
const cell = (name: string) => container.querySelector<HTMLElement>(`td[aria-label="${name}"]`)!;
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })));
const input = () => container.querySelector<HTMLInputElement>('input[type="text"]');
const type = (el: HTMLInputElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('keyboard', () => {
  it('Enter on a focused cell opens its editor, and Enter again saves (fails if cells are not focusable or Enter is not wired)', () => {
    const onEdit = vi.fn();
    render({ onEdit });
    const c = cell('Name, row b');
    expect(c.tabIndex).toBe(0);
    act(() => c.focus());
    key(c, 'Enter');
    expect(input()?.value).toBe('Beta');
    type(input()!, 'Beta Co');
    key(input()!, 'Enter');
    expect(onEdit).toHaveBeenCalledWith('b', 'name', 'Beta Co');
    expect(input()).toBeNull();
    // Focus comes back to the cell, so the next key still works.
    expect(document.activeElement).toBe(cell('Name, row b'));
  });

  it('F2 opens the editor too', () => {
    render();
    const c = cell('Seats, row a');
    act(() => c.focus());
    key(c, 'F2');
    expect(input()?.value).toBe('3');
  });

  it('Escape in the editor cancels and keeps the focus on the cell', () => {
    const onEdit = vi.fn();
    render({ onEdit });
    const c = cell('Name, row a');
    act(() => c.focus());
    key(c, 'Enter');
    type(input()!, 'zzz');
    key(input()!, 'Escape');
    expect(onEdit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(cell('Name, row a'));
  });

  it('arrow keys move the focus between cells', () => {
    render();
    const c = cell('Name, row a');
    act(() => c.focus());
    key(c, 'ArrowRight');
    expect(document.activeElement).toBe(cell('Seats, row a'));
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(cell('Seats, row b'));
    key(document.activeElement!, 'ArrowLeft');
    expect(document.activeElement).toBe(cell('Name, row b'));
    key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(cell('Name, row a'));
  });

  it('a read-only grid has no tab stops and Enter opens nothing', () => {
    render({ readOnly: true });
    expect(container.querySelector('td[tabindex]')).toBeNull();
  });

  it('Tab stays in the row without wrapRows and moves to the next row with it', () => {
    const open = (props: Partial<Parameters<typeof DataGrid<Row>>[0]>) => {
      render(props);
      const c = cell('Seats, row a');
      act(() => c.focus());
      key(c, 'Enter');
      key(input()!, 'Tab');
    };
    open({});
    expect(input()).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    open({ wrapRows: true });
    expect(input()?.closest('td')?.getAttribute('aria-label')).toBe('Name, row b');
  });
});

describe('reorder while editing', () => {
  it('the editor stays on its row when the rows change order (fails if the edit is tracked by position)', () => {
    render();
    const c = cell('Name, row a');
    act(() => c.focus());
    key(c, 'Enter');
    type(input()!, 'Acme Corp');
    render({ rows: [data[1], data[0]] });
    expect(input()?.closest('td')?.getAttribute('aria-label')).toBe('Name, row a');
    expect(input()?.value).toBe('Acme Corp');
  });

  it('a row that disappears ends the edit', () => {
    render();
    const c = cell('Name, row a');
    act(() => c.focus());
    key(c, 'Enter');
    render({ rows: [data[1]] });
    expect(input()).toBeNull();
  });
});
