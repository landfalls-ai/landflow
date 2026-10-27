/**
 * File formats for Extract from File and Convert to File, without dependencies: CSV (RFC 4180, both ways), HTML
 * tables (both ways), and XLSX and ODS (both ways: a small ZIP reader and writer over node:zlib plus the few
 * SpreadsheetML / OpenDocument parts a sheet needs).
 * PDF text comes from unpdf, loaded lazily in nodes/files.ts.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
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
  return { name: sheet.name, rows: usedRange(rows), sheetNames: sheets.map((s) => s.name) };
}

/** Start at the first used row and column, as a sheet's used range does. */
function usedRange(rows: JsonValue[][]): JsonValue[][] {
  const used = (cell: JsonValue) => cell !== null && cell !== '';
  const first = rows.findIndex((row) => row.some(used));
  const left = Math.min(...rows.map((row) => row.findIndex(used)).filter((i) => i >= 0));
  return first < 0 ? [] : rows.slice(first).map((row) => row.slice(Number.isFinite(left) ? left : 0));
}

// ---------------------------------------------------------------------------
// ODS (OpenDocument spreadsheet, read)
// ---------------------------------------------------------------------------

/** The text of an ODS cell: its paragraphs, with `text:s`, `text:tab` and `text:line-break` expanded. */
function odsText(xml: string): string {
  const paragraphs = [...xml.matchAll(/<text:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/text:p>)/g)].map((m) =>
    decodeEntities(
      (m[1] ?? '')
        .replace(/<text:s(?:\s+text:c\s*=\s*"(\d+)")?\s*\/>/g, (_, n: string | undefined) => ' '.repeat(Math.min(Number(n ?? 1), 10_000)))
        .replace(/<text:tab\s*\/>/g, '\t')
        .replace(/<text:line-break\s*\/>/g, '\n')
        .replace(/<[^>]*>/g, ''),
    ),
  );
  return paragraphs.join('\n');
}

/** ODS dates are xsd:dateTime without a zone (read as UTC); show them as the XLSX reader does. */
function odsDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  const iso = parsed.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}

/** "PT10H30M05S" as "10:30:05". */
function odsTime(value: string): string {
  const m = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!m) return value;
  const two = (n: string | number | undefined) => String(Math.floor(Number(n ?? 0))).padStart(2, '0');
  return `${two(m[1])}:${two(m[2])}:${two(m[3])}`;
}

