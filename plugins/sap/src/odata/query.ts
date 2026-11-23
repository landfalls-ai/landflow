/**
 * OData request building: keys, query options and service paths. Everything the node puts into a URL is built here from typed
 * values, never from a free string, so a model cannot smuggle a path (spec 3.2, 1.4).
 */
import { NodeOperationError } from '@landflow/sdk';

export type ODataVersion = 'v2' | 'v4';

export const MAX_QUERY_OPTION_LENGTH = 2000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/;

/** A V2 string literal: quotes doubled, the whole thing wrapped in single quotes. Percent-encoding happens when the URL is built. */
export const quoteString = (value: string) => `'${value.replace(/'/g, "''")}'`;

export type KeyValue = string | number | boolean;
export type KeyTypes = Record<string, string>; // property name -> Edm type

function literal(name: string, value: KeyValue, type: string | undefined, version: ODataVersion): string {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NodeOperationError(`Key "${name}" is not a finite number`);
    return String(value);
  }
  if (typeof value !== 'string') throw new NodeOperationError(`Key "${name}" must be a string, a number or a boolean`);
  if (type === 'Edm.Guid') {
    if (!/^[0-9a-fA-F-]{32,36}$/.test(value)) throw new NodeOperationError(`Key "${name}" is not a GUID`);
    return version === 'v4' ? value : `guid${quoteString(value)}`;
  }
  const numeric = type !== undefined && /^Edm\.(Int16|Int32|Int64|Byte|SByte|Double|Single|Decimal)$/.test(type);
  if (numeric) {
    if (!/^-?\d+(\.\d+)?$/.test(value)) throw new NodeOperationError(`Key "${name}" is not a number`);
    // V2 writes Int64 and Decimal with a suffix; leaving it off is accepted for the plain forms.
    return value;
  }
  if (version === 'v4' && type === 'Edm.Boolean') return value === 'true' ? 'true' : 'false';
  return quoteString(value);
}

/**
 * The key predicate of one entity: `('4500000001')` for one key, `(A='x',B=2)` for a composite one. Key names are checked, values
 * are typed by `$metadata` when it is known (a string otherwise), and nothing else reaches the URL.
 */
export function keyPredicate(keys: Record<string, unknown>, types: KeyTypes = {}, version: ODataVersion = 'v2'): string {
  const entries = Object.entries(keys ?? {});
  if (entries.length === 0) throw new NodeOperationError('Keys are empty', { description: 'Give the key properties of the entity, for example {"SalesOrder": "4500000001"}.' });
  if (entries.length > 8) throw new NodeOperationError('Too many keys');
  for (const [name] of entries) if (!NAME.test(name)) throw new NodeOperationError(`"${name}" is not a valid key property name`);
  const values = entries.map(([name, value]) => [name, literal(name, value as KeyValue, types[name], version)] as const);
  if (values.length === 1 && version === 'v2' && !types[values[0][0]]) return `(${values[0][1]})`;
  if (values.length === 1) return `(${values[0][1]})`;
  return `(${values.map(([name, value]) => `${name}=${value}`).join(',')})`;
}

