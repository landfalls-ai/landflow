/**
 * Human output: aligned tables and small formatters. JSON output never goes through here (see main's `run`).
 */

export interface Column<T> {
  label: string;
  value: (row: T) => string | number | boolean | null | undefined;
  /** Cut longer values with an ellipsis. */
  max?: number;
  align?: 'left' | 'right';
}

const cell = (value: unknown) => (value === null || value === undefined || value === '' ? '-' : typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value));

/** A table with a header row, columns two spaces apart; `empty` when there are no rows. */
export function table<T>(rows: T[], columns: Array<Column<T>>, empty = 'Nothing to show.'): string {
  if (!rows.length) return empty;
  const cells = rows.map((row) =>
    columns.map((column) => {
      const text = cell(column.value(row)).replace(/\s+/g, ' ');
      return column.max && text.length > column.max ? `${text.slice(0, column.max - 1)}…` : text;
    }),
  );
  const widths = columns.map((column, i) => Math.max(column.label.length, ...cells.map((row) => row[i].length)));
  const line = (values: string[]) =>
    values
      .map((value, i) => (columns[i].align === 'right' ? value.padStart(widths[i]) : value.padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  return [line(columns.map((c) => c.label.toUpperCase())), ...cells.map(line)].join('\n');
}

/** `2026-10-25 18:04` (UTC) from an ISO time. */
export function time(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 16).replace('T', ' ');
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** `3 workflows`, `1 entry`, `0 entries`: a word ending in a consonant and y takes -ies. */
export const plural = (n: number, word: string) => `${n} ${n === 1 ? word : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`}`;

/** `key: value` lines, aligned. */
export function fields(pairs: Array<[string, unknown]>): string {
  const width = Math.max(...pairs.map(([key]) => key.length));
  return pairs.map(([key, value]) => `${`${key}:`.padEnd(width + 1)} ${cell(value)}`).join('\n');
}
