/**
 * Custom usage event kinds (docs/second-brain.md#your-own-event-kinds): a flow writes its own events into the ledger with
 * Record Event, under a name like `work.ticket_moved` whose attributes were declared first. The declaration lives in the
 * `usage_kinds` table; this file reads and writes it, and checks an event's attributes against it.
 *
 * Unknown attributes are dropped, not rejected, and the caller is told which: a flow that grows a field before its kind is
 * updated keeps recording. A missing required attribute or one of the wrong type is an error, since the event would be
 * useless to whatever reads it.
 */
import { ATTR_NAME, customKindProblem, type CustomUsageKind, type UsageAttr, type UsageFieldType, type UsageKindDef, type UsageKindField } from '../../shared/brain';
import { database, type Database } from '../db';

export const MAX_FIELDS = 20;
/** Attribute names the ledger writes itself; a declared field can't use them. */
export const RESERVED_ATTRS = ['recordedBy'];

interface KindRow {
  kind: string;
  description: string;
  fields: string;
  project_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: KindRow): UsageKindDef {
  let fields: UsageKindField[] = [];
  try {
    fields = JSON.parse(row.fields) as UsageKindField[];
  } catch {
    fields = [];
  }
  return {
    kind: row.kind as CustomUsageKind,
    description: row.description,
    fields,
    ...(row.project_id && { projectId: row.project_id }),
    ...(row.created_by && { createdBy: row.created_by }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const listKinds = (db: Database = database()): UsageKindDef[] => db.all<KindRow>('SELECT * FROM usage_kinds ORDER BY kind').map(fromRow);

export function getKind(kind: string, db: Database = database()): UsageKindDef | undefined {
  const row = db.get<KindRow>('SELECT * FROM usage_kinds WHERE kind = ?', kind);
  return row && fromRow(row);
}

/** A problem with a kind's fields (names, types, duplicates, the cap), or undefined. */
export function fieldsProblem(fields: UsageKindField[]): string | undefined {
  if (fields.length > MAX_FIELDS) return `A kind declares at most ${MAX_FIELDS} fields`;
  const seen = new Set<string>();
  for (const field of fields) {
    if (!ATTR_NAME.test(field.name)) return `“${field.name}” isn’t a field name: letters, digits and underscores, starting with a letter (40 at most)`;
    if (RESERVED_ATTRS.includes(field.name)) return `“${field.name}” is kept for Landflow; pick another field name`;
    if (seen.has(field.name)) return `The field “${field.name}” is declared twice`;
    seen.add(field.name);
  }
  return undefined;
}

export class KindError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Declare a kind, or change its description and fields (its creator and project stay). */
export function saveKind(input: { kind: string; description?: string; fields?: UsageKindField[]; projectId?: string; createdBy?: string }, db: Database = database()): UsageKindDef {
  const problem = customKindProblem(input.kind) ?? fieldsProblem(input.fields ?? []);
  if (problem) throw new KindError(problem);
  const existing = getKind(input.kind, db);
  const now = new Date().toISOString();
  const fields = (input.fields ?? existing?.fields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    ...(f.required && { required: true }),
    ...(f.description && { description: f.description.slice(0, 200) }),
  }));
  const def: UsageKindDef = {
    kind: input.kind as CustomUsageKind,
    description: (input.description ?? existing?.description ?? '').slice(0, 300),
    fields,
    ...((existing?.projectId ?? input.projectId) && { projectId: existing?.projectId ?? input.projectId }),
    ...((existing?.createdBy ?? input.createdBy) && { createdBy: existing?.createdBy ?? input.createdBy }),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  db.upsert('usage_kinds', {
    kind: def.kind,
    description: def.description,
    fields: JSON.stringify(def.fields),
    project_id: def.projectId ?? null,
    created_by: def.createdBy ?? null,
    created_at: def.createdAt,
    updated_at: def.updatedAt,
  });
  return def;
}

/** Forget a kind's declaration. Events already recorded stay in the ledger. */
export const deleteKind = (kind: string, db: Database = database()): boolean => db.delete('usage_kinds', { kind }) > 0;

const typeOf = (value: unknown): UsageFieldType | undefined => (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? (typeof value as UsageFieldType) : undefined);

/** Fields inferred from sample attributes, for declaring a kind on first use. */
export const inferFields = (attrs: Record<string, unknown>): UsageKindField[] =>
  Object.entries(attrs)
    .filter(([name, value]) => ATTR_NAME.test(name) && !RESERVED_ATTRS.includes(name) && typeOf(value))
    .slice(0, MAX_FIELDS)
    .map(([name, value]) => ({ name, type: typeOf(value) as UsageFieldType }));

/** A string where a number or boolean is declared reads as one when it plainly is ("12", "true"): values from forms and expressions arrive as text. */
function coerce(value: unknown, type: UsageFieldType): UsageAttr | undefined {
  if (typeOf(value) === type) return value as UsageAttr;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (type === 'number' && text !== '' && Number.isFinite(Number(text))) return Number(text);
  if (type === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
  return undefined;
}

/**
 * `attrs` checked against a kind's fields: the attributes to record and the names dropped for not being declared.
 * Throws a KindError naming the field when a required one is missing (or empty) or one has the wrong type.
 */
export function checkAttrs(def: UsageKindDef, attrs: Record<string, unknown>): { attrs: Record<string, UsageAttr>; dropped: string[] } {
  const out: Record<string, UsageAttr> = {};
  for (const field of def.fields) {
    const value = attrs[field.name];
    if (value === undefined || value === null || value === '') {
      if (field.required) throw new KindError(`${def.kind} needs “${field.name}” (${field.type})`);
      continue;
    }
    const checked = coerce(value, field.type);
    if (checked === undefined) throw new KindError(`${def.kind}: “${field.name}” should be a ${field.type}, got ${typeof value === 'object' ? 'an object' : `“${String(value).slice(0, 40)}”`}`);
    out[field.name] = checked;
  }
  const declared = new Set(def.fields.map((f) => f.name));
  return { attrs: out, dropped: Object.keys(attrs).filter((name) => !declared.has(name)) };
}
