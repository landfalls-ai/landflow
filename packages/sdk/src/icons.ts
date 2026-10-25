/**
 * `file:` icons. Plugin authors point `icon` at an SVG/PNG next to their code
 * (n8n style: `icon: 'file:slugify.svg'`) and the SDK inlines it as a
 * `data:` URL when the manifest is built, so icons travel the same way over
 * HTTP and gRPC and the host never has to fetch (or see) a file path.
 *
 *   definePlugin({ info: { icon: 'file:text-toolkit.svg', ... }, nodes, iconDir: new URL('../icons/', import.meta.url) });
 *   icon: iconFile(new URL('./icons/x.svg', import.meta.url)),   // one-off, no iconDir needed
 */
import { readFileSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Icons are inlined into every manifest, so keep them small. */
export const MAX_ICON_BYTES = 64 * 1024;

const MIME_TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png' };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Accepts a path, a `file://` URL string or a URL object. */
export function toPath(location: string | URL): string {
  if (location instanceof URL || location.startsWith('file://')) return fileURLToPath(location);
  return location;
}

/** Read an SVG/PNG (at most MAX_ICON_BYTES) and return it as a base64 `data:` URL. */
export function iconFile(location: string | URL): string {
  const path = toPath(location);
  const mime = MIME_TYPES[extname(path).toLowerCase()];
  if (!mime) throw new Error(`icon ${path}: only .svg and .png files are supported`);
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (error) {
    throw new Error(`icon ${path}: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : (error as Error).message}`);
  }
  if (data.length > MAX_ICON_BYTES) {
    throw new Error(`icon ${path}: ${data.length} bytes exceeds the ${MAX_ICON_BYTES / 1024} KB limit (icons are inlined into the manifest)`);
  }
  const valid = mime === 'image/png' ? data.subarray(0, 8).equals(PNG_SIGNATURE) : /<svg[\s>]/.test(data.toString('utf8'));
  if (!valid) throw new Error(`icon ${path}: content is not a valid ${mime === 'image/png' ? 'PNG' : 'SVG'} file`);
  return `data:${mime};base64,${data.toString('base64')}`;
}

/**
 * `file:<path>` → data: URL (relative paths resolve against `iconDir`); any
 * other icon (lucide:, emoji:, https:, data:) is returned unchanged.
 */
export function resolveIcon(icon: string | undefined, iconDir?: string): string | undefined {
  if (!icon?.startsWith('file:')) return icon;
  // "file:///abs/x.svg" is a real file URL; "file:x.svg" / "file:icons/x.svg" is n8n's relative form.
  const path = icon.startsWith('file://') ? fileURLToPath(icon) : icon.slice('file:'.length);
  if (isAbsolute(path)) return iconFile(path);
  if (!iconDir) throw new Error(`icon "${icon}" is relative: pass iconDir to definePlugin (e.g. new URL('../icons/', import.meta.url))`);
  return iconFile(resolve(iconDir, path));
}