/** The sheet names of an ODS file and the cells of one sheet (numbers, booleans, strings, dates as ISO text). */
export function readOds(bytes: Uint8Array, options: { sheetName?: string } = {}): XlsxSheet & { sheetNames: string[] } {
  const zip = readZip(bytes);
  const content = zip.get('content.xml')?.().toString('utf8');
  if (!content) throw new Error('Not an ODS file (no content.xml)');
  const mime = zip.get('mimetype')?.().toString('utf8').trim();
  if (mime && mime !== 'application/vnd.oasis.opendocument.spreadsheet') throw new Error(`Not an ODS spreadsheet (${mime})`);
  const tables = [...content.matchAll(/<table:table\s([^>]*)>([\s\S]*?)<\/table:table>/g)].map((m) => ({ name: attr(`<t ${m[1]}>`, 'table:name') ?? '', xml: m[2] }));
  if (!tables.length) throw new Error('The file has no sheets');
  const wanted = options.sheetName?.trim();
  const table = wanted ? tables.find((t) => t.name === wanted) : tables[0];
  if (!table) throw new Error(`No sheet named “${wanted}”; the sheets are ${tables.map((t) => `“${t.name}”`).join(', ')}`);

  const rows: JsonValue[][] = [];
  let rowIndex = 0;
  for (const rowMatch of table.xml.matchAll(/<table:table-row(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
    const rowRepeat = Math.max(1, Number(attr(`<r${rowMatch[1]}>`, 'table:number-rows-repeated')) || 1);
    const row: JsonValue[] = [];
    let col = 0;
    for (const cell of (rowMatch[2] ?? '').matchAll(/<table:(?:covered-)?table-cell(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
      const tag = `<c${cell[1]}>`;
      const repeat = Math.max(1, Number(attr(tag, 'table:number-columns-repeated')) || 1);
      const type = attr(tag, 'office:value-type');
      let value: JsonValue = null;
      if (type === 'float' || type === 'percentage' || type === 'currency') value = Number(attr(tag, 'office:value') ?? NaN);
      else if (type === 'boolean') value = attr(tag, 'office:boolean-value') === 'true';
      else if (type === 'date') value = odsDate(attr(tag, 'office:date-value') ?? '');
      else if (type === 'time') value = odsTime(attr(tag, 'office:time-value') ?? '');
      else if (type === 'string') value = attr(tag, 'office:string-value') ?? odsText(cell[2] ?? '');
      if (typeof value === 'number' && !Number.isFinite(value)) value = odsText(cell[2] ?? '');
      if (value !== null) for (let n = 0; n < Math.min(repeat, 1000); n++) row[col + n] = value;
      col += repeat; // empty cells (often repeated to the sheet's edge) just advance
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    if (row.some((cell) => cell !== null)) for (let n = 0; n < Math.min(rowRepeat, 1000); n++) rows[rowIndex + n] = row;
    rowIndex += rowRepeat;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return { name: table.name, rows: usedRange(rows), sheetNames: tables.map((t) => t.name) };
}

// ---------------------------------------------------------------------------
// ZIP (write)
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** Store without compression (an ODS `mimetype` must be). */
  store?: boolean;
}

/** A ZIP archive of the entries, in order, deflated unless `store` is set. Entries stay under 4 GB (no ZIP64). */
export function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = entry.store ? undefined : deflateRawSync(entry.data);
    const method = deflated && deflated.length < entry.data.length ? 8 : 0;
    const body = method === 8 ? deflated! : entry.data;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // 00:00:00
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    local.copy(header, 6, 4, 30); // version needed .. name length are the same fields
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    parts.push(local, name, body);
    offset += 30 + name.length + body.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, end]);
}

// ---------------------------------------------------------------------------
// XLSX and ODS (write)
// ---------------------------------------------------------------------------

export interface SheetSpec {
  name: string;
  columns: string[];
  rows: JsonObject[];
}

export interface SheetOptions {
  /** The sheet's name when no field names it (default “Sheet1”). */
  sheetName?: string;
  /** A field (dot notation) whose value names each item's sheet; items with the same value share a sheet. */
  sheetNameField?: string;
  /** The columns, in order, comma separated (default: the keys of the items, the first item's first). */
  columns?: string;
}

const pathValue = (row: JsonObject, path: string): JsonValue | undefined => {
  if (path in row) return row[path];
  let current: JsonValue | undefined = row;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
};

/** A name every spreadsheet app accepts: no `[]:*?/\`, at most 31 characters, no edge apostrophes, not empty. */
export function sheetTitle(name: string, fallback = 'Sheet'): string {
  const clean = name.replace(/[[\]:*?/\\\u0000-\u001f]/g, ' ').trim().replace(/^'+|'+$/g, '').trim().slice(0, 31).trim();
  return clean || fallback;
}

/** The sheets for a set of items: one, or one per value of a field, with unique valid names and their columns. */
export function sheetsOf(rows: JsonObject[], options: SheetOptions = {}): SheetSpec[] {
  const base = sheetTitle(options.sheetName ?? '', 'Sheet1');
  const groups = new Map<string, JsonObject[]>();
  const field = options.sheetNameField?.trim();
  for (const row of rows) {
    const value = field ? pathValue(row, field) : undefined;
    const key = value === undefined || value === null || value === '' ? base : sheetTitle(cellText(value), base);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
  }
  if (!groups.size) groups.set(base, []);
  const given = (options.columns ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  const taken = new Set<string>();
  return [...groups].map(([wanted, group]) => {
    let name = wanted;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted.slice(0, 31 - String(n).length - 1)}_${n}`;
    taken.add(name.toLowerCase());
    return { name, columns: given.length ? given : columnsOf(group), rows: group };
  });
}

type Cell =
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'date'; serial: number; iso: string; dateOnly: boolean };

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** A cell for a value: numbers, booleans, ISO dates (when asked) and text; null and undefined are empty (no cell). */
function cellOf(value: JsonValue | undefined, dates: boolean): Cell | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? { kind: 'number', value } : { kind: 'string', value: String(value) };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (typeof value === 'string') {
    const m = dates ? DATE_TEXT.exec(value) : null;
    if (m) {
      const dateOnly = m[4] === undefined;
      const ms = Date.parse(dateOnly ? `${value}T00:00:00Z` : `${value.replace(' ', 'T')}${m[7] ? '' : 'Z'}`);
      const iso = Number.isNaN(ms) ? '' : new Date(ms).toISOString();
      // Real dates only (no February 30), after 1900-03-01 where Excel's calendar agrees with ours.
      if (iso && ms >= Date.UTC(1900, 2, 1) && (!dateOnly || iso.startsWith(value))) return { kind: 'date', serial: (ms - EXCEL_EPOCH) / 86_400_000, iso, dateOnly };
    }
    return { kind: 'string', value };
  }
  return { kind: 'string', value: JSON.stringify(value) };
}

/** The cells of a sheet: the header row (names as strings) when asked, then one row per item. */
function gridOf(sheet: SheetSpec, headerRow: boolean, dates: boolean): (Cell | null)[][] {
  const grid = sheet.rows.map((row) => sheet.columns.map((column) => cellOf(row[column], dates)));
  if (headerRow) grid.unshift(sheet.columns.map((column) => ({ kind: 'string', value: column }) as Cell));
  return grid;
}

/** XML text without the characters XML 1.0 forbids. */
const xmlText = (value: string) =>
  value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 0-based column index to letters: 0 → A, 26 → AA. */
function columnLetters(index: number): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAX_CELL_TEXT = 32_767; // what a spreadsheet cell holds

export interface WriteSheetOptions {
  /** A first row with the column names (default). */
  headerRow?: boolean;
  /** Write ISO date and date-time strings as date cells (default). */
  dates?: boolean;
}

/** An XLSX workbook, one sheet per entry: typed cells, inline strings, bold header row, date formats. */
export function toXlsx(sheets: SheetSpec[], options: WriteSheetOptions = {}): Buffer {
  const header = options.headerRow !== false;
  const dates = options.dates !== false;
  const sheetXml = sheets.map((sheet) => {
    const rows = gridOf(sheet, header, dates).map((cells, r) => {
      const out = cells.map((cell, c) => {
        if (!cell) return '';
        const ref = `r="${columnLetters(c)}${r + 1}"`;
        if (cell.kind === 'number') return `<c ${ref}><v>${cell.value}</v></c>`;
        if (cell.kind === 'boolean') return `<c ${ref} t="b"><v>${cell.value ? 1 : 0}</v></c>`;
        if (cell.kind === 'date') return `<c ${ref} s="${cell.dateOnly ? 1 : 2}"><v>${cell.serial}</v></c>`;
        const style = header && r === 0 ? ' s="3"' : '';
        return `<c ${ref} t="inlineStr"${style}><is><t xml:space="preserve">${xmlText(cell.value.slice(0, MAX_CELL_TEXT))}</t></is></c>`;
      });
      return `<row r="${r + 1}">${out.join('')}</row>`;
    });
    return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
  });
  const entry = (name: string, text: string): ZipEntry => ({ name, data: Buffer.from(text, 'utf8') });
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return writeZip([
    entry(
      '[Content_Types].xml',
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}</Types>`,
    ),
    entry('_rels/.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    entry(
      'xl/workbook.xml',
      `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${sheets
        .map((sheet, i) => `<sheet name="${xmlText(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ),
    entry(
      'xl/_rels/workbook.xml.rels',
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
    entry(
      'xl/styles.xml',
      `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    ),
    ...sheetXml.map((xml, i) => entry(`xl/worksheets/sheet${i + 1}.xml`, xml)),
  ]);
}

/** Text as ODS paragraphs: one per line, runs of spaces and tabs kept. */
function odsParagraphs(text: string): string {
  return xmlText(text.slice(0, MAX_CELL_TEXT))
    .split(/\r\n|\r|\n/)
    .map((line) => `<text:p>${line.replace(/\t/g, '<text:tab/>').replace(/^ +| {2,}| +$/g, (run) => `<text:s text:c="${run.length}"/>`)}</text:p>`)
    .join('');
}

/** An ODS spreadsheet, one table per sheet: typed cells, bold header row, date formats (`mimetype` stored first). */
export function toOds(sheets: SheetSpec[], options: WriteSheetOptions = {}): Buffer {
  const header = options.headerRow !== false;
  const dates = options.dates !== false;
  const tables = sheets.map((sheet) => {
    const rows = gridOf(sheet, header, dates).map((cells, r) => {
      const out = cells.map((cell) => {
        if (!cell) return '<table:table-cell/>';
        if (cell.kind === 'number') return `<table:table-cell office:value-type="float" office:value="${cell.value}"><text:p>${cell.value}</text:p></table:table-cell>`;
        if (cell.kind === 'boolean') return `<table:table-cell office:value-type="boolean" office:boolean-value="${cell.value}"><text:p>${cell.value ? 'TRUE' : 'FALSE'}</text:p></table:table-cell>`;
        if (cell.kind === 'date') {
          const value = cell.dateOnly ? cell.iso.slice(0, 10) : cell.iso.slice(0, 19);
          return `<table:table-cell table:style-name="${cell.dateOnly ? 'ceDate' : 'ceTime'}" office:value-type="date" office:date-value="${value}"><text:p>${value.replace('T', ' ')}</text:p></table:table-cell>`;
        }
        const style = header && r === 0 ? ' table:style-name="ceHead"' : '';
        return `<table:table-cell${style} office:value-type="string">${odsParagraphs(cell.value)}</table:table-cell>`;
      });
      return `<table:table-row>${out.join('')}</table:table-row>`;
    });
    return `<table:table table:name="${xmlText(sheet.name)}"><table:table-column table:number-columns-repeated="${Math.max(1, sheet.columns.length)}"/>${rows.join('')}</table:table>`;
  });
  const NS =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"';
  const styles =
    '<office:automatic-styles>' +
    '<number:date-style style:name="Ndate"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/></number:date-style>' +
    '<number:date-style style:name="Ntime"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/><number:text> </number:text><number:hours number:style="long"/><number:text>:</number:text><number:minutes number:style="long"/><number:text>:</number:text><number:seconds number:style="long"/></number:date-style>' +
    '<style:style style:name="ceDate" style:family="table-cell" style:data-style-name="Ndate"/>' +
    '<style:style style:name="ceTime" style:family="table-cell" style:data-style-name="Ntime"/>' +
    '<style:style style:name="ceHead" style:family="table-cell"><style:text-properties fo:font-weight="bold"/></style:style>' +
    '</office:automatic-styles>';
  const content = `${XML_HEAD}<office:document-content ${NS} office:version="1.2">${styles}<office:body><office:spreadsheet>${tables.join('')}</office:spreadsheet></office:body></office:document-content>`;
  const MIME = 'application/vnd.oasis.opendocument.spreadsheet';
  return writeZip([
    { name: 'mimetype', data: Buffer.from(MIME), store: true },
    { name: 'content.xml', data: Buffer.from(content, 'utf8') },
    {
      name: 'META-INF/manifest.xml',
      data: Buffer.from(
        `${XML_HEAD}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${MIME}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
      ),
    },
  ]);
}
