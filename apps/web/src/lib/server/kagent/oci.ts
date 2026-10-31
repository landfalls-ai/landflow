/**
 * Claude Code plugins as OCI images (docs/a2a.md, "Claude Code plugins"). kagent 1.0's Agent Substrate snapshots an agent
 * with all egress blocked, so it can't clone a git plugin source; an OCI one is pulled by the node (atelet) and mounted
 * instead. Landflow packs a pinned plugin's files into a one-layer image and serves it read-only at /v2, the pull half of
 * the registry API (app/v2/[[...path]]/route.ts).
 *
 * Packing is deterministic (sorted entries, no times or owners, a fixed gzip header), so a commit always gives the same
 * digest. Images are kept in LANDFLOW_DATA_DIR/oci; one that is gone (a host without a volume) is packed again from the
 * deployment that pinned it when kagent asks for it.
 *
 * The same store serves runtime images for Harnesses (deploy/scripts/claude-harness-dev.sh puts one there: a Harness's
 * workload.image is pinned by digest and pulled the same way). Their blobs are large, so the route streams them.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { KagentPlugin } from '../../shared/agents';
import { agentStore } from '../agents/store';
import { dataDir } from '../db';
import { pluginFile, pluginFiles } from '../marketplace/node-plugins';
import { readerFor } from '../marketplace/reader';
import { githubRepo } from '../marketplace/sources';
import { logger } from '../telemetry';

export const MANIFEST_TYPE = 'application/vnd.docker.distribution.manifest.v2+json';
const CONFIG_TYPE = 'application/vnd.docker.container.image.v1+json';
const LAYER_TYPE = 'application/vnd.docker.image.rootfs.diff.tar.gzip';
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const sha256 = (data: Buffer) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const blobPath = (digest: string) => join(dataDir(), 'oci', 'blobs', digest.replace(':', '-'));

/** The image's repository in Landflow's registry: plugins/<marketplace>/<plugin>, in the characters OCI names allow. */
export function repositoryOf(id: string): string {
  const at = id.lastIndexOf('@');
  const part = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'plugin';
  return `plugins/${part(id.slice(at + 1))}/${part(id.slice(0, at))}`;
}

/** The digest-pinned reference kagent pulls: <registry>/<repository>@<manifest digest>. */
export const imageRef = (registry: string, pin: Pick<KagentPlugin, 'id'>, digest: string) => `${registry}/${repositoryOf(pin.id)}@${digest}`;

function octal(block: Buffer, offset: number, length: number, value: number) {
  block.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

/** A ustar header: no owner, no time; paths over 100 bytes are split into prefix and name at a slash. */
function header(path: string, size: number, mode: number, type: '0' | '5'): Buffer {
  const block = Buffer.alloc(512);
  let [prefix, name] = ['', path];
  if (Buffer.byteLength(path) > 100) {
    const cut = [...path.matchAll(/\//g)].map((m) => m.index).find((i) => Buffer.byteLength(path.slice(0, i)) <= 155 && Buffer.byteLength(path.slice(i + 1)) <= 100);
    if (cut === undefined) throw new Error(`${path}: the path is too long to pack`);
    [prefix, name] = [path.slice(0, cut), path.slice(cut + 1)];
  }
  block.write(name, 0, 100, 'utf8');
  octal(block, 100, 8, mode);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, 0);
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write(prefix, 345, 155, 'utf8');
  block.fill(' ', 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

/** A tar of the files at the root, directories included; scripts (#!) are executable. */
export function tarOf(files: { path: string; body: Buffer }[]): Buffer {
  const dirs = new Set<string>();
  for (const { path } of files) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  const entries: { path: string; body?: Buffer }[] = [...[...dirs].map((path) => ({ path })), ...files];
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const blocks: Buffer[] = [];
  for (const { path, body } of entries) {
    if (!body) {
      blocks.push(header(path, 0, 0o755, '5'));
      continue;
    }
    blocks.push(header(path, body.length, body.subarray(0, 2).toString() === '#!' ? 0o755 : 0o644, '0'), body);
    if (body.length % 512) blocks.push(Buffer.alloc(512 - (body.length % 512)));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function save(blob: Buffer): string {
  const digest = sha256(blob);
  const path = blobPath(digest);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}`;
    writeFileSync(temporary, blob);
    renameSync(temporary, path);
  }
  return digest;
}

/** Pack the plugin at its pinned commit into an image and keep it; the manifest's digest. */
export async function packPlugin(pin: KagentPlugin): Promise<string> {
  const repo = githubRepo(pin.url);
  if (!repo) throw new Error(`The plugin ${pin.id} isn’t on GitHub (${pin.url})`);
  const reader = readerFor({ kind: 'github', owner: repo.owner, repo: repo.repo, ref: pin.commit, sha: pin.commit, path: pin.path ?? '' });
  const files = [];
  for (const file of await pluginFiles(reader)) files.push({ path: file.path, body: await pluginFile(reader, file.path) });
  const tar = tarOf(files);
  const layer = gzipSync(tar, { level: 9 });
  layer[9] = 0xff; // gzip's OS byte, which differs between platforms: "unknown"
  const config = Buffer.from(JSON.stringify({ architecture: '', created: '0001-01-01T00:00:00Z', os: '', rootfs: { type: 'layers', diff_ids: [sha256(tar)] }, config: {} }));
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: MANIFEST_TYPE,
      config: { mediaType: CONFIG_TYPE, size: config.length, digest: save(config) },
      layers: [{ mediaType: LAYER_TYPE, size: layer.length, digest: save(layer) }],
    }),
  );
  return save(manifest);
}

/** A layer or config of an image Landflow packed. */
export function ociBlob(digest: string): Buffer | undefined {
  const path = ociBlobFile(digest);
  return path ? readFileSync(path) : undefined;
}

/** Where a blob is kept, when it is: the route streams it from there. */
export function ociBlobFile(digest: string): string | undefined {
  if (!DIGEST.test(digest)) return undefined;
  const path = blobPath(digest);
  return existsSync(path) ? path : undefined;
}

/** A manifest's own media type (an OCI image manifest or index, a Docker v2 one), else Docker v2's. */
export function manifestType(manifest: Buffer): string {
  try {
    const type = (JSON.parse(manifest.toString('utf8')) as { mediaType?: unknown }).mediaType;
    return typeof type === 'string' && type ? type : MANIFEST_TYPE;
  } catch {
    return MANIFEST_TYPE;
  }
}

/** The manifest Landflow packed under this digest, packed again from the deployment that pinned it when it is gone. */
export async function ociManifest(digest: string): Promise<Buffer | undefined> {
  const kept = ociBlob(digest);
  if (kept) return kept;
  if (!DIGEST.test(digest)) return undefined;
  const pin = agentStore
    .list()
    .flatMap((agent) => agent.kagent?.plugins ?? [])
    .find((p) => p.oci?.endsWith(`@${digest}`));
  if (!pin) return undefined;
  try {
    const packed = await packPlugin(pin);
    if (packed === digest) return ociBlob(digest);
    logger.warn('kagent: a plugin packed again to another digest; deploy the agent again', { plugin: pin.id, pinned: digest, packed });
  } catch (error) {
    logger.warn('kagent: a plugin could not be packed again', { plugin: pin.id, error: (error as Error).message });
  }
  return undefined;
}
