/** A canvas node says what it will do under its name: the Linear node, rendered to static HTML. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import type { NodeDescriptor, NodeTypeInfo } from '../src/lib/shared/types';
import { NodeTile } from '../src/components/canvas/node-tile';

const manifest = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'plugin-manifests', 'linear.json'), 'utf8')) as { nodes: NodeDescriptor[] };
const linear: NodeTypeInfo = {
  type: 'linear.linear',
  pluginId: 'linear',
  pluginName: 'Linear',
  language: 'typescript',
  transport: 'http',
  available: true,
  descriptor: manifest.nodes.find((n) => n.name === 'linear')!,
};

const tile = (parameters: Record<string, unknown>, name = 'Linear') =>
  renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(NodeTile, { name, info: linear, parameters, readOnly: true })));

describe('canvas node subtitle', () => {
  it('shows the action under the node name, with the plugin icon', () => {
    const html = tile({ resource: 'issue', operation: 'create' });
    expect(html).toContain('Create an issue');
    expect(html).toContain('title="Create an issue"');
    expect(html).toContain('>Linear<');
    expect(html).not.toContain('create: issue');
    expect(html).toMatch(/<svg|<img/);
  });

  it('catches pointer events only on the subtitle text, not the whole 170px box', () => {
    const html = tile({ resource: 'issue', operation: 'create' });
    expect(html).toMatch(/<span class="pointer-events-auto inline-block max-w-full truncate[^"]*" title="Create an issue">/);
    expect(html).not.toMatch(/<div class="pointer-events-auto/);
  });

  it('follows the parameters', () => {
    expect(tile({ resource: 'user', operation: 'getAll' })).toContain('Get many users');
    expect(tile({})).toContain('title="Get issues changed since"');
  });

  it('shows nothing extra for a node whose operation is unknown', () => {
    const html = tile({ resource: 'issue', operation: 'nope' });
    expect(html).not.toContain('Create an issue');
  });
});
