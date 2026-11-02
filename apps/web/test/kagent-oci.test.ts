/**
 * Claude Code plugins as OCI images (lib/server/kagent/oci.ts, app/v2): a pinned plugin's files packed into a one-layer
 * image that a stock tar reads, the same digest every time, served by the pull half of the registry API by digest only,
 * and packed again from the deployment that pinned it when the kept copy is gone.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { KagentPlugin } from '@/lib/shared/agents';

const { packPlugin, repositoryOf, imageRef, tarOf, MANIFEST_TYPE, builtinPin, builtinFiles, BUILTIN_URL } = await import('@/lib/server/kagent/oci');
const { agentStore } = await import('@/lib/server/agents/store');
const { dataDir } = await import('@/lib/server/db');
const route = await import('@/app/v2/[[...path]]/route');

const COMMIT = 'abc123'.padEnd(40, '0');
const LONG = `skills/${'nested-folder/'.repeat(8)}SKILL.md`;
/** The plugin's folder in acme/tools at COMMIT. */
const FILES: Record<string, string> = {
  '.claude-plugin/plugin.json': '{"name":"tdd-kit","version":"1.0.0"}',
  'skills/tdd/SKILL.md': '---\nname: tdd\ndescription: Test first\n---\nWrite the failing test first.\n',
  'hooks/check.sh': '#!/bin/sh\necho ok\n',
  [LONG]: 'deep',
};
const PIN: KagentPlugin = { id: 'tdd-kit@acme-tools', url: 'https://github.com/acme/tools.git', commit: COMMIT, path: 'plugins/tdd-kit' };

function fakeGitHub(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname === `/repos/acme/tools/git/trees/${COMMIT}`) {
    const tree = Object.entries(FILES).map(([path, body]) => ({ path: `plugins/tdd-kit/${path}`, type: 'blob', size: body.length }));
    return Promise.resolve(Response.json({ tree: [...tree, { path: 'README.md', type: 'blob', size: 3 }] }));
  }
  const prefix = `/acme/tools/${COMMIT}/plugins/tdd-kit/`;
  const file = url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : undefined;
  return Promise.resolve(file && file in FILES ? new Response(FILES[file]) : new Response('not found', { status: 404 }));
}

beforeAll(() => vi.stubGlobal('fetch', vi.fn(fakeGitHub)));
afterAll(() => vi.unstubAllGlobals());

type Ctx = { params: Promise<{ path?: string[] }> };
const pull = (path: string, method: 'GET' | 'HEAD' = 'GET') =>
  (route[method] as (request: Request, context: Ctx) => Promise<Response>)(new Request(`http://landflow.test/v2/${path}`, { method }), {
    params: Promise.resolve({ path: path ? path.split('/') : undefined }),
  });

