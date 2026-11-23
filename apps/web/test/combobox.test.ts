/** The combobox's model (filter, keys) and its static markup: the pure parts of components/ui/combobox.tsx. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { creationVisible, MAX_SHOWN, narrowLine, onKey, rowsOf, visibleOptions, type ComboOption, type ComboState } from '../src/components/ui/combobox-model';
import { ComboboxPanel } from '../src/components/ui/combobox';

const opt = (value: string, label = value, extra: Partial<ComboOption> = {}): ComboOption => ({ value, label, ...extra });
const closed: ComboState = { open: false, query: '', active: -1 };
const open = (active = -1, query = ''): ComboState => ({ open: true, query, active });

describe('visibleOptions', () => {
  const list = [opt('1', 'Billing API', { hint: 'Payments' }), opt('2', 'prod key', { group: 'Header Auth' }), opt('3', 'Café token'), opt('4', 'dev key'), opt('5', 'Product feed')];

  it('keeps the given order for an empty query', () => {
    expect(visibleOptions(list, '').shown.map((o) => o.value)).toEqual(['1', '2', '3', '4', '5']);
    expect(visibleOptions(list, '  ').total).toBe(5);
  });

  it('filters case- and accent-insensitively over label, hint and group', () => {
    expect(visibleOptions(list, 'CAFE').shown.map((o) => o.value)).toEqual(['3']);
    expect(visibleOptions(list, 'payments').shown.map((o) => o.value)).toEqual(['1']);
    expect(visibleOptions(list, 'header auth').shown.map((o) => o.value)).toEqual(['2']);
    expect(visibleOptions(list, 'zzz')).toEqual({ shown: [], total: 0 });
  });

  it('puts prefix matches of the label first, then the rest in their order', () => {
    expect(visibleOptions(list, 'prod').shown.map((o) => o.value)).toEqual(['2', '5']);
    // "key" is no prefix of either label, so the given order stays.
    expect(visibleOptions(list, 'key').shown.map((o) => o.value)).toEqual(['2', '4']);
    expect(visibleOptions([opt('a', 'my prod'), opt('b', 'prod')], 'prod').shown.map((o) => o.value)).toEqual(['b', 'a']);
  });

  it('shows at most MAX_SHOWN and says how many matched', () => {
    const many = Array.from({ length: 2000 }, (_, i) => opt(String(i), `key ${i}`));
    const view = visibleOptions(many, '');
    expect(view.shown).toHaveLength(MAX_SHOWN);
    expect(view.total).toBe(2000);
    expect(narrowLine(view)).toBe('Showing 200 of 2,000: type to narrow');
    expect(narrowLine(visibleOptions(many.slice(0, 5), ''))).toBeUndefined();
  });

  it('filters 2,000 options in under 20 ms', () => {
    const many = Array.from({ length: 2000 }, (_, i) => opt(String(i), `Key número ${i}`, { hint: `project ${i % 7}`, group: i % 2 ? 'Header Auth' : 'Bearer' }));
    visibleOptions(many, 'warm');
    const t = performance.now();
    visibleOptions(many, 'NUMERO 19');
    expect(performance.now() - t).toBeLessThan(20);
  });
});

describe('creation row', () => {
  it('shows for typed text no option is called exactly', () => {
    const list = [opt('1', 'Billing API')];
    expect(creationVisible(list, 'Billing API 2')).toBe(true);
    expect(creationVisible(list, ' billing api ')).toBe(false);
    expect(creationVisible(list, '   ')).toBe(false);
  });
});

describe('onKey', () => {
  const shown = [opt('a'), opt('b', 'b', { disabled: true }), opt('c')];
  const view = { shown, creation: false };

  it('ArrowDown and ArrowUp wrap and skip disabled options', () => {
    expect(onKey(open(0), 'ArrowDown', view).state.active).toBe(2);
    expect(onKey(open(2), 'ArrowDown', view).state.active).toBe(0);
    expect(onKey(open(0), 'ArrowUp', view).state.active).toBe(2);
    expect(onKey(open(-1), 'ArrowDown', view).state.active).toBe(0);
    expect(onKey(open(-1), 'ArrowUp', view).state.active).toBe(2);
  });

  it('Home and End go to the first and last enabled row', () => {
    expect(onKey(open(2), 'Home', view).state.active).toBe(0);
    expect(onKey(open(0), 'End', view).state.active).toBe(2);
  });

  it('Enter picks the active option and closes', () => {
    const out = onKey(open(2, 'c'), 'Enter', view);
    expect(out.pick).toBe('c');
    expect(out.state.open).toBe(false);
    expect(out.state.query).toBe('');
  });

  it('Enter with nothing active picks nothing', () => {
    expect(onKey(open(-1), 'Enter', view)).toEqual({ state: open(-1) });
  });

  it('Enter on the creation row creates with the typed text, trimmed', () => {
    const withCreation = { shown: [opt('a')], creation: true };
    expect(rowsOf(withCreation)).toBe(2);
    expect(onKey(open(0, '  Billing API '), 'ArrowDown', withCreation).state.active).toBe(1);
    const out = onKey(open(1, '  Billing API '), 'Enter', withCreation);
    expect(out.create).toBe('Billing API');
    expect(out.pick).toBeUndefined();
    expect(out.state.open).toBe(false);
  });

  it('with no match, the creation row is the only row', () => {
    const only = { shown: [], creation: true };
    expect(onKey(open(-1, 'Billing API'), 'ArrowDown', only).state.active).toBe(0);
    expect(onKey(open(0, 'Billing API'), 'Enter', only).create).toBe('Billing API');
  });

  it('Escape closes and picks nothing', () => {
    const out = onKey(open(0, 'x'), 'Escape', view);
    expect(out).toEqual({ state: closed, close: true });
  });

  it('a closed list opens on ArrowDown, ArrowUp and Enter', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter'] as const) expect(onKey(closed, key, view).state.open).toBe(true);
  });

  it('an empty list has nothing to move to', () => {
    expect(onKey(open(-1), 'ArrowDown', { shown: [], creation: false }).state.active).toBe(-1);
  });
});

describe('ComboboxPanel markup', () => {
  const noop = () => {};
  const props = { id: 'cred', label: 'Credential for Header Auth', value: undefined, query: '', active: -1, onActive: noop, onQuery: noop, onPick: noop, onCreate: noop, onKeyDown: noop };

  it('has a labelled search combobox over a listbox with options, groups and hints', () => {
    const html = renderToStaticMarkup(
      createElement(ComboboxPanel, { ...props, options: [opt('1', 'prod key', { hint: 'Payments', group: 'Header Auth' }), opt('2', 'dev key')] }),
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="Credential for Header Auth"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain('prod key');
    expect(html).toContain('Payments');
    expect(html).toContain('Header Auth');
  });

  it('says there is nothing to show, and offers Create “text” when it is allowed', () => {
    const none = renderToStaticMarkup(createElement(ComboboxPanel, { ...props, options: [], emptyText: 'No credential yet' }));
    expect(none).toContain('No credential yet');
    const create = renderToStaticMarkup(
      createElement(ComboboxPanel, { ...props, options: [opt('1', 'prod key')], query: 'Billing API', creation: { onCreate: noop } }),
    );
    expect(create).toContain('Create “Billing API”');
    const custom = renderToStaticMarkup(
      createElement(ComboboxPanel, { ...props, options: [], query: 'Billing API', creation: { label: (t: string) => `Add ${t}`, onCreate: noop } }),
    );
    expect(custom).toContain('Add Billing API');
  });

  it('says to type to narrow past 200 options', () => {
    const many = Array.from({ length: 2000 }, (_, i) => opt(String(i), `key ${i}`));
    const html = renderToStaticMarkup(createElement(ComboboxPanel, { ...props, options: many }));
    expect(html).toContain('Showing 200 of 2,000: type to narrow');
    expect((html.match(/role="option"/g) ?? []).length).toBe(200);
  });
});
