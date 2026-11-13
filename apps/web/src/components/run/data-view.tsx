'use client';
/**
 * Items as n8n shows them: a Schema tree (fields, types, sample values), a
 * Table (one column per key) or raw JSON, plus a Binary view of their files
 * when any item carries one. The chosen mode is shared by every DataView and
 * remembered per browser (Binary falls back to Schema where there are no
 * files). Fills its parent's height; only the data area scrolls.
 */
import { useMemo, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react';
import { Braces, Brackets, ChevronRight, CircleSlash, Hash, ListTree, PackageOpen, Paperclip, Table2, ToggleLeft, Type } from 'lucide-react';
import { cn } from '@/lib/utils';
import { binaryEntriesOf } from '@/lib/client/binary';
import { tint } from '@/lib/client/node-style';
import type { NodeItem } from '@/lib/shared/types';
import { JsonView } from '../ui/json-view';
import { BinaryMode } from './binary-view';
import { Segmented } from '../ui/segmented';

export type DataMode = 'schema' | 'table' | 'json' | 'binary';

export interface DataViewProps {
  items: NodeItem[] | undefined;
  /** Shown when there are no items. */
  emptyLabel?: ReactNode;
  /** Field names can be dragged out as `{{ $json.path }}` expressions. */
  draggable?: boolean;
  /** Extra controls on the left of the header row (e.g. an Input/Output switch). */
  toolbar?: ReactNode;
  /** Rendered between the header and the data (errors, hints). */
  notice?: ReactNode;
  className?: string;
}

/** Custom drag MIME type; the payload is `{ path: (string | number)[] }`. text/plain carries the expression. */
export const FIELD_DRAG_TYPE = 'application/x-landflow-field';

// ------------------------------------------------------------- shared mode

const MODE_KEY = 'landflow-data-mode';
const modeListeners = new Set<() => void>();
let currentMode: DataMode | undefined;

function readMode(): DataMode {
  if (currentMode) return currentMode;
  try {
    const stored = localStorage.getItem(MODE_KEY);
    currentMode = stored === 'table' || stored === 'json' || stored === 'binary' ? stored : 'schema';
  } catch {
    currentMode = 'schema';
  }
  return currentMode;
}

function setMode(mode: DataMode) {
  currentMode = mode;
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {}
  modeListeners.forEach((l) => l());
}

function useDataMode(): DataMode {
  return useSyncExternalStore(
    (cb) => {
      modeListeners.add(cb);
      return () => modeListeners.delete(cb);
    },
    readMode,
    () => 'schema',
  );
}

// ------------------------------------------------------------------ fields

type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
type Path = (string | number)[];

const TYPE_META: Record<FieldType, { icon: typeof Type; color: string; label: string }> = {
  string: { icon: Type, color: 'var(--viz-3)', label: 'string' },
  number: { icon: Hash, color: 'var(--viz-1)', label: 'number' },
  boolean: { icon: ToggleLeft, color: 'var(--viz-7)', label: 'boolean' },
  object: { icon: Braces, color: 'var(--viz-2)', label: 'object' },
  array: { icon: Brackets, color: 'var(--viz-5)', label: 'array' },
  null: { icon: CircleSlash, color: 'var(--t3)', label: 'null' },
};

function typeOf(value: unknown): FieldType {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean' ? t : t === 'object' ? 'object' : 'string';
}

/** `$json.a.b[0]['odd key']` for a field path. */
export function fieldExpression(path: Path): string {
  const body = path.map((p) => (typeof p === 'number' ? `[${p}]` : /^[A-Za-z_$][\w$]*$/.test(p) ? `.${p}` : `['${p.replace(/'/g, "\\'")}']`)).join('');
  return `{{ $json${body} }}`;
}

function onFieldDrag(path: Path) {
  return (e: DragEvent) => {
    e.dataTransfer.setData('text/plain', fieldExpression(path));
    e.dataTransfer.setData(FIELD_DRAG_TYPE, JSON.stringify({ path }));
    e.dataTransfer.effectAllowed = 'copy';
  };
}

interface SchemaField {
  key: string;
  path: Path;
  type: FieldType;
  sample: unknown;
  children?: SchemaField[];
}

const SAMPLE_LIMIT = 100;

/** Merge the fields of many objects (first seen order); samples come from the first value that has the field. */
function schemaOf(values: unknown[], base: Path): SchemaField[] {
  const fields = new Map<string, unknown[]>();
  for (const value of values.slice(0, SAMPLE_LIMIT)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      const list = fields.get(key) ?? [];
      list.push(child);
      fields.set(key, list);
    }
  }
  return [...fields.entries()].map(([key, seen]) => {
    const sample = seen.find((v) => v !== null && v !== undefined) ?? seen[0];
    const type = typeOf(sample);
    const path = [...base, key];
    let children: SchemaField[] | undefined;
    if (type === 'object') children = schemaOf(seen, path);
    else if (type === 'array') {
      const elements = seen.flatMap((v) => (Array.isArray(v) ? v : []));
      if (elements.some((el) => typeOf(el) === 'object')) children = schemaOf(elements, [...path, 0]);
    }
    return { key, path, type, sample, children };
  });
}

