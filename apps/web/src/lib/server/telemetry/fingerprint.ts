/**
 * Exception fingerprint: a short hash of the exception type and the top in-repo frames of its stack, with line and column
 * numbers and the checkout path stripped, so the same bug groups across releases and machines while two call sites don't (in a minified production bundle: by chunk name words).
 * Put on error log lines (`exception.fingerprint`, logger.ts) and on exception span events (spans.ts). See docs/observability.md §3.
 */
import { createHash } from 'node:crypto';

const FRAMES = 3;

/** `at fn (file:12:3)` / `at file:12:3` -> `fn file`, or undefined for node internals and dependencies. */
function frameKey(line: string): string | undefined {
  const match = /^\s*at (?:(.*?) \()?(.+?)(?::\d+){0,2}\)?$/.exec(line);
  if (!match) return undefined;
  const [, fn = '', rawFile] = match;
  if (rawFile.startsWith('node:') || /node_modules|\(<anonymous>\)|^native\b/.test(rawFile)) return undefined;
  const cleaned = rawFile
    .replace(/^(webpack-internal:\/\/\/\([^)]*\)\/|webpack:\/\/[^/]*\/|file:\/\/)/, '')
    .replace(/[?#].*$/, '');
  // A production bundle (Next standalone): the chunk name carries a content hash and the function names are minified,
  // so the key is the chunk's source-path words alone. Grouping is coarser than in dev: by exception type and chunk name words (many chunks share a name), not by call site.
  const bundled = /(?:^|[\\/])\.next[\\/]/.exec(cleaned);
  if (bundled) {
    const chunk = (cleaned.split(/[\\/]/).pop() ?? '').replace(/\.(?:c|m)?js$/, '');
    // The content hash is 13 characters of [0-9a-z_-] (underscores and hyphens anywhere), after `._` is removed.
    const words = chunk.replace(/\._$/, '').replace(/(?:^|_)[0-9a-z_-]{13}$/, '');
    return `chunk ${/^\d+$/.test(words) || /^[0-9a-f]{8,}$/.test(words) ? 'webpack' : words}`;
  }
  // A checkout path: anchor on the repo layout so a parent directory named `src` doesn't leak into the key.
  const file = cleaned
    .replace(/^.*?[\\/](apps[\\/]web[\\/]src[\\/])/, '$1')
    .replace(/^.*?[\\/](packages[\\/][^\\/]+[\\/])/, '$1')
    .replace(/^.*?[\\/]((?:plugins|services|sdks)[\\/])/, '$1');
  return `${fn.replace(/^async /, '')} ${file}`.trim();
}

export function exceptionFingerprint(error: unknown): string {
  const type = error instanceof Error ? error.name : typeof error;
  const frames = (error instanceof Error ? (error.stack ?? '').split('\n') : [])
    .map(frameKey)
    .filter((key): key is string => key !== undefined)
    .slice(0, FRAMES);
  return createHash('sha1').update([type, ...frames].join('\n')).digest('hex').slice(0, 12);
}
