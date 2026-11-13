/**
 * Paging for list routes: `limit` (an integer 1-500, default 100) and an opaque `cursor` that encodes the keyset
 * position of the last row returned (`s` its start time as saved, `i` its id), so pages stay stable while rows are added.
 */
import { z } from 'zod';

export const MAX_PAGE = 500;
export const DEFAULT_PAGE = 100;

export interface Cursor {
  s: string;
  i: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** The position a cursor names, or undefined when it isn't one this module made. */
export function decodeCursor(text: string): Cursor | undefined {
  try {
    const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<Cursor>;
    return typeof value.s === 'string' && typeof value.i === 'string' ? { s: value.s, i: value.i } : undefined;
  } catch {
    return undefined;
  }
}

/** A `limit` query value: an integer from 1 to `max`, `fallback` when absent. Infinity, text and fractions are refused. */
export const limitParam = (max = MAX_PAGE, fallback = DEFAULT_PAGE) => z.coerce.number().int().min(1).max(max).default(fallback);

export const pageSchema = z.object({
  limit: limitParam(),
  cursor: z
    .string()
    .max(512)
    .refine((text) => decodeCursor(text) !== undefined, 'Not a cursor from this API')
    .optional(),
});
export type PageQuery = z.infer<typeof pageSchema>;
