/**
 * The file nodes, with n8n's names and parameters: Read/Write Files from Disk (only inside LANDFLOW_FILES_DIR,
 * default `<data dir>/files`), Extract from File (CSV, HTML tables, JSON, PDF text, text, XLSX, ODS, or the file as a
 * base64 string) and Convert to File (CSV, HTML table, XLSX, ODS, JSON, text, or a base64 string as a file). Files travel as
 * `item.binary.<property>` refs; the bytes stay in the binary store.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, opendir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { defineNode, NodeOperationError, type JsonObject, type JsonValue, type NodeItem, type PropertyDescriptor } from '@landflow/sdk';
import { extensionFromMimeType, mimeTypeFromFileName, type BinaryRef } from '@landflow/protocol';
import { htmlTables, parseCsv, readOds, readXlsx, rowsToItems, sheetsOf, toCsv, toHtmlTable, toOds, toXlsx, type RowOptions } from '../binary/formats';
import { dataDir } from '../db';
import { getPath } from './paths';

const main = [{ type: 'main' as const }];
const FILES = { kind: 'action' as const, version: 1, categories: ['Data'], color: '#0ea5e9', inputs: main, outputs: main };

// ---------------------------------------------------------------------------
// The files directory
// ---------------------------------------------------------------------------

/** Where Read/Write Files from Disk may read and write: LANDFLOW_FILES_DIR, default `<data dir>/files`. */
export function filesDir(): string {
  return resolve(/*turbopackIgnore: true*/ process.env.LANDFLOW_FILES_DIR?.trim() || join(dataDir(), 'files'));
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

/** The real path of the files directory (created on first use). */
async function realRoot(): Promise<string> {
  const root = filesDir();
  await mkdir(root, { recursive: true });
  return realpath(/*turbopackIgnore: true*/ root);
}

/**
 * A path the user typed, resolved inside the files directory: relative paths are under it, absolute ones must
 * point into it, and symlinks can't lead out of it.
 */
export async function resolveInFilesDir(input: string, itemIndex?: number): Promise<{ root: string; path: string }> {
  const root = await realRoot();
  const raw = String(input ?? '').trim();
  if (!raw || raw.includes('\0')) throw new NodeOperationError('Set a file path', { itemIndex });
  const configured = filesDir();
  // An absolute path may name the configured directory or its real path.
  const base = isAbsolute(raw) && inside(configured, resolve(raw)) ? configured : root;
  const path = isAbsolute(raw) ? resolve(root, relative(base, resolve(raw))) : resolve(root, raw);
  if (!inside(root, path)) throw outside(raw, itemIndex);
  // Follow symlinks in the part that exists.
  let existing = path;
  for (;;) {
    try {
      const real = await realpath(existing);
      if (!inside(root, real)) throw outside(raw, itemIndex);
      break;
    } catch (error) {
      if (error instanceof NodeOperationError) throw error;
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  return { root, path };
}

const outside = (path: string, itemIndex?: number) =>
  new NodeOperationError(`“${path}” is outside the files directory`, { itemIndex, description: `Files can only be read and written under ${filesDir()} (LANDFLOW_FILES_DIR).` });

const GLOB = /[*?{[]/;

/** A glob (`*`, `**`, `?`, `{a,b}`, `[abc]`) as a regular expression over `/`-separated relative paths. */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) out += '\\{';
      else {
        out += `(?:${pattern
          .slice(i + 1, end)
          .split(',')
          .map((part) => part.replace(/[.+^$()|\\[\]]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
          .join('|')})`;
        i = end;
      }
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) out += '\\[';
      else {
        out += `[${pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else out += c.replace(/[.+^$()|\\\]}]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

const MAX_MATCHES = 10_000;

/** The files a selector names: one path, or every file a glob matches (sorted). */
async function selectFiles(selector: string, itemIndex: number): Promise<{ root: string; files: string[] }> {
  const pattern = selector.trim().replace(/\\/g, '/');
  if (!GLOB.test(pattern)) {
    const { root, path } = await resolveInFilesDir(pattern, itemIndex);
    const info = await stat(path).catch(() => undefined);
    if (!info) throw new NodeOperationError(`No file at “${selector}”`, { itemIndex, description: `Paths are relative to ${filesDir()}.` });
    if (!info.isFile()) throw new NodeOperationError(`“${selector}” is a directory`, { itemIndex, description: 'Use a pattern such as “folder/*” to read the files in it.' });
    return { root, files: [path] };
  }
  // Walk from the part before the first wildcard.
  const segments = pattern.split('/');
  const fixed = segments.slice(0, segments.findIndex((s) => GLOB.test(s)));
  const { root, path: start } = await resolveInFilesDir(fixed.length ? fixed.join('/') : '.', itemIndex);
  const absolute = isAbsolute(pattern);
  const relPattern = absolute ? relative(root, resolve(root, relative(filesDir(), pattern))).split(sep).join('/') : pattern.replace(/^\.\//, '');
  const regex = globToRegExp(relPattern);
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const handle = await opendir(dir).catch(() => undefined);
    if (!handle) return;
    for await (const entry of handle) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && regex.test(relative(root, full).split(sep).join('/'))) {
        files.push(full);
        if (files.length > MAX_MATCHES) throw new NodeOperationError(`“${selector}” matches more than ${MAX_MATCHES} files`, { itemIndex });
      }
    }
  };
  await walk(start);
  return { root, files: files.sort() };
}

// ---------------------------------------------------------------------------
// Read/Write Files from Disk
// ---------------------------------------------------------------------------

export const readWriteFileNode = defineNode({
  description: {
    ...FILES,
    name: 'readWriteFile',
    displayName: 'Read/Write Files from Disk',
    description: 'Read files from, or write files to, the files directory of the Landflow server',
    icon: 'lucide:hard-drive',
    subtitle: '{{operation}}',
    keywords: ['file', 'disk', 'read', 'write', 'save', 'load', 'filesystem', 'binary'],
    properties: [
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'read',
        noDataExpression: true,
        options: [
          { name: 'Read File(s) From Disk', value: 'read', description: 'One item per file, with the file in binary.data' },
          { name: 'Write File to Disk', value: 'write', description: 'Save an item’s file' },
        ],
      },
      {
        name: 'fileSelector',
        displayName: 'File(s) Selector',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'e.g. reports/*.csv',
        description: 'A path or a glob (*, **, ?, {a,b}) relative to the files directory',
        displayOptions: { show: { operation: ['read'] } },
      },
      {
        name: 'fileName',
        displayName: 'File Path and Name',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'e.g. exports/report.pdf',
        description: 'Relative to the files directory; folders are created as needed',
        displayOptions: { show: { operation: ['write'] } },
      },
      {
        name: 'dataPropertyName',
        displayName: 'Input Binary Field',
        type: 'string',
        default: 'data',
        required: true,
        description: 'The item file to write',
        displayOptions: { show: { operation: ['write'] } },
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { operation: ['read'] } },
        values: [
          { name: 'fileExtension', displayName: 'File Extension', type: 'string', default: '', description: 'Use this extension instead of the file’s' },
          { name: 'fileName', displayName: 'File Name', type: 'string', default: '', description: 'Use this name instead of the file’s' },
          { name: 'mimeType', displayName: 'MIME Type', type: 'string', default: '', description: 'Use this type instead of the one guessed from the name' },
          { name: 'dataPropertyName', displayName: 'Put Output File in Field', type: 'string', default: 'data' },
        ],
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { operation: ['write'] } },
        values: [{ name: 'append', displayName: 'Append', type: 'boolean', default: false, description: 'Add to the end of an existing file instead of replacing it' }],
      },
      {
        name: 'notice',
        displayName: 'Paths are relative to the files directory (LANDFLOW_FILES_DIR, default <data dir>/files); nothing outside it can be read or written.',
        type: 'notice',
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const operation = ctx.getNodeParameter<string>('operation', 0);
    const out: NodeItem[] = [];
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      if (operation === 'write') {
        const property = String(ctx.getNodeParameter('dataPropertyName', i, 'data') || 'data').trim();
        ctx.helpers.assertBinaryData(i, property);
        const { root, path } = await resolveInFilesDir(String(ctx.getNodeParameter('fileName', i) ?? ''), i);
        const append = ctx.getNodeParameter<{ append?: boolean }>('options', i)?.append === true;
        await mkdir(dirname(path), { recursive: true });
        // The folders just made could be symlinks planted meanwhile: check again before opening.
        if (!inside(root, await realpath(dirname(path)))) throw outside(path, i);
        const source = Readable.fromWeb((await ctx.helpers.getBinaryStream(i, property)) as never);
        await pipeline(source, createWriteStream(path, { flags: append ? 'a' : 'w' }));
        const item = items[i] ?? { json: {} };
        out.push({ ...item, json: { ...item.json, fileName: relative(root, path).split(sep).join('/') }, pairedItem: { item: i } });
        continue;
      }
      const options = ctx.getNodeParameter<{ fileExtension?: string; fileName?: string; mimeType?: string; dataPropertyName?: string }>('options', i) ?? {};
      const { root, files } = await selectFiles(String(ctx.getNodeParameter('fileSelector', i) ?? ''), i);
      for (const file of files) {
        const relativePath = relative(root, file).split(sep).join('/');
        const fileName = options.fileName?.trim() || relativePath.split('/').pop()!;
        const mimeType = options.mimeType?.trim() || mimeTypeFromFileName(fileName);
        const ref = await ctx.helpers.prepareBinaryData(createReadStream(file), fileName, mimeType);
        const binary: BinaryRef = { ...ref, ...(options.fileExtension?.trim() && { fileExtension: options.fileExtension.trim().replace(/^\./, '') }) };
        const directory = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
        out.push({
          json: { fileName, filePath: relativePath, directory, mimeType: binary.mimeType, fileSize: binary.fileSize },
          binary: { [options.dataPropertyName?.trim() || 'data']: binary },
          pairedItem: { item: i },
        });
      }
    }
    return [out];
  },
});

// ---------------------------------------------------------------------------
// Extract from File
// ---------------------------------------------------------------------------

const ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'latin1', 'windows-1252', 'iso-8859-2', 'shift_jis', 'gbk', 'big5', 'euc-kr'];
const encodingProperty = (name = 'encoding'): PropertyDescriptor => ({
  name,
  displayName: 'Encoding',
  type: 'options',
  default: 'utf-8',
  options: ENCODINGS.map((value) => ({ name: value, value })),
});

/** Text from bytes in an encoding the runtime knows (a BOM wins). */
function decodeText(bytes: Uint8Array, encoding = 'utf-8', itemIndex?: number): string {
  try {
    return new TextDecoder(encoding || 'utf-8').decode(bytes);
  } catch (error) {
    throw new NodeOperationError(`Can’t decode the file as ${encoding}`, { itemIndex, description: (error as Error).message });
  }
}

const SPREADSHEET = ['csv', 'html', 'xlsx', 'ods'];

type ExtractOptions = RowOptions & {
  delimiter?: string;
  relaxQuotes?: boolean;
  encoding?: string;
  sheetName?: string;
  rawData?: boolean;
  joinPages?: boolean;
  maxPages?: number;
  password?: string;
  keepSource?: 'json' | 'binary' | 'both';
};

/** PDF text with unpdf (pdf.js, pure JavaScript), loaded on first use. */
async function pdfText(bytes: Uint8Array, options: ExtractOptions, itemIndex: number): Promise<JsonObject> {
  const { getDocumentProxy } = await import('unpdf');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js takes ownership of the buffer it's given.
    pdf = await getDocumentProxy(new Uint8Array(bytes), { ...(options.password && { password: options.password }) });
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    throw new NodeOperationError(/password/i.test(message) ? 'The PDF is password protected' : 'Can’t read the PDF', {
      itemIndex,
      description: /password/i.test(message) ? 'Set “Password” in the options.' : message,
    });
  }
  try {
    const max = Number(options.maxPages) > 0 ? Math.min(Number(options.maxPages), pdf.numPages) : pdf.numPages;
    const pages: string[] = [];
    for (let n = 1; n <= max; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      pages.push(
        content.items
          .map((entry) => ('str' in entry ? `${entry.str}${entry.hasEOL ? '\n' : ''}` : ''))
          .join('')
          .trim(),
      );
    }
    const { info } = await pdf.getMetadata().catch(() => ({ info: {} }));
    return {
      numpages: pdf.numPages,
      numrender: max,
      info: JSON.parse(JSON.stringify(info ?? {})) as JsonObject,
      text: options.joinPages === false ? pages : pages.join('\n\n'),
    };
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}

export const extractFromFileNode = defineNode({
  description: {
    ...FILES,
    name: 'extractFromFile',
    displayName: 'Extract from File',
    description: 'Turn a file into items: CSV, XLSX, ODS and HTML table rows, JSON, PDF or plain text',
    icon: 'lucide:file-output',
    subtitle: '{{operation}}',
    keywords: ['extract', 'parse', 'csv', 'xlsx', 'ods', 'openoffice', 'libreoffice', 'excel', 'spreadsheet', 'pdf', 'json', 'text', 'html', 'table', 'base64', 'file'],
    properties: [
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'csv',
        noDataExpression: true,
        options: [
          { name: 'Extract From CSV', value: 'csv', description: 'One item per row' },
          { name: 'Extract From HTML', value: 'html', description: 'The rows of a table in an HTML file' },
          { name: 'Extract From JSON', value: 'fromJson', description: 'The parsed JSON in one field' },
          { name: 'Extract From PDF', value: 'pdf', description: 'The text of a PDF (no OCR for scanned pages)' },
          { name: 'Extract From Text File', value: 'text', description: 'The text in one field' },
          { name: 'Extract From ODS', value: 'ods', description: 'One item per row of an OpenDocument sheet' },
          { name: 'Extract From XLSX', value: 'xlsx', description: 'One item per row of a sheet' },
          { name: 'Move File to Base64 String', value: 'binaryToPropery', description: 'The file as a base64 string in one field' },
        ],
      },
      { name: 'binaryPropertyName', displayName: 'Input Binary Field', type: 'string', default: 'data', required: true, description: 'The item file to read' },
      {
        name: 'destinationKey',
        displayName: 'Destination Output Field',
        type: 'string',
        default: 'data',
        required: true,
        displayOptions: { show: { operation: ['fromJson', 'text', 'binaryToPropery'] } },
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'delimiter', displayName: 'Delimiter', type: 'string', default: ',', placeholder: 'e.g. ; or \\t', displayOptions: { show: { '/operation': ['csv'] } } },
          { name: 'headerRow', displayName: 'Header Row', type: 'boolean', default: true, description: 'The first row names the fields; off: each item is { row: [...] }', displayOptions: { show: { '/operation': SPREADSHEET } } },
          { name: 'includeEmptyCells', displayName: 'Include Empty Cells', type: 'boolean', default: false, displayOptions: { show: { '/operation': SPREADSHEET } } },
          { name: 'fromLine', displayName: 'Start on Row', type: 'number', default: 0, description: 'Rows to skip first (0: none)', displayOptions: { show: { '/operation': SPREADSHEET } } },
          { name: 'maxRowCount', displayName: 'Max Number of Rows to Load', type: 'number', default: -1, description: '-1: all', displayOptions: { show: { '/operation': SPREADSHEET } } },
          { name: 'relaxQuotes', displayName: 'Relax Quotes', type: 'boolean', default: false, description: 'Accept stray quotes in unquoted fields', displayOptions: { show: { '/operation': ['csv'] } } },
          { ...encodingProperty(), displayOptions: { show: { '/operation': ['csv', 'html', 'fromJson', 'text'] } } },
          { name: 'sheetName', displayName: 'Sheet Name', type: 'string', default: '', description: 'Default: the first sheet', displayOptions: { show: { '/operation': ['xlsx', 'ods'] } } },
          { name: 'rawData', displayName: 'Raw Data', type: 'boolean', default: false, description: 'Keep dates as Excel serial numbers', displayOptions: { show: { '/operation': ['xlsx'] } } },
          { name: 'joinPages', displayName: 'Join Pages', type: 'boolean', default: true, description: 'One text for the whole document; off: one entry per page', displayOptions: { show: { '/operation': ['pdf'] } } },
          { name: 'maxPages', displayName: 'Max Pages', type: 'number', default: 0, description: '0: all', displayOptions: { show: { '/operation': ['pdf'] } } },
          { name: 'password', displayName: 'Password', type: 'string', default: '', typeOptions: { password: true }, displayOptions: { show: { '/operation': ['pdf'] } } },
          {
            name: 'keepSource',
            displayName: 'Keep Source',
            type: 'options',
            default: 'json',
            description: 'What of the input item to keep (text, JSON, PDF and base64 operations)',
            options: [
              { name: 'JSON', value: 'json' },
              { name: 'Binary', value: 'binary' },
              { name: 'Both', value: 'both' },
            ],
            displayOptions: { show: { '/operation': ['fromJson', 'text', 'pdf', 'binaryToPropery'] } },
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const operation = ctx.getNodeParameter<string>('operation', 0);
    const out: NodeItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data').trim();
      const options = ctx.getNodeParameter<ExtractOptions>('options', i) ?? {};
      const ref = ctx.helpers.assertBinaryData(i, property);
      const bytes = await ctx.helpers.getBinaryDataBuffer(i, property);
      const fail = (message: string, error: unknown) => new NodeOperationError(message, { itemIndex: i, description: (error as Error)?.message ?? String(error) });

      if (SPREADSHEET.includes(operation)) {
        let rows: JsonValue[][];
        try {
          if (operation === 'xlsx') rows = readXlsx(bytes, options).rows;
          else if (operation === 'ods') rows = readOds(bytes, options).rows;
          else if (operation === 'csv') rows = parseCsv(decodeText(bytes, options.encoding, i), { delimiter: options.delimiter?.replace(/\\t/g, '\t'), relaxQuotes: options.relaxQuotes });
          else {
            const tables = htmlTables(decodeText(bytes, options.encoding, i));
            if (!tables.length) throw new Error('The file has no <table>');
            rows = tables[0];
          }
        } catch (error) {
          if (error instanceof NodeOperationError) throw error;
          throw fail(`Can’t read ${ref.fileName ?? 'the file'} as ${operation.toUpperCase()}`, error);
        }
        for (const json of rowsToItems(rows, options)) out.push({ json, pairedItem: { item: i } });
        continue;
      }

      const keep = options.keepSource;
      const base: NodeItem = {
        json: keep === 'json' || keep === 'both' ? { ...item.json } : {},
        ...((keep === 'binary' || keep === 'both') && item.binary && { binary: item.binary }),
        pairedItem: { item: i },
      };
      const destination = String(ctx.getNodeParameter('destinationKey', i, 'data') || 'data').trim();
      if (operation === 'pdf') {
        base.json = { ...base.json, ...(await pdfText(bytes, options, i)) };
      } else if (operation === 'binaryToPropery') {
        base.json[destination] = bytes.toString('base64');
      } else if (operation === 'fromJson') {
        const text = decodeText(bytes, options.encoding, i).replace(/^﻿/, '');
        try {
          base.json[destination] = JSON.parse(text) as JsonValue;
        } catch (error) {
          throw fail(`${ref.fileName ?? 'The file'} isn’t valid JSON`, error);
        }
      } else if (operation === 'text') {
        base.json[destination] = decodeText(bytes, options.encoding, i);
      } else throw new NodeOperationError(`Unknown operation “${operation}”`);
      out.push(base);
    }
    return [out];
  },
});

// ---------------------------------------------------------------------------
// Convert to File
// ---------------------------------------------------------------------------

const WRITE_ENCODINGS: Array<{ name: string; value: BufferEncoding }> = [
  { name: 'utf-8', value: 'utf8' },
  { name: 'utf-16le', value: 'utf16le' },
  { name: 'latin1', value: 'latin1' },
  { name: 'ascii', value: 'ascii' },
];

const BOMS: Partial<Record<BufferEncoding, number[]>> = { utf8: [0xef, 0xbb, 0xbf], utf16le: [0xff, 0xfe] };

/** Text as bytes in an encoding, with its byte order mark when asked. */
function encodeText(text: string, encoding: BufferEncoding = 'utf8', addBOM = false): Buffer {
  const body = Buffer.from(text, WRITE_ENCODINGS.some((e) => e.value === encoding) ? encoding : 'utf8');
  return addBOM && BOMS[encoding] ? Buffer.concat([Buffer.from(BOMS[encoding]!), body]) : body;
}

type ConvertOptions = {
  fileName?: string;
  delimiter?: string;
  headerRow?: boolean;
  format?: boolean;
  encoding?: BufferEncoding;
  addBOM?: boolean;
  mimeType?: string;
  dataIsBase64?: boolean;
  columns?: string;
  sheetName?: string;
  sheetNameField?: string;
  dates?: boolean;
};

const ALL_ITEMS = ['csv', 'html', 'xlsx', 'ods'];
const SPREADSHEET_MIME: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

/** The bytes of a base64 string; a `data:` URI also gives its type. */
function base64Bytes(value: string): { bytes: Buffer; mimeType?: string } {
  const uri = /^data:([^;,]*)(?:;[^,]*)?;base64,/i.exec(value.trim());
  const body = (uri ? value.trim().slice(uri[0].length) : value).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(body)) throw new Error('The value isn’t base64');
  return { bytes: Buffer.from(body, 'base64'), ...(uri?.[1] && { mimeType: uri[1] }) };
}

export const convertToFileNode = defineNode({
  description: {
    ...FILES,
    name: 'convertToFile',
    displayName: 'Convert to File',
    description: 'Turn items into a file: CSV, XLSX, ODS, HTML table, JSON, text, or a base64 string as a file',
    icon: 'lucide:file-input',
    subtitle: '{{operation}}',
    keywords: ['convert', 'file', 'csv', 'xlsx', 'ods', 'excel', 'spreadsheet', 'json', 'text', 'html', 'base64', 'export', 'download', 'binary'],
    properties: [
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'csv',
        noDataExpression: true,
        options: [
          { name: 'Convert to CSV', value: 'csv', description: 'All items as the rows of one CSV file' },
          { name: 'Convert to HTML', value: 'html', description: 'All items as the rows of an HTML table' },
          { name: 'Convert to ODS', value: 'ods', description: 'All items as the rows of an OpenDocument spreadsheet' },
          { name: 'Convert to XLSX', value: 'xlsx', description: 'All items as the rows of an Excel workbook' },
          { name: 'Convert to JSON', value: 'toJson', description: 'Items as a JSON file' },
          { name: 'Convert to Text File', value: 'toText', description: 'A field’s text as a file, per item' },
          { name: 'Move Base64 String to File', value: 'toBinary', description: 'A field’s base64 string (or data: URI) as a file, per item' },
        ],
      },
      {
        name: 'mode',
        displayName: 'Mode',
        type: 'options',
        default: 'once',
        noDataExpression: true,
        displayOptions: { show: { operation: ['toJson'] } },
        options: [
          { name: 'All Items to One File', value: 'once', description: 'A JSON array of the items' },
          { name: 'Each Item to Separate File', value: 'each' },
        ],
      },
      {
        name: 'sourceProperty',
        displayName: 'Source Field',
        type: 'string',
        default: 'data',
        required: true,
        placeholder: 'e.g. data or content.text',
        description: 'The field with the text or base64 data (dot notation reaches into objects)',
        displayOptions: { show: { operation: ['toText', 'toBinary'] } },
      },
      { name: 'binaryPropertyName', displayName: 'Put Output File in Field', type: 'string', default: 'data', required: true },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'fileName', displayName: 'File Name', type: 'string', default: '', placeholder: 'e.g. report.csv' },
          { name: 'delimiter', displayName: 'Delimiter', type: 'string', default: ',', displayOptions: { show: { '/operation': ['csv'] } } },
          { name: 'headerRow', displayName: 'Header Row', type: 'boolean', default: true, displayOptions: { show: { '/operation': ALL_ITEMS } } },
          { name: 'columns', displayName: 'Columns', type: 'string', default: '', placeholder: 'e.g. name, email, created', description: 'The columns in this order, comma separated. Default: the keys of the items, the first item’s first', displayOptions: { show: { '/operation': ['xlsx', 'ods'] } } },
          { name: 'sheetName', displayName: 'Sheet Name', type: 'string', default: 'Sheet1', description: 'Also names the items that have no value in “Sheet Name From Field”', displayOptions: { show: { '/operation': ['xlsx', 'ods'] } } },
          {
            name: 'sheetNameField',
            displayName: 'Sheet Name From Field',
            type: 'string',
            default: '',
            placeholder: 'e.g. region or customer.country',
            description: 'One sheet per value of this field (dot notation reaches into objects), in order of first appearance',
            displayOptions: { show: { '/operation': ['xlsx', 'ods'] } },
          },
          { name: 'dates', displayName: 'Dates as Date Cells', type: 'boolean', default: true, description: 'Write ISO dates and date-times (2024-01-20, 2024-01-20T10:30:00Z) as spreadsheet dates, not text', displayOptions: { show: { '/operation': ['xlsx', 'ods'] } } },
          { name: 'format', displayName: 'Pretty Print', type: 'boolean', default: false, displayOptions: { show: { '/operation': ['toJson'] } } },
          {
            name: 'encoding',
            displayName: 'Encoding',
            type: 'options',
            default: 'utf8',
            options: WRITE_ENCODINGS,
            displayOptions: { show: { '/operation': ['csv', 'html', 'toJson', 'toText'] } },
          },
          { name: 'addBOM', displayName: 'Add Byte Order Mark (BOM)', type: 'boolean', default: false, description: 'Helps Excel open UTF-8 CSV', displayOptions: { show: { '/operation': ['csv', 'toJson', 'toText'] } } },
          { name: 'mimeType', displayName: 'MIME Type', type: 'string', default: '', placeholder: 'e.g. image/png', description: 'Default: from a data: URI or the file name', displayOptions: { show: { '/operation': ['toBinary'] } } },
          { name: 'dataIsBase64', displayName: 'Data Is Base64', type: 'boolean', default: true, description: 'Off: write the field’s text as it is', displayOptions: { show: { '/operation': ['toBinary'] } } },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const operation = ctx.getNodeParameter<string>('operation', 0);
    const output = (i: number) => String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data').trim();
    const optionsOf = (i: number) => ctx.getNodeParameter<ConvertOptions>('options', i) ?? {};
    const prepare = (bytes: Buffer, fileName: string, mimeType?: string) => ctx.helpers.prepareBinaryData(bytes, fileName, mimeType || mimeTypeFromFileName(fileName));

    if (ALL_ITEMS.includes(operation) || (operation === 'toJson' && ctx.getNodeParameter<string>('mode', 0, 'once') !== 'each')) {
      const options = optionsOf(0);
      const rows = items.map((item) => item.json);
      if (operation === 'xlsx' || operation === 'ods') {
        const sheets = sheetsOf(rows, options);
        const write = operation === 'xlsx' ? toXlsx : toOds;
        const fileName = options.fileName?.trim() || `data.${operation}`;
        const ref = await prepare(write(sheets, { headerRow: options.headerRow, dates: options.dates }), fileName, SPREADSHEET_MIME[operation]);
        return [[{ json: {}, binary: { [output(0)]: ref }, pairedItem: { item: 0 } }]];
      }
      let text: string;
      let fallbackName: string;
      if (operation === 'csv') {
        text = toCsv(rows, { delimiter: options.delimiter?.replace(/\\t/g, '\t'), headerRow: options.headerRow });
        fallbackName = 'data.csv';
      } else if (operation === 'html') {
        text = toHtmlTable(rows, { headerRow: options.headerRow });
        fallbackName = 'data.html';
      } else {
        text = JSON.stringify(rows, null, options.format ? 2 : undefined);
        fallbackName = 'data.json';
      }
      const fileName = options.fileName?.trim() || fallbackName;
      const ref = await prepare(encodeText(text, options.encoding, options.addBOM), fileName);
      const file: NodeItem = { json: {}, binary: { [output(0)]: ref }, pairedItem: { item: 0 } };
      return [[file]];
    }

    const out: NodeItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const options = optionsOf(i);
      let ref: BinaryRef;
      if (operation === 'toJson') {
        const fileName = options.fileName?.trim() || 'data.json';
        ref = await prepare(encodeText(JSON.stringify(item.json, null, options.format ? 2 : undefined), options.encoding, options.addBOM), fileName);
      } else if (operation === 'toText' || operation === 'toBinary') {
        const source = String(ctx.getNodeParameter('sourceProperty', i, 'data') || 'data').trim();
        const value = getPath(item.json, source);
        if (value === undefined) throw new NodeOperationError(`Item ${i} has no field “${source}”`, { itemIndex: i });
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        if (operation === 'toText') {
          ref = await prepare(encodeText(text, options.encoding, options.addBOM), options.fileName?.trim() || 'file.txt');
        } else if (options.dataIsBase64 === false) {
          const fileName = options.fileName?.trim() || 'file';
          ref = await prepare(Buffer.from(text, 'utf8'), fileName, options.mimeType?.trim());
        } else {
          let decoded: { bytes: Buffer; mimeType?: string };
          try {
            decoded = base64Bytes(text);
          } catch (error) {
            throw new NodeOperationError(`“${source}” of item ${i} isn’t base64`, { itemIndex: i, description: (error as Error).message });
          }
          const mimeType = options.mimeType?.trim() || decoded.mimeType;
          const fileName = options.fileName?.trim() || (mimeType ? `file.${extensionFromMimeType(mimeType) ?? 'bin'}` : 'file');
          ref = await prepare(decoded.bytes, fileName, mimeType);
        }
      } else throw new NodeOperationError(`Unknown operation “${operation}”`);
      out.push({ json: { ...item.json }, binary: { ...item.binary, [output(i)]: ref }, pairedItem: { item: i } });
    }
    return [out];
  },
});
