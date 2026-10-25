'use client';
/** Column type icons, labels and cell formatting shared by the Data Tables views. */
import { Calendar, Hash, ToggleLeft, Type } from 'lucide-react';
import type { CellValue, ColumnType } from '@/lib/shared/data-tables';

export const TYPE_META: Record<ColumnType, { label: string; icon: typeof Type }> = {
  string: { label: 'String', icon: Type },
  number: { label: 'Number', icon: Hash },
  boolean: { label: 'Boolean', icon: ToggleLeft },
  date: { label: 'Date', icon: Calendar },
};

export function TypeIcon({ type, className = 'size-3.5' }: { type: ColumnType; className?: string }) {
  const Icon = TYPE_META[type]?.icon ?? Type;
  return <Icon className={className} strokeWidth={1.8} aria-label={TYPE_META[type]?.label} />;
}

const dateFormat = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : undefined;

/** A cell as text for the grid. */
export function formatCell(value: CellValue | undefined, type: ColumnType): string {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'date') {
    const ms = Date.parse(String(value));
    return Number.isNaN(ms) ? String(value) : (dateFormat?.format(ms) ?? String(value));
  }
  if (type === 'number' && typeof value === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 10 });
  return String(value);
}

/** ISO → the value of an `<input type="datetime-local">` in the browser's zone. */
export function toLocalInput(value: CellValue | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
