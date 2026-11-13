/**
 * Exception fingerprint: a short hash of the exception type and the top in-repo frames of its stack, with line and column
 * numbers and the checkout path stripped, so the same bug groups across releases and machines while two call sites don't.
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
  const file = rawFile
    .replace(/^(webpack-internal:\/\/\/\([^)]*\)\/|webpack:\/\/[^/]*\/|file:\/\/)/, '')
    .replace(/[?#].*$/, '')
    // A bundled chunk or a checkout path: keep what follows the first source root, so the key doesn't move with the install.
    .replace(/^.*?[\\/]((?:src|packages|plugins|services|sdks)[\\/])/, '$1');
  return `${fn} ${file}`.trim();
}

export function exceptionFingerprint(error: unknown): string {
  const type = error instanceof Error ? error.name : typeof error;
  const frames = (error instanceof Error ? (error.stack ?? '').split('\n') : [])
    .map(frameKey)
    .filter((key): key is string => key !== undefined)
    .slice(0, FRAMES);
  return createHash('sha1').update([type, ...frames].join('\n')).digest('hex').slice(0, 12);
}
