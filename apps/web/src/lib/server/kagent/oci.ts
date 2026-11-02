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
 *
 * Landflow's own plugins ship with the host (apps/web/claude-plugins, copied into the image next to server.js) and are
 * packed from there: `builtinPin` pins one to a hash of its files, so a host with other files gives another digest.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** The source URL of Landflow's own plugins (`builtinPin`): packed from the host's files, never fetched. */
export const BUILTIN_URL = 'landflow:builtin';
/** The mod every Claude Code agent on kagent gets (docs/a2a.md, "The landflow-harness mod"). */
export const HARNESS_PLUGIN = 'landflow-harness';

/** Where Landflow's own plugins are: apps/web/claude-plugins (the host runs from apps/web, in dev and in its image). */
export const builtinPluginsDir = () => process.env.LANDFLOW_CLAUDE_PLUGINS_DIR || join(process.cwd(), 'claude-plugins');

/** Kept out of the image: the types Claude Code writes for an editor, the mod's own tests, OS litter. */
const LEFT_OUT = [/(^|\/)\.claude-plugin\/types(\/|$)/, /\.test\.tsx?$/, /(^|\/)\.DS_Store$/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.gitignore$/];

/**
 * A built-in plugin's files, sorted by path; undefined when it isn't there. `options` become the defaults of the
 * plugin.json `userConfig` fields of those names (the landflow-harness mod's `guard`): the sandbox sets no options, so
 * the defaults are what the plugin reads.
 */
export function builtinFiles(name: string, options?: Record<string, string>): { path: string; body: Buffer }[] | undefined {
  const root = join(builtinPluginsDir(), name);
  if (!existsSync(join(root, '.claude-plugin', 'plugin.json'))) return undefined;
  const files: { path: string; body: Buffer }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (LEFT_OUT.some((pattern) => pattern.test(path))) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (entry.isFile()) files.push({ path, body: readFileSync(join(dir, entry.name)) });
    }
  };
  walk(root, '');
  if (options && Object.keys(options).length) {
    const manifest = files.find((file) => file.path === '.claude-plugin/plugin.json');
    if (manifest) {
      const json = JSON.parse(manifest.body.toString('utf8')) as { userConfig?: Record<string, { default?: unknown; options?: unknown }> };
      for (const [key, value] of Object.entries(options)) {
        const field = json.userConfig?.[key];
        if (!field) throw new Error(`The plugin ${name} has no option “${key}”`);
        if (Array.isArray(field.options) && !field.options.includes(value)) throw new Error(`The plugin ${name}’s option “${key}” can’t be “${value}”`);
        field.default = value;
      }
      manifest.body = Buffer.from(`${JSON.stringify(json, null, 2)}\n`);
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A built-in plugin pinned to a hash of its files (the commit field), or undefined when the host doesn't ship it. With
 * `options` (its plugin.json defaults, see `builtinFiles`) the files differ, and so do the hash and the image.
 */
export function builtinPin(name: string = HARNESS_PLUGIN, options?: Record<string, string>): KagentPlugin | undefined {
  const files = builtinFiles(name, options);
  if (!files) return undefined;
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\0${file.body.length}\0`).update(file.body);
  return { id: `${name}@landflow`, url: BUILTIN_URL, commit: hash.digest('hex').slice(0, 40), path: name, ...(options && Object.keys(options).length && { options }) };
}

/** The files of a pinned plugin: a built-in one from the host, any other from GitHub at its commit. */
async function filesOf(pin: KagentPlugin): Promise<{ path: string; body: Buffer }[]> {
  if (pin.url === BUILTIN_URL) {
    const files = builtinFiles(pin.path ?? pin.id.slice(0, pin.id.lastIndexOf('@')), pin.options);
    if (!files) throw new Error(`This host doesn’t ship the plugin ${pin.id} (${builtinPluginsDir()})`);
    return files;
  }
  const repo = githubRepo(pin.url);
  if (!repo) throw new Error(`The plugin ${pin.id} isn’t on GitHub (${pin.url})`);
  const reader = readerFor({ kind: 'github', owner: repo.owner, repo: repo.repo, ref: pin.commit, sha: pin.commit, path: pin.path ?? '' });
  const files = [];
  for (const file of await pluginFiles(reader)) files.push({ path: file.path, body: await pluginFile(reader, file.path) });
  return files;
}

/** Pack the plugin at its pinned commit into an image and keep it; the manifest's digest. */
export async function packPlugin(pin: KagentPlugin): Promise<string> {
  return packFiles(await filesOf(pin));
}

/** Pack files into a one-layer image and keep it; the manifest's digest (the same files, the same digest). */
export function packFiles(files: { path: string; body: Buffer }[]): string {
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
