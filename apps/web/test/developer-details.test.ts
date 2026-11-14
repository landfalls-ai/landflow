/**
 * "Show developer details" (docs/ui-review.md#developer-details): DevOnly draws nothing until the person turns the
 * switch on; the node panel's type line, the run's id line and a plugin card hide ids, hashes and transports and show
 * them again when it is on; the retired look toggle is imported nowhere. The preference hook is replaced by a flag,
 * since a server render always reads the defaults.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginSummary } from '../src/lib/shared/types';

const flag = vi.hoisted(() => ({ on: false }));
vi.mock('../src/lib/client/preferences', () => ({ usePreference: () => flag.on }));

const { DevOnly } = await import('../src/lib/client/developer-details');
const { NodeTypeLine } = await import('../src/components/editor/node-panel');
const { RunIdentity } = await import('../src/components/executions/execution-preview');
const { PluginCard } = await import('../src/components/plugins/plugin-card');

const plugin = {
  id: 'go-crypto',
  info: { id: 'go-crypto', name: 'Crypto helpers', version: '1.0.0', language: 'go', description: 'Hashes and signs.' },
  status: 'online',
  transport: 'grpc',
  endpoints: [],
  source: 'static',
  registeredAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  nodes: [],
} as unknown as PluginSummary;

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

beforeEach(() => {
  flag.on = false;
});

describe('DevOnly', () => {
  it('renders nothing by default and its children when the switch is on', () => {
    expect(html(createElement(DevOnly, null, createElement('b', null, 'secret')))).toBe('');
    flag.on = true;
    expect(html(createElement(DevOnly, null, createElement('b', null, 'secret')))).toBe('<b>secret</b>');
  });
});

describe('what the switch hides', () => {
  it('the node panel header: type id and transport', () => {
    const info = { pluginId: 'go-crypto', language: 'go', transport: 'grpc' } as const;
    const off = html(createElement(NodeTypeLine, { type: 'go-crypto.hash', info }));
    expect(off).not.toContain('go-crypto.hash');
    expect(off).toBe('');
    flag.on = true;
    const on = html(createElement(NodeTypeLine, { type: 'go-crypto.hash', info }));
    expect(on).toContain('go-crypto.hash');
    expect(on.toLowerCase()).toContain('grpc');
  });

  it('the run preview header: run id, trace id and mode chip', () => {
    const record = { executionId: 'ex_demo123', traceId: 'abcdef0123456789', mode: 'manual' } as const;
    const off = html(createElement(RunIdentity, { record }));
    expect(off).not.toContain('ex_demo123');
    expect(off).not.toContain('abcdef0123456789');
    expect(off).not.toContain('manual');
    flag.on = true;
    const on = html(createElement(RunIdentity, { record }));
    expect(on).toContain('ID#ex_demo123');
    expect(on).toContain('abcdef0123456789');
    expect(on).toContain('manual');
  });

  it('a plugin card: language and transport badges', () => {
    const card = () => html(createElement(PluginCard, { plugin, onChange: () => {}, expanded: false, onToggle: () => {} }));
    const off = card();
    expect(off).toContain('Crypto helpers');
    expect(off).not.toMatch(/Go\b/);
    expect(off.toLowerCase()).not.toContain('grpc');
    flag.on = true;
    const on = card();
    expect(on).toMatch(/Go\b/);
    expect(on.toLowerCase()).toContain('grpc');
  });
});

describe('the look toggle is gone', () => {
  it('nothing imports look-toggle', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(tsx?|mjs|css)$/.test(name) && /look-toggle/.test(readFileSync(path, 'utf8')) && !path.endsWith('developer-details.test.ts')) hits.push(path);
      }
    };
    walk(join(import.meta.dirname, '..', 'src'));
    expect(hits).toEqual([]);
  });
});