describe('packing a plugin', () => {
  it('writes a tar that tar reads: folders, scripts executable, long paths split', () => {
    const dir = mkdtempSync(join(tmpdir(), 'landflow-oci-'));
    try {
      const tar = tarOf(Object.entries(FILES).map(([path, body]) => ({ path, body: Buffer.from(body) })));
      expect(tar.length % 512).toBe(0);
      writeFileSync(join(dir, 'plugin.tar'), tar);
      execFileSync('tar', ['-xf', join(dir, 'plugin.tar'), '-C', dir]);
      for (const [path, body] of Object.entries(FILES)) expect(readFileSync(join(dir, path), 'utf8')).toBe(body);
      expect(statSync(join(dir, 'hooks/check.sh')).mode & 0o111).not.toBe(0);
      expect(statSync(join(dir, 'skills/tdd/SKILL.md')).mode & 0o111).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('packs the plugin’s folder at the pinned commit into the same image every time', async () => {
    const digest = await packPlugin(PIN);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    rmSync(join(dataDir(), 'oci'), { recursive: true, force: true });
    expect(await packPlugin(PIN)).toBe(digest);

    const manifest = JSON.parse((await (await pull(`plugins/acme-tools/tdd-kit/manifests/${digest}`)).text()) as string);
    expect(manifest).toMatchObject({ schemaVersion: 2, mediaType: MANIFEST_TYPE, layers: [{ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip' }] });
    const layer = Buffer.from(await (await pull(`plugins/acme-tools/tdd-kit/blobs/${manifest.layers[0].digest}`)).arrayBuffer());
    const tar = gunzipSync(layer);
    // The plugin's own files at the root, nothing else from the repository.
    expect(tar.toString('latin1')).toContain('.claude-plugin/plugin.json');
    expect(tar.toString('latin1')).not.toContain('README.md');
    const config = JSON.parse(Buffer.from(await (await pull(`plugins/acme-tools/tdd-kit/blobs/${manifest.config.digest}`)).arrayBuffer()).toString());
    expect(config.rootfs.diff_ids).toHaveLength(1);
  });

  it('names the image by marketplace and plugin, pinned by digest', () => {
    expect(repositoryOf('mattpocock-skills@claude-plugins-official')).toBe('plugins/claude-plugins-official/mattpocock-skills');
    expect(repositoryOf('My_Plugin@Acme.Tools')).toBe('plugins/acme-tools/my-plugin');
    expect(imageRef('192.168.1.5:3000', PIN, `sha256:${'0'.repeat(64)}`)).toBe(`192.168.1.5:3000/plugins/acme-tools/tdd-kit@sha256:${'0'.repeat(64)}`);
  });
});

describe('Landflow’s own plugins', () => {
  it('pins the landflow-harness mod the host ships to a hash of its files, without its tests or editor types', async () => {
    const pin = builtinPin()!;
    expect(pin).toEqual({ id: 'landflow-harness@landflow', url: BUILTIN_URL, commit: expect.stringMatching(/^[0-9a-f]{40}$/), path: 'landflow-harness' });
    const paths = builtinFiles('landflow-harness')!.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts', 'hooks/rules.ts']));
    expect(paths.some((p) => p.endsWith('.test.ts') || p.includes('.claude-plugin/types') || p.endsWith('.gitignore'))).toBe(false);
    // The same files, the same pin and image.
    expect(builtinPin()).toEqual(pin);
    const digest = await packPlugin(pin);
    rmSync(join(dataDir(), 'oci'), { recursive: true, force: true });
    expect(await packPlugin(pin)).toBe(digest);
    const manifest = JSON.parse((await (await pull(`plugins/landflow/landflow-harness/manifests/${digest}`)).text()) as string);
    const tar = gunzipSync(Buffer.from(await (await pull(`plugins/landflow/landflow-harness/blobs/${manifest.layers[0].digest}`)).arrayBuffer())).toString('latin1');
    expect(tar).toContain('hooks/register.ts');
    expect(tar).not.toContain('register.test.ts');
  });

  it('changes the pin when a file changes, and refuses a plugin the host doesn’t ship', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'landflow-builtin-'));
    const previous = process.env.LANDFLOW_CLAUDE_PLUGINS_DIR;
    process.env.LANDFLOW_CLAUDE_PLUGINS_DIR = dir;
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(dir, 'landflow-harness', '.claude-plugin', 'types'), { recursive: true });
      mkdirSync(join(dir, 'landflow-harness', 'hooks'), { recursive: true });
      writeFileSync(join(dir, 'landflow-harness', '.claude-plugin', 'plugin.json'), '{"name":"landflow-harness"}');
      writeFileSync(join(dir, 'landflow-harness', '.claude-plugin', 'types', 'index.d.ts'), 'export {}');
      writeFileSync(join(dir, 'landflow-harness', 'hooks', 'register.ts'), 'export const register = () => {}');
      const first = builtinPin()!;
      expect(builtinFiles('landflow-harness')!.map((f) => f.path)).toEqual(['.claude-plugin/plugin.json', 'hooks/register.ts']);
      writeFileSync(join(dir, 'landflow-harness', 'hooks', 'register.ts'), 'export const register = (on) => {}');
      expect(builtinPin()!.commit).not.toBe(first.commit);
      expect(builtinPin('nothing-here')).toBeUndefined();
      await expect(packPlugin({ id: 'nothing-here@landflow', url: BUILTIN_URL, commit: '0'.repeat(40), path: 'nothing-here' })).rejects.toThrow(/doesn’t ship the plugin nothing-here@landflow/);
    } finally {
      if (previous === undefined) delete process.env.LANDFLOW_CLAUDE_PLUGINS_DIR;
      else process.env.LANDFLOW_CLAUDE_PLUGINS_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the registry', () => {
  it('answers the version check, and serves images by digest with their headers', async () => {
    const version = await pull('');
    expect(version.status).toBe(200);
    expect(version.headers.get('docker-distribution-api-version')).toBe('registry/2.0');

    const digest = await packPlugin(PIN);
    const head = await pull(`plugins/acme-tools/tdd-kit/manifests/${digest}`, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe(MANIFEST_TYPE);
    expect(head.headers.get('docker-content-digest')).toBe(digest);
    expect(await head.text()).toBe('');
  });

  it('serves no tags, no other digests and no other paths', async () => {
    const tag = await pull('plugins/acme-tools/tdd-kit/manifests/latest');
    expect(tag.status).toBe(404);
    expect(await tag.json()).toMatchObject({ errors: [{ code: 'MANIFEST_UNKNOWN' }] });
    expect((await pull(`plugins/acme-tools/tdd-kit/blobs/sha256:${'f'.repeat(64)}`)).status).toBe(404);
    expect((await pull(`plugins/acme-tools/tdd-kit/blobs/..%2F..%2Fdatabase.sqlite`)).status).toBe(404);
    expect((await pull('Plugins/UPPER/manifests/x')).status).toBe(404);
    expect((await pull('plugins/acme-tools/tdd-kit/tags/list')).status).toBe(404);
  });

  it('serves a runtime image put in the store: an OCI manifest with its own type, its layer streamed', async () => {
    const { createHash } = await import('node:crypto');
    const { mkdirSync } = await import('node:fs');
    const digestOf = (data: Buffer) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
    const layer = Buffer.alloc(3 * 1024 * 1024, 7);
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', layers: [{ digest: digestOf(layer), size: layer.length }] }));
    mkdirSync(join(dataDir(), 'oci', 'blobs'), { recursive: true });
    for (const blob of [layer, manifest]) writeFileSync(join(dataDir(), 'oci', 'blobs', digestOf(blob).replace(':', '-')), blob);

    const got = await pull(`runtimes/claude-harness-dev/manifests/${digestOf(manifest)}`);
    expect(got.headers.get('content-type')).toBe('application/vnd.oci.image.manifest.v1+json');
    const blob = await pull(`runtimes/claude-harness-dev/blobs/${digestOf(layer)}`);
    expect(blob.headers.get('content-length')).toBe(String(layer.length));
    expect(Buffer.from(await blob.arrayBuffer()).equals(layer)).toBe(true);
  });

  it('packs an image again from the deployment that pinned it when the kept one is gone', async () => {
    const digest = await packPlugin(PIN);
    const agent = agentStore.create({ name: 'Dev agent' });
    agentStore.setKagent(agent.id, {
      credential: { id: 'cred', name: 'kind' },
      name: 'dev',
      harness: 'landflow-claude',
      plugins: [{ ...PIN, oci: imageRef('192.168.1.5:3000', PIN, digest) }],
    } as never);
    rmSync(join(dataDir(), 'oci'), { recursive: true, force: true });
    const response = await pull(`plugins/acme-tools/tdd-kit/manifests/${digest}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('docker-content-digest')).toBe(digest);
    // A digest nobody pinned isn't packed.
    expect((await pull(`plugins/acme-tools/tdd-kit/manifests/sha256:${'e'.repeat(64)}`)).status).toBe(404);
  });
});
