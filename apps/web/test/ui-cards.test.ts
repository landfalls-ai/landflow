import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { GALLERY, SpecCard } from '@/components/run-trace/ui-cards';

const html = (spec: unknown) => renderToStaticMarkup(createElement(SpecCard, { spec }));

describe('SpecCard', () => {
  beforeEach(() => {
    process.env.LANDFLOW_JSON_RENDER = '1';
  });
  afterEach(() => {
    delete process.env.LANDFLOW_JSON_RENDER;
  });
  it('renders nothing when the flag is off', () => {
    delete process.env.LANDFLOW_JSON_RENDER;
    expect(html(GALLERY[0].spec)).toBe('');
  });
  it('renders a status card from a model-written spec, escaping text', () => {
    const out = html({ root: 'c', elements: { c: { type: 'Status', props: { title: '<img src=x onerror=alert(1)>', status: 'failed' } } } });
    expect(out).toContain('&lt;img');
    expect(out).not.toContain('<img');
  });
  it('renders the three cards and ignores the unknown component', () => {
    expect(html(GALLERY[0].spec)).toContain('Build plugin');
    expect(html(GALLERY[1].spec)).toContain('src/greet.ts');
    expect(html(GALLERY[2].spec)).toContain('cannot approve');
    const bad = html(GALLERY[3].spec);
    expect(bad).toContain('could not be shown');
    expect(bad).not.toContain('alert(1)');
  });
});