/** Every field of the items, depth first, with its expression: for picking one by tapping on a phone (param-form.tsx). */
export function fieldList(items: NodeItem[] | undefined): Array<{ key: string; depth: number; expression: string; sample: string }> {
  const out: Array<{ key: string; depth: number; expression: string; sample: string }> = [];
  const walk = (fields: SchemaField[], depth: number) => {
    for (const field of fields) {
      out.push({ key: field.key, depth, expression: fieldExpression(field.path), sample: sampleText(field) });
      if (field.children) walk(field.children, depth + 1);
    }
  };
  walk(schemaOf((items ?? []).map((i) => i.json), []), 0);
  return out;
}

function sampleText(field: SchemaField): string {
  const { type, sample } = field;
  if (type === 'array') return `${(sample as unknown[]).length} item${(sample as unknown[]).length === 1 ? '' : 's'}${!field.children ? ` · ${(sample as unknown[]).slice(0, 4).map((v) => JSON.stringify(v)).join(', ')}` : ''}`;
  if (type === 'object') return `${Object.keys(sample as object).length} fields`;
  if (type === 'null') return 'null';
  const text = String(sample);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function TypeBadge({ type }: { type: FieldType }) {
  const { icon: Icon, color, label } = TYPE_META[type];
  return (
    <span title={label} className="grid size-[18px] shrink-0 place-items-center rounded-[5px]" style={{ background: tint(color, 16), color }}>
      <Icon className="size-3" strokeWidth={2.2} />
    </span>
  );
}

function SchemaRow({ field, depth, draggable, index }: { field: SchemaField; depth: number; draggable?: boolean; index: number }) {
  const [open, setOpen] = useState(depth < 2);
  const expandable = Boolean(field.children?.length);
  return (
    <div className={depth === 0 ? 'animate-fade-up' : undefined} style={depth === 0 ? { animationDelay: `${Math.min(index, 14) * 22}ms` } : undefined}>
      <div className="group flex min-w-0 items-center gap-1.5 rounded-md py-[3px] pr-2 hover:bg-acdim" style={{ paddingLeft: depth * 16 + 4 }}>
        <button
          tabIndex={expandable ? 0 : -1}
          aria-label={expandable ? (open ? 'Collapse' : 'Expand') : undefined}
          onClick={() => expandable && setOpen(!open)}
          className={cn('grid size-4 shrink-0 place-items-center text-t3', !expandable && 'invisible')}
        >
          <ChevronRight className={cn('size-3 transition-transform duration-150', open && 'rotate-90')} />
        </button>
        <TypeBadge type={field.type} />
        <span
          draggable={draggable}
          onDragStart={draggable ? onFieldDrag(field.path) : undefined}
          title={draggable ? `Drag to use ${fieldExpression(field.path)}` : undefined}
          className={cn('shrink-0 rounded px-1 font-mono text-[12px] font-medium text-t1', draggable && 'cursor-grab border border-transparent group-hover:border-bd group-hover:bg-sf active:cursor-grabbing')}
        >
          {field.key}
        </span>
        <span className={cn('min-w-0 truncate font-mono text-[12px]', field.type === 'string' ? 'text-t2' : field.type === 'number' ? 'text-viz-1' : field.type === 'boolean' ? 'text-viz-7' : 'text-t3')}>{sampleText(field)}</span>
      </div>
      {expandable && open && (
        <div className="relative">
          <span className="absolute bottom-1 top-0 border-l border-hair" style={{ left: depth * 16 + 11 }} />
          {field.children!.map((child, i) => (
            <SchemaRow key={child.key} field={child} depth={depth + 1} draggable={draggable} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

function SchemaMode({ items, draggable }: { items: NodeItem[]; draggable?: boolean }) {
  const fields = useMemo(() => schemaOf(items.map((i) => i.json), []), [items]);
  if (!fields.length) return <div className="px-3 py-4 text-[12px] text-t3">Items have no fields.</div>;
  return (
    <div className="p-1.5">
      {fields.map((field, i) => (
        <SchemaRow key={field.key} field={field} depth={0} draggable={draggable} index={i} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- table

const ROW_LIMIT = 200;

function Cell({ value }: { value: unknown }) {
  const type = typeOf(value);
  if (type === 'null') return <span className="italic text-t3">{value === null ? 'null' : ''}</span>;
  if (type === 'object' || type === 'array') {
    const text = JSON.stringify(value);
    return (
      <span title={text.length > 80 ? text.slice(0, 2000) : undefined} className="font-mono text-[11px] text-t3">
        {text.length > 80 ? `${text.slice(0, 80)}…` : text}
      </span>
    );
  }
  const text = String(value);
  return <span className={cn(type === 'number' && 'font-mono text-viz-1', type === 'boolean' && 'font-mono text-viz-7')}>{text.length > 160 ? `${text.slice(0, 160)}…` : text}</span>;
}

function TableMode({ items, draggable }: { items: NodeItem[]; draggable?: boolean }) {
  const [limit, setLimit] = useState(ROW_LIMIT);
  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const item of items.slice(0, SAMPLE_LIMIT * 2)) for (const key of Object.keys(item.json ?? {})) keys.add(key);
    return [...keys];
  }, [items]);
  return (
    <div className="min-w-full">
      <table className="w-max min-w-full border-separate border-spacing-0 text-[12px]">
        <thead>
          <tr>
            <th className="sticky top-0 z-10 border-b border-hair bg-sf2 px-2.5 py-1.5 text-right font-mono text-[11px] font-medium text-t3">#</th>
            {columns.map((key) => (
              <th key={key} className="sticky top-0 z-10 border-b border-l border-hair bg-sf2 px-2.5 py-1.5 text-left font-semibold text-t1">
                <span
                  draggable={draggable}
                  onDragStart={draggable ? onFieldDrag([key]) : undefined}
                  className={cn('rounded px-1', draggable && 'cursor-grab hover:bg-acdim')}
                >
                  {key}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.slice(0, limit).map((item, i) => (
            <tr key={i} className="animate-fade-up hover:bg-acdim" style={{ animationDelay: `${Math.min(i, 14) * 18}ms` }}>
              <td className="border-b border-hair px-2.5 py-1.5 text-right align-top font-mono text-[11px] text-t3">{i}</td>
              {columns.map((key) => (
                <td key={key} className="max-w-[320px] border-b border-l border-hair px-2.5 py-1.5 align-top text-t1">
                  <Cell value={item.json?.[key]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > limit && (
        <button onClick={() => setLimit((l) => l + ROW_LIMIT)} className="m-2 rounded-full border border-hair px-3 py-1 text-[12px] text-t2 hover:border-bd hover:text-t1">
          Show {Math.min(ROW_LIMIT, items.length - limit)} more of {items.length - limit}
        </button>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- view

const MODES: Array<{ mode: DataMode; label: string; icon: typeof Table2 }> = [
  { mode: 'schema', label: 'Schema', icon: ListTree },
  { mode: 'table', label: 'Table', icon: Table2 },
  { mode: 'json', label: 'JSON', icon: Braces },
  { mode: 'binary', label: 'Binary', icon: Paperclip },
];

export function DataView({ items, emptyLabel = 'No data', draggable, toolbar, notice, className }: DataViewProps) {
  const chosen = useDataMode();
  const list = items ?? [];
  const files = useMemo(() => binaryEntriesOf(items).length, [items]);
  // The Binary tab exists only while items carry files; elsewhere a stored Binary choice shows the Schema.
  const mode = chosen === 'binary' && !files ? 'schema' : chosen;
  return (
    <div className={cn('@container flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
        {toolbar}
        <span className="font-mono text-[11px] text-t3">
          {list.length} item{list.length === 1 ? '' : 's'}
          {files > 0 && (
            <>
              {' · '}
              <button onClick={() => setMode('binary')} className="hover:text-t1" title="Show the files">
                {files} file{files === 1 ? '' : 's'}
              </button>
            </>
          )}
        </span>
        <Segmented
          label="Display mode"
          size="sm"
          className="ml-auto"
          value={mode}
          onChange={setMode}
          options={MODES.filter(({ mode: m }) => m !== 'binary' || files > 0).map(({ mode: m, label, icon: Icon }) => ({
            value: m,
            title: label,
            ariaLabel: label,
            label: (
              <>
                <Icon className="size-3" />
                <span className="hidden @xl:inline">{label}</span>
              </>
            ),
          }))}
        />
      </div>
      {notice && <div className="shrink-0 px-3 pb-2">{notice}</div>}
      <div className="min-h-0 flex-1 overflow-auto border-t border-hair">
        {!list.length ? (
          <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 p-6 text-center animate-in">
            <span className="grid size-10 place-items-center rounded-full bg-sf2 text-t3 ring-1 ring-hair">
              <PackageOpen className="size-[18px]" strokeWidth={1.6} />
            </span>
            <div className="max-w-[36ch] text-[13px] text-t2">{emptyLabel}</div>
          </div>
        ) : mode === 'schema' ? (
          <SchemaMode items={list} draggable={draggable} />
        ) : mode === 'table' ? (
          <TableMode items={list} draggable={draggable} />
        ) : mode === 'binary' ? (
          <BinaryMode items={list} />
        ) : (
          <div className="px-3 py-2">
            <JsonView value={list.map((i) => i.json)} />
          </div>
        )}
      </div>
    </div>
  );
}
