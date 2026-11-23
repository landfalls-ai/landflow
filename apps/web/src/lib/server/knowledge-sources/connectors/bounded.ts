/**
 * C22: reading a body with a byte cap that counts what arrives AFTER decompression (fetch gives the decoded stream), so a small
 * gzip file that inflates to gigabytes stops at the cap, with the rest never read. Used for pages, robots.txt, S3 objects and
 * Drive downloads.
 */
import { SourceError } from './types';

export class TooLargeError extends SourceError {}

export const megabytes = (bytes: number): string => (bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * The bytes of `body`, at most `cap`. Past it: with `truncate` the first `cap` bytes, otherwise a TooLargeError (the stream is
 * cancelled). `body` is a web stream or a Node stream (anything async-iterable).
 */
export async function readCapped(body: unknown, cap: number, options: { truncate?: boolean } = {}): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iterable = body as AsyncIterable<Uint8Array | string>;
  for await (const raw of iterable) {
    const chunk = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
    if (total + chunk.length > cap) {
      if (!options.truncate) throw new TooLargeError(`Too large (the limit is ${megabytes(cap)})`);
      chunks.push(chunk.subarray(0, cap - total));
      total = cap;
      break; // leaving the loop cancels the stream
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
