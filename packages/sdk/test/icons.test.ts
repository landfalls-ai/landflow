import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildManifest, defineNode, definePlugin, iconFile, MAX_ICON_BYTES } from '../src';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#2563eb"/></svg>';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const dir = mkdtempSync(join(tmpdir(), 'landflow-icons-'));
writeFileSync(join(dir, 'plugin.svg'), SVG);
writeFileSync(join(dir, 'node.png'), PNG);
writeFileSync(join(dir, 'big.svg'), `<svg>${' '.repeat(MAX_ICON_BYTES)}</svg>`);
writeFileSync(join(dir, 'fake.svg'), 'not an svg');
writeFileSync(join(dir, 'icon.gif'), 'GIF89a');

const dataUrl = (mime: string, body: string | Buffer) => `data:${mime};base64,${Buffer.from(body).toString('base64')}`;

const node = (icon?: string, name = 'n') =>
  defineNode({
    description: { name, displayName: 'N', description: '', version: 1, kind: 'action', icon, inputs: [], outputs: [], properties: [] },
    execute: () => [],
  });

describe('file: icons', () => {
  it('inlines plugin and node icons relative to iconDir and leaves other icons alone', () => {
    const plugin = definePlugin({
      info: { id: 'demo', name: 'Demo', version: '1', icon: 'file:plugin.svg', color: '#2563eb' },
      nodes: [node('file:node.png'), node('lucide:type', 'other')],
      iconDir: pathToFileURL(dir + '/'),
    });
    const manifest = buildManifest(plugin);
    expect(manifest.plugin.icon).toBe(dataUrl('image/svg+xml', SVG));
    expect(manifest.plugin.color).toBe('#2563eb');
    expect(manifest.nodes.map((n) => n.icon)).toEqual([dataUrl('image/png', PNG), 'lucide:type']);
    expect(JSON.stringify(manifest)).not.toContain('file:');
    // The node objects themselves are not mutated.
    expect(plugin.nodes[0].description.icon).toBe('file:node.png');
  });

  it('accepts absolute paths and file:// URLs without iconDir', () => {
    const absolute = buildManifest(definePlugin({ info: { id: 'a', name: 'A', version: '1', icon: `file:${join(dir, 'plugin.svg')}` }, nodes: [node()] }));
    expect(absolute.plugin.icon).toBe(dataUrl('image/svg+xml', SVG));
    const url = buildManifest(definePlugin({ info: { id: 'a', name: 'A', version: '1', icon: pathToFileURL(join(dir, 'plugin.svg')).href }, nodes: [node()] }));
    expect(url.plugin.icon).toBe(dataUrl('image/svg+xml', SVG));
    expect(iconFile(pathToFileURL(join(dir, 'node.png')))).toBe(dataUrl('image/png', PNG));
  });

  it('fails at definePlugin time with a readable error', () => {
    const define = (icon: string, iconDir: string | undefined = dir) => () =>
      definePlugin({ info: { id: 'x', name: 'X', version: '1' }, nodes: [node(icon)], ...(iconDir && { iconDir }) });
    expect(define('file:missing.svg')).toThrow(/Plugin x: node "n" icon .*missing\.svg: file not found/);
    expect(define('file:big.svg')).toThrow(/exceeds the 64 KB limit/);
    expect(define('file:fake.svg')).toThrow(/not a valid SVG/);
    expect(define('file:icon.gif')).toThrow(/only \.svg and \.png/);
    expect(define('file:plugin.svg', '')).toThrow(/pass iconDir/);
  });

  it('validates the plugin colour', () => {
    expect(() => definePlugin({ info: { id: 'x', name: 'X', version: '1', color: 'blue' }, nodes: [node()] })).toThrow(/hex colour/);
  });
});
