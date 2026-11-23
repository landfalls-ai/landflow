/**
 * Output and input shaping: SAP's `d`/`results` wrapper, `__metadata` and `__deferred` links are stripped on read (the ETag is kept as
 * `__etag` and the key values as `__keys`), V2 `/Date(ms)/` becomes ISO 8601, personal fields can be blanked, and a write body is
 * checked against `$metadata` before it is sent.
 */
import { NodeOperationError } from '@landflow/sdk';
import type { JsonObject } from '@landflow/sdk';
import { entityTypeOf, type MetaEntityType, type ServiceMetadata } from './metadata';
import { parseKeyPredicate, type ODataVersion } from './query';

const SAP_DATE = /^\/Date\((-?\d+)([+-]\d+)?\)\/$/;

export function fromSapDate(value: string): string | undefined {
  const m = SAP_DATE.exec(value);
  if (!m) return undefined;
  const date = new Date(Number(m[1]));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export const toSapDate = (iso: string): string | undefined => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : `/Date(${date.getTime()})/`;
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Strips V2 wrappers recursively: `{results: [...]}` becomes the array, `__metadata` and `__deferred` go. */
export function cleanValue(value: unknown, keepSapDates = false): unknown {
  if (Array.isArray(value)) return value.map((v) => cleanValue(v, keepSapDates));
  if (typeof value === 'string') return keepSapDates ? value : (fromSapDate(value) ?? value);
  if (!isObject(value)) return value;
  if (Array.isArray(value.results) && Object.keys(value).every((k) => k === 'results' || k === '__count' || k === '__next')) return value.results.map((v) => cleanValue(v, keepSapDates));
  if ('__deferred' in value && Object.keys(value).length === 1) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === '__metadata' || key === '__deferred') continue;
    if (key.startsWith('@odata.') || key.startsWith('@')) continue;
    const cleaned = cleanValue(entry, keepSapDates);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

/** One entity as a plain item: cleaned fields, plus `__etag` and `__keys` when they are known. */
export function shapeEntity(raw: unknown, meta: ServiceMetadata | undefined, entitySet: string, options: { keepSapDates?: boolean; version?: ODataVersion; headerEtag?: string; keyNames?: string[] } = {}): JsonObject {
  if (!isObject(raw)) return { value: raw as never };
  const metadata = isObject(raw.__metadata) ? raw.__metadata : undefined;
  const cleaned = cleanValue(raw, options.keepSapDates) as Record<string, unknown>;
  const etag = (typeof metadata?.etag === 'string' ? metadata.etag : undefined) ?? (typeof raw['@odata.etag'] === 'string' ? (raw['@odata.etag'] as string) : undefined) ?? options.headerEtag;
  let keys: Record<string, unknown> | undefined;
  const type: MetaEntityType | undefined = meta ? entityTypeOf(meta, entitySet) : undefined;
  if (type?.keys.length) {
    const picked = Object.fromEntries(type.keys.filter((k) => k in cleaned).map((k) => [k, cleaned[k]]));
    if (Object.keys(picked).length === type.keys.length) keys = picked;
  }
  // Without $metadata the catalog's key names say which properties are the keys.
  if (!keys && options.keyNames?.length && options.keyNames.every((k) => k in cleaned)) keys = Object.fromEntries(options.keyNames.map((k) => [k, cleaned[k]]));
  if (!keys && typeof metadata?.uri === 'string') keys = parseKeyPredicate(metadata.uri);
  return { ...cleaned, ...(etag && { __etag: etag }), ...(keys && { __keys: keys as JsonObject }) } as JsonObject;
}

/** Personal and bank properties blanked when "Redact Personal Data" is on (the list is UNVERIFIED, see the spec). */
export const PERSONAL_FIELDS = [
  'FirstName',
  'LastName',
  'MiddleName',
  'BusinessPartnerName',
  'BusinessPartnerFullName',
  'OrganizationBPName1',
  'OrganizationBPName2',
  'PersonFullName',
  'EmailAddress',
  'PhoneNumber',
  'MobilePhoneNumber',
  'FaxNumber',
  'StreetName',
  'HouseNumber',
  'PostalCode',
  'CityName',
  'BankAccount',
  'BankAccountHolderName',
  'BankNumber',
  'BankControlKey',
  'IBAN',
  'SWIFTCode',
  'TaxNumber1',
  'TaxNumber2',
  'TaxNumber3',
  'TaxNumber4',
  'TaxNumber5',
  'VATRegistration',
  'BirthDate',
];

export const REDACTED = '[redacted]';

/** A copy with every property named in `fields` (at any depth) replaced by `[redacted]`. Keys of `__keys` are left alone. */
export function redact<T>(value: T, fields: ReadonlySet<string>): T {
  if (fields.size === 0) return value;
  const walk = (v: unknown, inKeys: boolean): unknown => {
    if (Array.isArray(v)) return v.map((e) => walk(e, inKeys));
    if (!isObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(v)) out[k] = !inKeys && fields.has(k) && e !== null && e !== undefined && e !== '' ? REDACTED : walk(e, k === '__keys');
    return out;
  };
  return walk(value, false) as T;
}

export function redactSet(list: string, personal: boolean): Set<string> {
  const names = new Set(
    String(list ?? '')
      .split(/[,\s]+/)
      .map((n) => n.trim())
      .filter(Boolean),
  );
  if (personal) for (const f of PERSONAL_FIELDS) names.add(f);
  return names;
}

/**
 * Checks a create or update body against `$metadata` (when known) and converts it for SAP: ISO dates to `/Date(ms)/` for V2
 * `Edm.DateTime` properties. A property missing from the entity type is refused before the request. Navigation properties (deep
 * insert) are allowed when the metadata lists them; their members are not checked. `update` refuses key properties and properties
 * marked `sap:updatable="false"`, `create` those marked `sap:creatable="false"`.
 */
export function prepareBody(body: unknown, meta: ServiceMetadata | undefined, entitySet: string, mode: 'create' | 'update', version: ODataVersion, keepSapDates = false): JsonObject {
  if (!isObject(body)) throw new NodeOperationError('The fields must be a JSON object');
  if (Object.keys(body).length === 0) throw new NodeOperationError('The fields object is empty');
  const type = meta ? entityTypeOf(meta, entitySet) : undefined;
  if (meta && !type) throw new NodeOperationError(`"${entitySet}" is not an entity set of this tenant's service`);
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(body)) {
    if (name.startsWith('__') || name.startsWith('@')) continue; // an item read earlier can be passed straight back: its wrappers are not sent
    if (!type) {
      out[name] = value;
      continue;
    }
    const property = type.properties.find((p) => p.name === name);
    if (!property) {
      if (type.navigation.includes(name)) {
        out[name] = value;
        continue;
      }
      throw new NodeOperationError(`"${name}" is not in this tenant's service`, { description: `The entity type ${type.name} has no property "${name}". Custom fields start with YY1_ and must be enabled for the API.` });
    }
    if (mode === 'update' && type.keys.includes(name)) throw new NodeOperationError(`"${name}" is a key and cannot be changed`);
    if (mode === 'update' && property.updatable === false) throw new NodeOperationError(`"${name}" cannot be updated (sap:updatable is false)`);
    if (mode === 'create' && property.creatable === false) throw new NodeOperationError(`"${name}" cannot be set on create (sap:creatable is false)`);
    out[name] = typeof value === 'string' && !keepSapDates && version === 'v2' && (property.type === 'Edm.DateTime' || property.type === 'Edm.DateTimeOffset') && !SAP_DATE.test(value) ? (toSapDate(value) ?? value) : value;
  }
  if (Object.keys(out).length === 0) throw new NodeOperationError('Nothing to send: every field was a wrapper property');
  return out as JsonObject;
}
