/**
 * Files in MCP tool results (docs/transports.md "From node to tool", docs/protocol.md §15.1, §11): an output item's
 * binary data stays a reference in `structuredContent` and reaches the agent two ways.
 *
 * - **`resource_link`** (every file): a URL the host signs, `<public url>/api/mcp/files/<binary id>?exp=…&t=…&c=…&sig=…`.
 *   The signature covers the binary id, the expiry, the plugin and tool the call was for, and the caller, so one URL
 *   opens one file, for a while (LANDFLOW_MCP_FILE_URL_TTL_SECONDS, default 900), without a session: the agent
 *   (or a person it hands the link to) downloads it with a plain GET. Whoever got the result was already allowed to
 *   make the call, which is the permission check; it lives in the signature, so the route needs no sign-in (it is
 *   under the public `/api/mcp` prefix in lib/shared/auth-paths.ts). A tool result never carries base64 of a big file.
 * - **inline `image` / `audio`** (small files only): up to LANDFLOW_MCP_INLINE_MEDIA_MAX_BYTES per file (default 512 KiB)
 *   and at most INLINE_MAX_FILES per result, so a model can look at a screenshot or hear a clip without another
 *   request. Base64 adds a third; a client puts the whole result into a model's context, so the limit keeps a result
 *   to about a megabyte. Only formats models take: PNG, JPEG, GIF and WebP images (not SVG), and any audio/*.
 */
import { timingSafeEqual } from 'node:crypto';
import type { BinaryRef, NodeItem } from '@landflow/protocol';
import { binaryStore } from '../binary/access';
import { signPayload } from './signing';
import { readAll } from '../binary/store';
import { publicUrl } from '../runner';

/** Where the signed download route lives. */
export const MCP_FILES_PATH = '/api/mcp/files';
/** Content `_meta` key on a `resource_link` / inline block: what Landflow knows about the file. */
export const MCP_FILE_META_KEY = 'dev.landflow/file';

const DOMAIN = 'mcp-file.1';
const DEFAULT_TTL_SECONDS = 900;
const DEFAULT_INLINE_MAX_BYTES = 512 * 1024;
/** At most this many files of one result go inline (images first come first served); the rest are links. */
export const INLINE_MAX_FILES = 4;
/** At most this many `resource_link` blocks per result (the execution has every file). */
export const MAX_LINKS = 50;
const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;

export const fileUrlTtlSeconds = () => Math.max(1, Number(process.env.LANDFLOW_MCP_FILE_URL_TTL_SECONDS) || DEFAULT_TTL_SECONDS);
/** 0 turns inline media off (links only). */
export function inlineMaxBytes(): number {
  const value = process.env.LANDFLOW_MCP_INLINE_MEDIA_MAX_BYTES;
  if (value === undefined || value === '') return DEFAULT_INLINE_MAX_BYTES;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_INLINE_MAX_BYTES;
}

export interface FileUrlSubject {
  /** `<pluginId>/<tool>` the call was for. */
  tool: string;
  /** The caller, as the endpoint labels them (`kind:subject`). */
  caller: string;
}

const payloadOf = (id: string, exp: number, subject: FileUrlSubject) => `${id}\n${exp}\n${subject.tool}\n${subject.caller}`;

/** A signed, expiring URL for one stored file. */
export function signFileUrl(id: string, subject: FileUrlSubject, now = Date.now(), ttlSeconds = fileUrlTtlSeconds()): { url: string; expiresAt: string } {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const query = new URLSearchParams({ exp: String(exp), t: subject.tool, c: subject.caller, sig: signPayload(DOMAIN, payloadOf(id, exp, subject)) });
  return { url: `${publicUrl()}${MCP_FILES_PATH}/${encodeURIComponent(id)}?${query}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export type FileUrlCheck = { ok: true; subject: FileUrlSubject } | { ok: false; reason: 'invalid' | 'expired' };

/** Check the query of a download request against the binary id in its path. */
export function verifyFileUrl(id: string, params: URLSearchParams, now = Date.now()): FileUrlCheck {
  const exp = Number(params.get('exp'));
  const tool = params.get('t') ?? '';
  const caller = params.get('c') ?? '';
  const given = params.get('sig') ?? '';
  if (!Number.isInteger(exp) || !tool || !caller || !given) return { ok: false, reason: 'invalid' };
  const expected = Buffer.from(signPayload(DOMAIN, payloadOf(id, exp, { tool, caller })));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: 'invalid' };
  return exp * 1000 > now ? { ok: true, subject: { tool, caller } } : { ok: false, reason: 'expired' };
}

/** The content blocks a result adds for the files of its output items: links first, then small media inline. */
export interface FileBlocks {
  links: Array<Record<string, unknown>>;
  inline: Array<Record<string, unknown>>;
  /** How many files the output has in all (links stop at MAX_LINKS). */
  total: number;
}

interface FileEntry {
  ref: BinaryRef & { id: string };
  property: string;
  index: number;
}

function entriesOf(items: NodeItem[]): FileEntry[] {
  return items.flatMap((item, index) => Object.entries(item.binary ?? {}).flatMap(([property, ref]) => (ref?.id ? [{ ref: ref as FileEntry['ref'], property, index }] : [])));
}

/** Link every file of `items`, and inline the small images and audio. */
export async function fileBlocks(items: NodeItem[], subject: FileUrlSubject): Promise<FileBlocks> {
  const entries = entriesOf(items);
  const out: FileBlocks = { links: [], inline: [], total: entries.length };
  if (!entries.length) return out;
  const limit = inlineMaxBytes();
  const store = limit > 0 ? await binaryStore() : undefined;
  for (const { ref, property, index } of entries) {
    const mimeType = (ref.mimeType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    if (out.links.length < MAX_LINKS) {
      const { url, expiresAt } = signFileUrl(ref.id, subject);
      out.links.push({
        type: 'resource_link',
        uri: url,
        name: ref.fileName ?? (items.length > 1 ? `${property}-${index}` : property),
        title: ref.fileName ?? property,
        description: items.length > 1 ? `File “${property}” of item ${index}` : `File “${property}”`,
        mimeType,
        size: ref.fileSize,
        _meta: { [MCP_FILE_META_KEY]: { id: ref.id, expiresAt } },
      });
    }
    const kind = INLINE_IMAGE.test(mimeType) ? 'image' : mimeType.startsWith('audio/') ? 'audio' : undefined;
    if (store && kind && ref.fileSize > 0 && ref.fileSize <= limit && out.inline.length < INLINE_MAX_FILES) {
      const file = await store.open(ref.id);
      if (!file) continue;
      const bytes = await readAll(file.stream);
      if (bytes.length <= limit) out.inline.push({ type: kind, data: bytes.toString('base64'), mimeType });
    }
  }
  return out;
}