/** Parses the key predicate of a V2 `__metadata.uri` (`...A_SalesOrder('4500000001')`) back into an object. */
export function parseKeyPredicate(uri: string): Record<string, string | number | boolean> | undefined {
  const end = uri.lastIndexOf(')');
  const open = uri.lastIndexOf('(', end);
  if (end < 0 || open < 0 || end !== uri.length - 1) {
    const q = uri.indexOf('?');
    if (q < 0) return undefined;
    return parseKeyPredicate(uri.slice(0, q));
  }
  const text = uri.slice(open + 1, end);
  const result: Record<string, string | number | boolean> = {};
  const parts: string[] = [];
  let depth = false;
  let current = '';
  for (const ch of text) {
    if (ch === "'") depth = !depth;
    if (ch === ',' && !depth) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  for (const part of parts) {
    const at = part.indexOf('=');
    const name = at >= 0 && !part.startsWith("'") ? part.slice(0, at) : 'key';
    const raw = at >= 0 && !part.startsWith("'") ? part.slice(at + 1) : part;
    const value = decodeURIComponent(raw);
    if (/^'.*'$/.test(value) || /^guid'.*'$/.test(value)) result[name] = value.replace(/^guid/, '').slice(1, -1).replace(/''/g, "'");
    else if (/^-?\d+(\.\d+)?$/.test(value)) result[name] = Number(value);
    else if (value === 'true' || value === 'false') result[name] = value === 'true';
    else result[name] = value;
  }
  return result;
}

export interface QueryOptions {
  filter?: string;
  select?: string;
  expand?: string;
  orderby?: string;
  top?: number;
  skip?: number;
  /** V2 `$inlinecount=allpages`, V4 `$count=true`. */
  count?: boolean;
}

const checkOption = (name: string, value: string): string => {
  const text = value.trim();
  if (text.length > MAX_QUERY_OPTION_LENGTH) throw new NodeOperationError(`${name} is longer than ${MAX_QUERY_OPTION_LENGTH} characters`);
  if (/[\u0000-\u001f]/.test(text)) throw new NodeOperationError(`${name} has control characters`);
  return text;
};

/** A comma list of property names (paths with `/` allowed); the result is the cleaned list. */
export function checkNameList(label: string, value: string): string {
  const names = value
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  for (const name of names) if (!PATH_NAME.test(name) && name !== '*') throw new NodeOperationError(`${label}: "${name}" is not a property name`);
  return names.join(',');
}

/** `$orderby` is `Name [asc|desc]` items. */
export function checkOrderBy(value: string): string {
  const items = value
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  for (const item of items) if (!/^[A-Za-z_][A-Za-z0-9_/]*( (asc|desc))?$/.test(item)) throw new NodeOperationError(`Order By: "${item}" must be a property name with optional asc or desc`);
  return items.join(',');
}

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The query string of a read. `$filter` goes through verbatim (SAP refuses what it does not accept), encoded; the other options are
 * checked. Spaces are `%20`, never `+`.
 */
export function buildQuery(options: QueryOptions, version: ODataVersion, extra: Record<string, string> = {}): string {
  const pairs: Array<[string, string]> = [];
  if (options.filter?.trim()) pairs.push(['$filter', checkOption('Filter', options.filter)]);
  if (options.select?.trim()) pairs.push(['$select', checkNameList('Select', options.select)]);
  if (options.expand?.trim()) pairs.push(['$expand', checkNameList('Expand', options.expand)]);
  if (options.orderby?.trim()) pairs.push(['$orderby', checkOrderBy(options.orderby)]);
  if (options.top !== undefined) pairs.push(['$top', String(Math.max(0, Math.floor(options.top)))]);
  if (options.skip) pairs.push(['$skip', String(Math.max(0, Math.floor(options.skip)))]);
  if (options.count) pairs.push(version === 'v4' ? ['$count', 'true'] : ['$inlinecount', 'allpages']);
  for (const [name, value] of Object.entries(extra)) pairs.push([name, value]);
  return pairs.map(([name, value]) => `${name}=${encode(value)}`).join('&');
}

/** A V2 `datetime'…'` literal, V4 plain ISO, for the poll trigger's cursor. */
export function dateTimeLiteral(iso: string, edmType: string | undefined, version: ODataVersion): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new NodeOperationError(`"${iso}" is not a date`);
  if (version === 'v4') return edmType === 'Edm.Date' ? date.toISOString().slice(0, 10) : date.toISOString();
  if (edmType === 'Edm.DateTimeOffset') return `datetimeoffset${quoteString(date.toISOString())}`;
  return `datetime${quoteString(date.toISOString().slice(0, 19))}`;
}

/** Only lowercase `v` in service version parameters: an uppercase `V` once resolved to an obsolete version (spec 1.4, KBA 3778784). */
export const lowerVersionParams = (path: string) => path.replace(/;V=/g, ';v=');

/**
 * A custom service path: starts with `/sap/`, no `..`, no scheme, no query or fragment, no backslash. Returns it without a trailing
 * slash.
 */
export function checkCustomPath(raw: string): string {
  const path = raw.trim();
  if (!path.startsWith('/sap/')) throw new NodeOperationError('A custom service path must start with /sap/', { description: 'For example /sap/opu/odata/sap/ZMY_SERVICE_SRV' });
  if (/[?#\\]|\.\.|:\/\/|%2e|%2f|%5c/i.test(path) || /[\u0000-\u001f ]/.test(path)) throw new NodeOperationError('The custom service path has characters that are not allowed');
  if (!/^[A-Za-z0-9_\-/.;=]+$/.test(path)) throw new NodeOperationError('The custom service path has characters that are not allowed');
  return lowerVersionParams(path.replace(/\/+$/, ''));
}

export function checkEntitySetName(name: string): string {
  const text = String(name ?? '').trim();
  if (!NAME.test(text)) throw new NodeOperationError(`"${text}" is not an entity set name`);
  return text;
}
