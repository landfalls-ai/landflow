/**
 * File formats for Extract from File and Convert to File, without dependencies: CSV (RFC 4180, both ways), HTML
 * tables (both ways), and XLSX reading (a ZIP reader over node:zlib plus the few SpreadsheetML parts a sheet needs).
 * PDF text comes from unpdf, loaded lazily in nodes/files.ts.
 */
import { inflateRawSync } from 'node:zlib';
import type { JsonObject, JsonValue } from '@landflow/protocol';

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export interface CsvReadOptions {
  delimiter?: string;
  /** Accept quotes inside unquoted fields and stray characters after a closing quote. */
  relaxQuotes?: boolean;
}

/** Parse CSV text into rows of strings. Handles quoted fields, doubled quotes, CRLF and a BOM. */
export function parseCsv(text: string, options: CsvReadOptions = {}): string[][] {
  const delimiter = options.delimiter || ',';
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '' && !wasQuoted) {
      quoted = wasQuoted = true;
    } else if (input.startsWith(delimiter, i)) {
      row.push(field);
      field = '';
      wasQuoted = false;
      i += delimiter.length - 1;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      wasQuoted = false;
    } else if (wasQuoted && !options.relaxQuotes) {
      throw new Error(`Invalid CSV: unexpected “${c}” after a closing quote on line ${rows.length + 1}`);
    } else if (c === '"' && !options.relaxQuotes) {
      throw new Error(`Invalid CSV: a quote inside an unquoted field on line ${rows.length + 1} (turn on “Relax Quotes” to allow it)`);
    } else field += c;
  }
  if (quoted) throw new Error('Invalid CSV: a quoted field is never closed');
  if (field !== '' || row.length || wasQuoted) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/** The columns of a set of rows, in order of first appearance. */
