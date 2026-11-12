/**
 * Filters on a phone (docs/mobile.md#filters) must leave the desktop alone: off a phone `PhoneFilters` renders its
 * children where they are, with no Filters button, and a closed `Sheet` renders nothing.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PhoneFilters } from '@/components/ui/phone-filters';
import { Sheet } from '@/components/ui/sheet';

describe('filters on a phone', () => {
  it('render their children unchanged off a phone', () => {
    const chips = createElement('div', { role: 'group', 'aria-label': 'Categories' }, createElement('button', null, 'AI'));
    const html = renderToStaticMarkup(createElement(PhoneFilters, { active: 2, onClear: () => {} }, chips));
    expect(html).toBe(renderToStaticMarkup(chips));
    expect(html).not.toContain('Filters');
  });
  it('a closed sheet renders nothing', () => {
    expect(renderToStaticMarkup(createElement(Sheet, { open: false, onClose: () => {}, title: 'Filters' }, 'chips'))).toBe('');
  });
});

describe('the phone’s field picker', () => {
  it('lists the input’s fields depth first, each with the expression a drop would insert', async () => {
    const { fieldList } = await import('@/components/run/data-view');
    const list = fieldList([{ json: { ticket: { subject: 'Login fails', 'odd key': 1 }, tags: ['a'] } }]);
    expect(list.map((f) => [f.key, f.depth, f.expression])).toEqual([
      ['ticket', 0, '{{ $json.ticket }}'],
      ['subject', 1, '{{ $json.ticket.subject }}'],
      ['odd key', 1, "{{ $json.ticket['odd key'] }}"],
      ['tags', 0, '{{ $json.tags }}'],
    ]);
    expect(fieldList(undefined)).toEqual([]);
  });
});
