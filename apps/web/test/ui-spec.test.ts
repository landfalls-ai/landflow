import { afterEach, describe, expect, it } from 'vitest';
import { jsonRenderEnabled, parseUiSpec } from '@/lib/shared/ui-spec';

const one = (type: string, props: unknown, extra: Record<string, unknown> = {}) => ({ root: 'c', elements: { c: { type, props, ...extra } } });

describe('ui-spec catalog validation', () => {
  afterEach(() => {
    delete process.env.LANDFLOW_JSON_RENDER;
  });
  it('is off unless the flag is set', () => {
    expect(jsonRenderEnabled()).toBe(false);
    process.env.LANDFLOW_JSON_RENDER = '1';
    expect(jsonRenderEnabled()).toBe(true);
  });
  it('accepts the three cards, also as JSON text', () => {
    expect(parseUiSpec(one('Status', { title: 'T', status: 'running' })).spec?.elements.c.type).toBe('Status');
    expect(parseUiSpec(one('Diff', { path: 'a.ts', lines: [{ kind: 'add', text: 'x' }] })).spec).not.toBeNull();
    expect(parseUiSpec(JSON.stringify(one('Approval', { title: 'T', summary: 'S', approvalId: 'w-1', risk: 'low' }))).spec).not.toBeNull();
  });
  it('rejects bad props: wrong enum, missing field, too long, not JSON', () => {
    expect(parseUiSpec(one('Status', { title: 'T', status: 'weird' })).spec).toBeNull();
    expect(parseUiSpec(one('Diff', { lines: [] })).spec).toBeNull();
    expect(parseUiSpec(one('Status', { title: 'x'.repeat(500), status: 'failed' })).spec).toBeNull();
    expect(parseUiSpec('{nope').spec).toBeNull();
    expect(parseUiSpec(null).spec).toBeNull();
  });
});

describe('unknown components', () => {
  it('an unknown root renders nothing and is reported, never run', () => {
    const r = parseUiSpec(one('Script', { code: 'alert(1)' }));
    expect(r.spec).toBeNull();
    expect(r.problems.join()).toContain('unknown component');
  });
  it('an unknown or inherited type name is dropped, a valid root still renders', () => {
    const r = parseUiSpec({ root: 'a', elements: { a: { type: 'Status', props: { title: 'T', status: 'succeeded' } }, b: { type: 'constructor', props: {} }, c: { type: 'Iframe', props: { src: 'x' } } } });
    expect(Object.keys(r.spec!.elements)).toEqual(['a']);
    expect(r.problems.length).toBe(2);
  });
});

describe('malicious props', () => {
  it('rejects json-render expressions, extra props, URLs and handlers', () => {
    expect(parseUiSpec(one('Status', { title: { $state: '/x' }, status: 'succeeded' })).spec).toBeNull();
    expect(parseUiSpec(one('Status', { title: 'T', status: 'succeeded', href: 'javascript:alert(1)' })).spec).toBeNull();
    expect(parseUiSpec(one('Status', { title: 'T', status: 'succeeded', dangerouslySetInnerHTML: { __html: '<script>' } })).spec).toBeNull();
    expect(parseUiSpec(one('Approval', { title: 'T', summary: 'S', action: 'approve' })).spec).toBeNull();
    expect(parseUiSpec(one('Approval', { title: 'T', summary: 'S', approvalId: '../../x' })).spec).toBeNull();
    expect(parseUiSpec(one('Status', { title: 'a\u0000b', status: 'succeeded' })).spec).toBeNull();
  });
  it('drops state, children, actions and visibility from the spec', () => {
    const r = parseUiSpec({ ...one('Status', { title: 'T', status: 'succeeded' }, { children: ['x'], on: { press: { action: 'run' } }, visible: { $state: '/a' } }), state: { a: 1 } });
    expect(r.spec).toEqual({ root: 'c', elements: { c: { type: 'Status', props: { title: 'T', status: 'succeeded' } } } });
  });
  it('caps the element count and ignores prototype keys', () => {
    const elements: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) elements[`e${i}`] = { type: 'Status', props: { title: 'T', status: 'succeeded' } };
    const r = parseUiSpec({ root: 'e0', elements });
    expect(Object.keys(r.spec!.elements)).toEqual(['e0']);
    expect(r.problems.join()).toContain('more than');
    expect(parseUiSpec(JSON.parse('{"root":"__proto__","elements":{"__proto__":{"type":"Status","props":{"title":"T","status":"ok"}}}}')).spec).toBeNull();
  });
});