export function columnsOf(rows: JsonObject[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

/** CSV text for objects: one column per key (objects as JSON), quoting fields that need it. */
export function toCsv(rows: JsonObject[], options: { delimiter?: string; headerRow?: boolean } = {}): string {
  const delimiter = options.delimiter || ',';
  const columns = columnsOf(rows);
  const quote = (value: string) => (value.includes(delimiter) || /["\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = rows.map((row) => columns.map((column) => quote(cellText(row[column]))).join(delimiter));
  if (options.headerRow !== false) lines.unshift(columns.map(quote).join(delimiter));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// ---------------------------------------------------------------------------
// Rows to items (shared by CSV, XLSX and HTML tables)
// ---------------------------------------------------------------------------

export interface RowOptions {
  /** The first row names the columns (default); without it each item is `{ row: [...] }`. */
  headerRow?: boolean;
  /** Keep empty cells as '' (default: leave them out). */
  includeEmptyCells?: boolean;
  /** Skip this many rows first (counting the header). */
  fromLine?: number;
  /** At most this many items (-1 or unset: all). */
  maxRowCount?: number;
}

const isEmpty = (value: JsonValue | undefined) => value === undefined || value === null || value === '';

/** Items from table rows: keyed by the header row, or `{ row: [...] }`. Duplicate or empty headers get suffixes as SheetJS does. */
export function rowsToItems(rows: JsonValue[][], options: RowOptions = {}): JsonObject[] {
  let body = rows.slice(Math.max(0, Number(options.fromLine) || 0));
  const max = Number(options.maxRowCount);
  const take = (list: JsonObject[]) => (Number.isFinite(max) && max >= 0 ? list.slice(0, max) : list);
  if (options.headerRow === false) {
    return take(body.filter((row) => row.some((cell) => !isEmpty(cell))).map((row) => ({ row: options.includeEmptyCells ? row.map((cell) => cell ?? '') : row })));
  }
  const header = body[0] ?? [];
  body = body.slice(1);
  const width = Math.max(header.length, ...body.map((row) => row.length));
  const used = new Map<string, number>();
  const keys: string[] = [];
  for (let i = 0; i < width; i++) {
    const base = isEmpty(header[i]) ? '__EMPTY' : String(header[i]);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    keys.push(count ? `${base}_${count}` : base);
  }
  const items: JsonObject[] = [];
  for (const row of body) {
    if (!row.some((cell) => !isEmpty(cell))) continue;
    const item: JsonObject = {};
    keys.forEach((key, i) => {
      if (!isEmpty(row[i])) item[key] = row[i];
      else if (options.includeEmptyCells) item[key] = '';
    });
    items.push(item);
  }
  return take(items);
}

// ---------------------------------------------------------------------------
// HTML tables
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode HTML/XML character references. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1].toLowerCase() === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** The text of an HTML fragment: tags, scripts and styles removed, entities decoded, whitespace collapsed. */
export function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** The cells of each `<table>` in an HTML document (nested tables are read on their own). */
export function htmlTables(html: string): string[][][] {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  const tables: string[][][] = [];
  for (const match of clean.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    const rows: string[][] = [];
    for (const tr of match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/tbody|<\/thead|<\/tfoot|$)/gi)) {
      const cells = [...tr[1].matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)(?=<t[dh]\b|<\/tr|$)/gi)].flatMap((cell) => {
        const text = htmlText(cell[3].replace(/<\/t[dh]\s*>[\s\S]*$/i, ''));
        const span = Math.min(Number(/colspan\s*=\s*["']?(\d+)/i.exec(cell[2])?.[1] ?? 1) || 1, 1000);
        return [text, ...Array<string>(span - 1).fill('')];
      });
      if (cells.length) rows.push(cells);
    }
    tables.push(rows);
  }
  return tables;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** An HTML document with one table of the rows. */
export function toHtmlTable(rows: JsonObject[], options: { headerRow?: boolean; title?: string } = {}): string {
  const columns = columnsOf(rows);
  const head = options.headerRow === false ? '' : `<thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`;
  const body = rows.map((row) => `<tr>${columns.map((c) => `<td>${escapeHtml(cellText(row[c]))}</td>`).join('')}</tr>`).join('\n');
  const title = escapeHtml(options.title ?? 'Data');
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head><body>\n<table>${head}<tbody>\n${body}\n</tbody></table>\n</body></html>\n`;
}

// ---------------------------------------------------------------------------
// ZIP (read only)
// ---------------------------------------------------------------------------

/** The entries of a ZIP archive by name, inflated on demand. ZIP64 and encryption aren't supported. */
export function readZip(bytes: Uint8Array): Map<string, () => Buffer> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, () => Buffer>();
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    entries.set(name, () => {
      if (flags & 1) throw new Error(`“${name}” is encrypted`);
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`Corrupt ZIP entry “${name}”`);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`“${name}” uses an unsupported compression method (${method})`);
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// XLSX (read only)
// ---------------------------------------------------------------------------

const attr = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? decodeEntities(match[1] ?? match[2]) : undefined;
};

/** The text of a shared or inline string: its `<t>` runs, without phonetic hints. */
const richText = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map((m) => decodeEntities(m[1] ?? '')).join('');

/** Column letters to a 0-based index: A → 0, AA → 26. */
function columnIndex(ref: string): number {
  let index = 0;
  for (const c of ref.toUpperCase()) {
    const code = c.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Whether a number format code shows a date or time (letters outside quotes, brackets and escapes). */
const isDateFormat = (code: string) => /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) && !/^general$/i.test(code);

/** An Excel serial date as ISO text (1900 system; the 1904 system when the workbook says so). */
function serialToIso(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const iso = new Date(epoch + Math.round(serial * 86_400_000)).toISOString();
  if (serial < 1 && !date1904) return iso.slice(11, 19); // a time of day
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}

export interface XlsxSheet {
  name: string;
  rows: JsonValue[][];
}

export interface XlsxOptions {
  /** The sheet to read (default: the first). */
  sheetName?: string;
  /** Keep date cells as Excel serial numbers instead of ISO text. */
  rawData?: boolean;
}

/** The sheet names of a workbook and the cells of one sheet (numbers, booleans, strings, dates as ISO text). */
export function readXlsx(bytes: Uint8Array, options: XlsxOptions = {}): XlsxSheet & { sheetNames: string[] } {
  const zip = readZip(bytes);
  const text = (name: string) => zip.get(name)?.().toString('utf8');
  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new Error('Not an XLSX workbook (no xl/workbook.xml)');
  const rels = new Map<string, string>();
  for (const [tag] of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(([tag]) => ({ name: attr(tag, 'name') ?? '', path: rels.get(attr(tag, 'r:id') ?? '') }));
  if (!sheets.length) throw new Error('The workbook has no sheets');
  const wanted = options.sheetName?.trim();
  const sheet = wanted ? sheets.find((s) => s.name === wanted) : sheets[0];
  if (!sheet) throw new Error(`No sheet named “${wanted}”; the sheets are ${sheets.map((s) => `“${s.name}”`).join(', ')}`);
  const xml = sheet.path && text(sheet.path);
  if (!xml) throw new Error(`Sheet “${sheet.name}” is missing from the file`);

  const shared = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) => richText(m[1] ?? ''));
  const styles = text('xl/styles.xml') ?? '';
  const customFormats = new Map<number, string>();
  for (const [tag] of styles.matchAll(/<numFmt\b[^>]*>/g)) customFormats.set(Number(attr(tag, 'numFmtId')), attr(tag, 'formatCode') ?? '');
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const dateStyles = [...cellXfs.matchAll(/<xf\b[^>]*>/g)].map(([tag]) => {
    const id = Number(attr(tag, 'numFmtId') ?? 0);
    return BUILTIN_DATE_FORMATS.has(id) || (customFormats.has(id) && isDateFormat(customFormats.get(id)!));
  });
  const date1904 = /<workbookPr\b[^>]*\sdate1904\s*=\s*["'](1|true)["']/.test(workbook);

  const rows: JsonValue[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attr(rowMatch[0], 'r')) || rows.length + 1;
    const row: JsonValue[] = [];
    let next = 0;
    for (const cell of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = `<c${cell[1]}>`;
      const ref = attr(tag, 'r');
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const inner = cell[2] ?? '';
      const type = attr(tag, 't') ?? 'n';
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value: JsonValue = null;
      if (type === 'inlineStr') value = richText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
      else if (raw === undefined) value = null;
      else if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'b') value = raw.trim() === '1';
      else if (type === 'str' || type === 'e') value = decodeEntities(raw);
      else if (type === 'd') value = decodeEntities(raw);
      else {
        const number = Number(raw);
        const style = Number(attr(tag, 's') ?? 0);
        value = !Number.isFinite(number) ? decodeEntities(raw) : !options.rawData && dateStyles[style] ? serialToIso(number, date1904) : number;
      }
      row[col] = value;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    rows[rowNumber - 1] = row;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  // Start at the first used row and column, as the sheet's used range does.
  const used = (cell: JsonValue) => cell !== null && cell !== '';
  const first = rows.findIndex((row) => row.some(used));
  const left = Math.min(...rows.map((row) => row.findIndex(used)).filter((i) => i >= 0));
  const trimmed = first < 0 ? [] : rows.slice(first).map((row) => row.slice(Number.isFinite(left) ? left : 0));
  return { name: sheet.name, rows: trimmed, sheetNames: sheets.map((s) => s.name) };
}
