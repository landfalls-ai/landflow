/**
 * The nodes that make and use files: Read/Write Files from Disk (and its confinement to LANDFLOW_FILES_DIR),
 * Extract from File (CSV, HTML, JSON, PDF, text, XLSX, base64), Convert to File (CSV, HTML, JSON, text, base64),
 * the HTTP Request node's file responses and multipart / binary bodies, and the nodes that pass files along.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNode, type ExecuteRequest, type INodeType, type JsonObject, type NodeItem } from '@landflow/sdk';
import type { BinaryRef } from '@landflow/protocol';
import { hostBinaryClient, setBinaryStore } from '@/lib/server/binary/access';
import { htmlTables, parseCsv, readOds, readXlsx, readZip, rowsToItems, sheetTitle, toCsv, writeZip } from '@/lib/server/binary/formats';
import { FilesystemBinaryStore, readAll } from '@/lib/server/binary/store';
import { httpRequestNode, setNode } from '@/lib/server/nodes/data';
import { convertToFileNode, extractFromFileNode, globToRegExp, readWriteFileNode, resolveInFilesDir } from '@/lib/server/nodes/files';
import { mergeNode } from '@/lib/server/nodes/flow';
import { renameKeysNode } from '@/lib/server/nodes/transform';
import { importWorkflowJson } from '@/lib/server/n8n-import';
import { corePlugin } from '@/lib/server/nodes';
import { outputsOf, runFlow } from './helpers';

const root = mkdtempSync(join(tmpdir(), 'landflow-file-nodes-'));
const filesDir = join(root, 'files');
const previousFilesDir = process.env.LANDFLOW_FILES_DIR;
process.env.LANDFLOW_FILES_DIR = filesDir;
const binary = new FilesystemBinaryStore(join(root, 'binary'));
setBinaryStore(binary);

afterAll(() => {
  if (previousFilesDir === undefined) delete process.env.LANDFLOW_FILES_DIR;
  else process.env.LANDFLOW_FILES_DIR = previousFilesDir;
  rmSync(root, { recursive: true, force: true });
});

/** Run a node with the host's binary client, as the registry does for in-process nodes. */
async function exec(node: INodeType, parameters: Record<string, unknown>, input: NodeItem[] = [{ json: {} }]) {
  const request: ExecuteRequest = {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_files',
    workflowId: 'wf_files',
    mode: 'manual',
    node: { id: 'n1', name: node.description.displayName, type: `core.${node.description.name}`, typeVersion: 1 },
    parameters: parameters as JsonObject,
    itemParameters: input.map(() => parameters as JsonObject),
    inputs: [input],
  };
  return runNode(node, request, { binary: hostBinaryClient('ex_files') });
}

async function ok(node: INodeType, parameters: Record<string, unknown>, input?: NodeItem[]) {
  const response = await exec(node, parameters, input);
  if (response.error) throw new Error(`${response.error.message} ${response.error.description ?? ''}`);
  return response.outputs[0];
}

const put = (content: string | Uint8Array, fileName: string, mimeType?: string) =>
  binary.put('ex_files', typeof content === 'string' ? new TextEncoder().encode(content) : content, { fileName, ...(mimeType && { mimeType }) });
const fileItem = async (content: string | Uint8Array, fileName: string, property = 'data', json: JsonObject = {}): Promise<NodeItem> => ({ json, binary: { [property]: await put(content, fileName) } });
const bytesOf = async (ref: BinaryRef) => readAll((await binary.open(ref.id!))!.stream);
const textOf = async (ref: BinaryRef) => (await bytesOf(ref)).toString('utf8');

// ---------------------------------------------------------------------------
// Fixtures: a small XLSX (ZIP written here) and a one-page PDF
// ---------------------------------------------------------------------------

function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc32(raw), 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(header, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XLSX = zip({
  'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS}><sheets><sheet name="People" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
  'xl/sharedStrings.xml': `<?xml version="1.0"?><sst ${NS}><si><t>name</t></si><si><t>born</t></si><si><r><t xml:space="preserve">Ada </t></r><r><t>Lovelace &amp; co</t></r></si><si><t>active</t></si></sst>`,
  'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${NS}><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>3</v></c><c r="D1" t="inlineStr"><is><t>score</t></is></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>45306</v></c><c r="C2" t="b"><v>1</v></c><c r="D2"><v>9.5</v></c></row>
    <row r="4"><c r="A4" t="inlineStr"><is><t>Alan</t></is></c><c r="D4"><v>7</v></c></row>
  </sheetData></worksheet>`,
  'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="3"><c r="B3" t="str"><v>k</v></c></row><row r="4"><c r="B4"><v>1</v></c></row></sheetData></worksheet>`,
});

function pdf(lines: string[]): Buffer {
  const content = lines.map((line, i) => `BT /F1 18 Tf 72 ${720 - i * 30} Td (${line}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Title (Quarterly) /Author (Landflow) >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------------------------------------------------------------------------

describe('File formats', () => {
  it('parse CSV with quotes, CRLF, a BOM and other delimiters', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', ''],
    ]);
    expect(parseCsv('a;b\n1;2', { delimiter: ';' })).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(() => parseCsv('a,b"c\n')).toThrow(/Relax Quotes/);
    expect(parseCsv('a,b"c\n', { relaxQuotes: true })).toEqual([['a', 'b"c']]);
    expect(() => parseCsv('"open')).toThrow(/never closed/);
  });

  it('write CSV that reads back the same', () => {
    const rows = [{ a: 'x, y', b: 'say "hi"', c: { n: 1 } }, { a: 'line\nbreak', d: 2 }];
    const csv = toCsv(rows);
    expect(csv.split('\n')[0]).toBe('a,b,c,d');
    expect(rowsToItems(parseCsv(csv))).toEqual([
      { a: 'x, y', b: 'say "hi"', c: '{"n":1}' },
      { a: 'line\nbreak', d: '2' },
    ]);
  });

  it('turn rows into items with suffixed duplicate headers, row ranges and { row } without a header', () => {
    const rows = [
      ['id', 'id', ''],
      ['1', '2', '3'],
      ['', '', ''],
      ['4', '', '6'],
    ];
    expect(rowsToItems(rows)).toEqual([
      { id: '1', id_1: '2', __EMPTY: '3' },
      { id: '4', __EMPTY: '6' },
    ]);
    expect(rowsToItems(rows, { includeEmptyCells: true, maxRowCount: 1 })).toEqual([{ id: '1', id_1: '2', __EMPTY: '3' }]);
    expect(rowsToItems(rows, { headerRow: false, fromLine: 1 })).toEqual([{ row: ['1', '2', '3'] }, { row: ['4', '', '6'] }]);
  });

  it('read HTML tables', () => {
    const tables = htmlTables('<p>x</p><table><thead><tr><th>Name</th><th colspan="2">Langs</th></tr></thead><tbody><tr><td>Ada &amp; <b>co</b></td><td>en</td><td>fr</td></tr></tbody></table>');
    expect(tables).toEqual([
      [
        ['Name', 'Langs', ''],
        ['Ada & co', 'en', 'fr'],
      ],
    ]);
  });

  it('read XLSX sheets: shared and inline strings, numbers, booleans, dates', () => {
    expect(Object.keys(Object.fromEntries(readZip(XLSX)))).toContain('xl/workbook.xml');
    const sheet = readXlsx(XLSX);
    expect(sheet.sheetNames).toEqual(['People', 'Other']);
    expect(rowsToItems(sheet.rows)).toEqual([
      { name: 'Ada Lovelace & co', born: '2024-01-15', active: true, score: 9.5 },
      { name: 'Alan', score: 7 },
    ]);
    expect(readXlsx(XLSX, { rawData: true }).rows[1][1]).toBe(45306);
    // A sheet that starts at B3.
    expect(rowsToItems(readXlsx(XLSX, { sheetName: 'Other' }).rows)).toEqual([{ k: 1 }]);
    expect(() => readXlsx(XLSX, { sheetName: 'Nope' })).toThrow(/“People”, “Other”/);
    expect(() => readXlsx(Buffer.from('not a zip'))).toThrow(/ZIP/);
  });

  it('match globs', () => {
    expect(globToRegExp('*.csv').test('a.csv')).toBe(true);
    expect(globToRegExp('*.csv').test('dir/a.csv')).toBe(false);
    expect(globToRegExp('**/*.csv').test('a.csv')).toBe(true);
    expect(globToRegExp('**/*.csv').test('x/y/a.csv')).toBe(true);
    expect(globToRegExp('in/*.{png,jpg}').test('in/a.jpg')).toBe(true);
    expect(globToRegExp('in/?.txt').test('in/ab.txt')).toBe(false);
    expect(globToRegExp('file[12].txt').test('file2.txt')).toBe(true);
    expect(globToRegExp('a+b.txt').test('a+b.txt')).toBe(true);
  });
});

describe('Read/Write Files from Disk', () => {
  beforeAll(() => {
    mkdirSync(join(filesDir, 'in', 'deep'), { recursive: true });
    writeFileSync(join(filesDir, 'in', 'a.csv'), 'x\n1\n');
    writeFileSync(join(filesDir, 'in', 'b.csv'), 'x\n2\n');
    writeFileSync(join(filesDir, 'in', 'notes.txt'), 'hello');
    writeFileSync(join(filesDir, 'in', 'deep', 'c.csv'), 'x\n3\n');
    writeFileSync(join(root, 'secret.txt'), 'top secret');
    symlinkSync(join(root, 'secret.txt'), join(filesDir, 'in', 'link.txt'));
    symlinkSync(root, join(filesDir, 'escape'));
  });

  it('reads one file into binary.data', async () => {
    const [item] = await ok(readWriteFileNode, { operation: 'read', fileSelector: 'in/notes.txt' });
    expect(item.json).toEqual({ fileName: 'notes.txt', filePath: 'in/notes.txt', directory: 'in', mimeType: 'text/plain', fileSize: 5 });
    expect(item.binary?.data).toMatchObject({ fileName: 'notes.txt', mimeType: 'text/plain', fileExtension: 'txt', fileSize: 5 });
    expect(await textOf(item.binary!.data)).toBe('hello');
  });

  it('reads every file a glob matches, with option overrides', async () => {
    const flat = await ok(readWriteFileNode, { operation: 'read', fileSelector: 'in/*.csv' });
    expect(flat.map((item) => item.json.filePath)).toEqual(['in/a.csv', 'in/b.csv']);
    const deep = await ok(readWriteFileNode, { operation: 'read', fileSelector: '**/*.csv', options: { dataPropertyName: 'sheet', mimeType: 'text/x-test' } });
    expect(deep.map((item) => item.json.filePath)).toEqual(['in/a.csv', 'in/b.csv', 'in/deep/c.csv']);
    expect(deep[2].binary?.sheet).toMatchObject({ mimeType: 'text/x-test', fileName: 'c.csv' });
    // Absolute paths inside the directory work too.
    const absolute = await ok(readWriteFileNode, { operation: 'read', fileSelector: join(filesDir, 'in', 'a.csv') });
    expect(absolute[0].json.filePath).toBe('in/a.csv');
  });

  it('never reads or writes outside the files directory', async () => {
    for (const fileSelector of ['../secret.txt', join(root, 'secret.txt'), 'in/link.txt', 'escape/secret.txt', '/etc/passwd', 'in/../../secret.txt']) {
      const response = await exec(readWriteFileNode, { operation: 'read', fileSelector });
      expect(response.error?.message, fileSelector).toMatch(/outside the files directory/);
    }
    // Nor a glob through a symlinked directory.
    expect((await exec(readWriteFileNode, { operation: 'read', fileSelector: 'escape/*' })).error?.message).toMatch(/outside the files directory/);
    const input = [await fileItem('x', 'x.txt')];
    for (const fileName of ['../out.txt', 'escape/out.txt', join(root, 'out.txt')]) {
      const response = await exec(readWriteFileNode, { operation: 'write', fileName, dataPropertyName: 'data' }, input);
      expect(response.error?.message, fileName).toMatch(/outside the files directory/);
    }
    await expect(resolveInFilesDir('in/../in/a.csv')).resolves.toMatchObject({ path: expect.stringContaining(join('in', 'a.csv')) });
    expect((await exec(readWriteFileNode, { operation: 'read', fileSelector: 'in/missing.txt' })).error?.message).toMatch(/No file/);
    expect((await exec(readWriteFileNode, { operation: 'read', fileSelector: 'in' })).error?.message).toMatch(/is a directory/);
  });

  it('writes an item’s file, creating folders, and appends', async () => {
    const input = [await fileItem('first\n', 'log.txt', 'data', { id: 1 })];
    const [written] = await ok(readWriteFileNode, { operation: 'write', fileName: 'out/logs/log.txt', dataPropertyName: 'data' }, input);
    expect(written.json).toEqual({ id: 1, fileName: 'out/logs/log.txt' });
    expect(written.binary?.data).toBeDefined();
    await ok(readWriteFileNode, { operation: 'write', fileName: 'out/logs/log.txt', dataPropertyName: 'data', options: { append: true } }, input);
    expect(readFileSync(join(filesDir, 'out', 'logs', 'log.txt'), 'utf8')).toBe('first\nfirst\n');
    const missing = await exec(readWriteFileNode, { operation: 'write', fileName: 'x.txt', dataPropertyName: 'nope' }, input);
    expect(missing.error?.message).toMatch(/no binary file “nope”/);
  });
});

describe('Extract from File', () => {
  it('reads CSV rows, with options', async () => {
    const input = [await fileItem('name;age\nAda;36\n;\nAlan;41\n', 'p.csv')];
    expect((await ok(extractFromFileNode, { operation: 'csv', binaryPropertyName: 'data', options: { delimiter: ';' } }, input)).map((i) => i.json)).toEqual([
      { name: 'Ada', age: '36' },
      { name: 'Alan', age: '41' },
    ]);
    const raw = await ok(extractFromFileNode, { operation: 'csv', binaryPropertyName: 'data', options: { delimiter: ';', headerRow: false, maxRowCount: 2 } }, input);
    expect(raw.map((i) => i.json)).toEqual([{ row: ['name', 'age'] }, { row: ['Ada', '36'] }]);
    const latin = [await fileItem(Buffer.from('city\nZürich\n', 'latin1'), 'l.csv')];
    expect((await ok(extractFromFileNode, { operation: 'csv', binaryPropertyName: 'data', options: { encoding: 'latin1' } }, latin))[0].json).toEqual({ city: 'Zürich' });
  });

  it('reads XLSX and HTML tables', async () => {
    const sheet = await ok(extractFromFileNode, { operation: 'xlsx', binaryPropertyName: 'data' }, [await fileItem(XLSX, 'people.xlsx')]);
    expect(sheet.map((i) => i.json)).toEqual([
      { name: 'Ada Lovelace & co', born: '2024-01-15', active: true, score: 9.5 },
      { name: 'Alan', score: 7 },
    ]);
    const html = await ok(extractFromFileNode, { operation: 'html', binaryPropertyName: 'data' }, [await fileItem('<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>', 't.html')]);
    expect(html.map((i) => i.json)).toEqual([{ a: '1', b: '2' }]);
    const broken = await exec(extractFromFileNode, { operation: 'xlsx', binaryPropertyName: 'data' }, [await fileItem('nope', 'bad.xlsx')]);
    expect(broken.error?.message).toMatch(/Can’t read bad\.xlsx as XLSX/);
  });

  it('reads JSON, text and PDF text into a field', async () => {
    const json = await ok(extractFromFileNode, { operation: 'fromJson', binaryPropertyName: 'data', destinationKey: 'parsed', options: { keepSource: 'both' } }, [
      await fileItem('{"a":[1,2]}', 'a.json', 'data', { keep: true }),
    ]);
    expect(json[0].json).toEqual({ keep: true, parsed: { a: [1, 2] } });
    expect(json[0].binary?.data).toBeDefined();
    const bad = await exec(extractFromFileNode, { operation: 'fromJson', binaryPropertyName: 'data', destinationKey: 'data' }, [await fileItem('{oops', 'bad.json')]);
    expect(bad.error?.message).toMatch(/bad\.json isn’t valid JSON/);

    const text = await ok(extractFromFileNode, { operation: 'text', binaryPropertyName: 'data', destinationKey: 'data' }, [await fileItem('héllo', 'h.txt')]);
    expect(text[0].json).toEqual({ data: 'héllo' });
    expect(text[0].binary).toBeUndefined();

    const doc = await ok(extractFromFileNode, { operation: 'pdf', binaryPropertyName: 'data' }, [await fileItem(pdf(['Hello PDF', 'Second line']), 'doc.pdf')]);
    expect(doc[0].json).toMatchObject({ numpages: 1, numrender: 1, info: { Title: 'Quarterly', Author: 'Landflow' } });
    expect(doc[0].json.text).toContain('Hello PDF');
    expect(doc[0].json.text).toContain('Second line');
    const pages = await ok(extractFromFileNode, { operation: 'pdf', binaryPropertyName: 'data', options: { joinPages: false } }, [await fileItem(pdf(['Only']), 'one.pdf')]);
    expect(pages[0].json.text).toEqual(['Only']);
    const notPdf = await exec(extractFromFileNode, { operation: 'pdf', binaryPropertyName: 'data' }, [await fileItem('plain', 'x.pdf')]);
    expect(notPdf.error?.message).toMatch(/Can’t read the PDF/);
  });

  it('moves a file to a base64 string, and says which files an item has', async () => {
    const [item] = await ok(extractFromFileNode, { operation: 'binaryToPropery', binaryPropertyName: 'img', destinationKey: 'b64' }, [await fileItem(new Uint8Array([0, 1, 2, 255]), 'x.bin', 'img')]);
    expect(item.json).toEqual({ b64: 'AAEC/w==' });
    const missing = await exec(extractFromFileNode, { operation: 'text', binaryPropertyName: 'data', destinationKey: 'data' }, [await fileItem('x', 'x.txt', 'other')]);
    expect(missing.error).toMatchObject({ message: 'Item 0 has no binary file “data”', description: 'Its files: other' });
  });
});

describe('Convert to File', () => {
  const people = [{ json: { name: 'Ada', langs: ['en'] } }, { json: { name: 'Alan, T.', age: 41 } }];

  it('writes all items as one CSV or HTML file', async () => {
    const [csv] = await ok(convertToFileNode, { operation: 'csv', binaryPropertyName: 'data', options: { fileName: 'people.csv' } }, people);
    expect(csv.json).toEqual({});
    expect(csv.binary?.data).toMatchObject({ fileName: 'people.csv', mimeType: 'text/csv', fileExtension: 'csv' });
    expect(await textOf(csv.binary!.data)).toBe('name,langs,age\nAda,"[""en""]",\n"Alan, T.",,41\n');
    const [bom] = await ok(convertToFileNode, { operation: 'csv', binaryPropertyName: 'file', options: { delimiter: ';', headerRow: false, addBOM: true } }, people);
    expect([...(await bytesOf(bom.binary!.file)).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bom.binary!.file.fileName).toBe('data.csv');
    const [html] = await ok(convertToFileNode, { operation: 'html', binaryPropertyName: 'data' }, people);
    expect(html.binary?.data).toMatchObject({ fileName: 'data.html', mimeType: 'text/html' });
    expect(await textOf(html.binary!.data)).toContain('<th>name</th><th>langs</th><th>age</th>');
  });

  it('writes JSON for all items or each item', async () => {
    const [all] = await ok(convertToFileNode, { operation: 'toJson', mode: 'once', binaryPropertyName: 'data', options: { format: true } }, people);
    expect(JSON.parse(await textOf(all.binary!.data))).toEqual(people.map((p) => p.json));
    expect(await textOf(all.binary!.data)).toContain('\n  {');
    const each = await ok(convertToFileNode, { operation: 'toJson', mode: 'each', binaryPropertyName: 'data', options: { fileName: 'item.json' } }, people);
    expect(each).toHaveLength(2);
    expect(each[1].json).toEqual(people[1].json);
    expect(JSON.parse(await textOf(each[1].binary!.data))).toEqual(people[1].json);
  });

  it('writes a field’s text, or its base64 data, as a file per item', async () => {
    const [text] = await ok(convertToFileNode, { operation: 'toText', sourceProperty: 'doc.body', binaryPropertyName: 'data', options: { fileName: 'note.md' } }, [
      { json: { doc: { body: '# Title' } } },
    ]);
    expect(text.binary?.data).toMatchObject({ fileName: 'note.md', mimeType: 'text/markdown', fileSize: 7 });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const [uri] = await ok(convertToFileNode, { operation: 'toBinary', sourceProperty: 'img', binaryPropertyName: 'image' }, [
      { json: { img: `data:image/png;base64,${png}` }, binary: { old: await put('keep', 'k.txt') } },
    ]);
    expect(uri.binary?.image).toMatchObject({ mimeType: 'image/png', fileName: 'file.png', fileSize: 4, fileType: 'image' });
    expect(Object.keys(uri.binary!)).toEqual(['old', 'image']);
    const [plain] = await ok(convertToFileNode, { operation: 'toBinary', sourceProperty: 'b', binaryPropertyName: 'data', options: { fileName: 'x.bin' } }, [{ json: { b: png } }]);
    expect([...(await bytesOf(plain.binary!.data))]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const invalid = await exec(convertToFileNode, { operation: 'toBinary', sourceProperty: 'b', binaryPropertyName: 'data' }, [{ json: { b: 'not base64!' } }]);
    expect(invalid.error?.message).toMatch(/isn’t base64/);
    const missing = await exec(convertToFileNode, { operation: 'toText', sourceProperty: 'nope', binaryPropertyName: 'data' }, [{ json: {} }]);
    expect(missing.error?.message).toMatch(/no field “nope”/);
  });
});

describe('Convert to File: XLSX and ODS', () => {
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';
  const rows: JsonObject[] = [
    { name: 'Ada <Lovelace> & "co"', n: 1.5, big: 12345678901, ok: true, born: '2024-01-20', at: '2024-01-20T10:30:15Z', note: 'line one\nline two', pad: '  spaced  out ', code: '007' },
    { name: 'Zoë 日本語 😀', n: -3, ok: false, nothing: null, empty: '', tags: ['a', 'b'], nested: { k: 1 } },
    { name: 'bell\u0007', n: 0 },
  ];
  const expected = [
    { name: 'Ada <Lovelace> & "co"', n: 1.5, big: 12345678901, ok: true, born: '2024-01-20', at: '2024-01-20T10:30:15.000Z', note: 'line one\nline two', pad: '  spaced  out ', code: '007' },
    { name: 'Zoë 日本語 😀', n: -3, ok: false, tags: '["a","b"]', nested: '{"k":1}' },
    { name: 'bell', n: 0 },
  ];
  const input = rows.map((json) => ({ json }));
  const back = async (operation: 'xlsx' | 'ods', file: BinaryRef, options: Record<string, unknown> = {}) =>
    (await ok(extractFromFileNode, { operation, binaryPropertyName: 'data', options }, [{ json: {}, binary: { data: file } }])).map((i) => i.json);

  for (const [operation, mime] of [['xlsx', XLSX_MIME], ['ods', ODS_MIME]] as const) {
    describe(operation, () => {
      it('round-trips typed values, special characters and empty cells', async () => {
        const [file] = await ok(convertToFileNode, { operation, binaryPropertyName: 'data', options: {} }, input);
        expect(file.binary?.data).toMatchObject({ fileName: `data.${operation}`, mimeType: mime, fileExtension: operation });
        const bytes = await bytesOf(file.binary!.data);
        expect(bytes.subarray(0, 2).toString()).toBe('PK');
        expect(await back(operation, file.binary!.data)).toEqual(expected);
      });

      it('leaves out the header row, keeps the order of a given column list', async () => {
        const [file] = await ok(convertToFileNode, { operation, binaryPropertyName: 'data', options: { headerRow: false, columns: ' n , name ', fileName: 'plain' } }, input);
        expect(file.binary?.data).toMatchObject({ fileName: 'plain', mimeType: mime });
        expect(await back(operation, file.binary!.data, { headerRow: false })).toEqual([
          { row: [1.5, 'Ada <Lovelace> & "co"'] },
          { row: [-3, 'Zoë 日本語 😀'] },
          { row: [0, 'bell'] },
        ]);
        const [listed] = await ok(convertToFileNode, { operation, binaryPropertyName: 'data', options: { columns: 'ok, name' } }, input);
        const keys = (await back(operation, listed.binary!.data)).map((r) => Object.keys(r));
        expect(keys).toEqual([['ok', 'name'], ['ok', 'name'], ['name']]);
      });

      it('names the sheet, or splits items into one sheet per field value', async () => {
        const data = [
          { json: { region: 'EU', v: 1 } },
          { json: { region: 'US', v: 2 } },
          { json: { region: 'EU', v: 3 } },
          { json: { v: 4 } },
          { json: { region: 'a/b:c*[d]?', v: 5 } },
          { json: { region: 'eu', v: 6 } },
        ];
        const [single] = await ok(convertToFileNode, { operation, binaryPropertyName: 'data', options: { sheetName: 'Report' } }, data);
        const read = operation === 'xlsx' ? readXlsx : readOds;
        expect(read(await bytesOf(single.binary!.data)).sheetNames).toEqual(['Report']);
        const [multi] = await ok(convertToFileNode, { operation, binaryPropertyName: 'data', options: { sheetNameField: 'region', sheetName: 'Rest' } }, data);
        const bytes = await bytesOf(multi.binary!.data);
        expect(read(bytes).sheetNames).toEqual(['EU', 'US', 'Rest', 'a b c  d', 'eu_2']);
        expect(await back(operation, multi.binary!.data, { sheetName: 'EU' })).toEqual([{ region: 'EU', v: 1 }, { region: 'EU', v: 3 }]);
        expect(await back(operation, multi.binary!.data, { sheetName: 'Rest' })).toEqual([{ v: 4 }]);
        expect(await back(operation, multi.binary!.data, { sheetName: 'eu_2' })).toEqual([{ region: 'eu', v: 6 }]);
      });

      it('writes dates as text when asked, and an empty sheet for no items', async () => {
        const [text] = await ok(convertToFileNode, { operation, binaryPropertyName: 'data', options: { dates: false } }, [{ json: { d: '2024-01-20', f: '2024-02-30' } }]);
        expect(await back(operation, text.binary!.data)).toEqual([{ d: '2024-01-20', f: '2024-02-30' }]);
        const [dates] = await ok(convertToFileNode, { operation, binaryPropertyName: 'data', options: {} }, [{ json: { d: '2024-01-20', f: '2024-02-30', t: '2024-01-20 08:00' } }]);
        expect(await back(operation, dates.binary!.data)).toEqual([{ d: '2024-01-20', f: '2024-02-30', t: '2024-01-20T08:00:00.000Z' }]);
        const [none] = await ok(convertToFileNode, { operation, binaryPropertyName: 'data', options: {} }, []);
        expect(await back(operation, none.binary!.data)).toEqual([]);
      });
    });
  }

  it('XLSX is a valid package: parts, relationships, styles, escaped names', async () => {
    const [file] = await ok(convertToFileNode, { operation: 'xlsx', binaryPropertyName: 'data', options: { sheetName: 'Q&A <1>' } }, input);
    const zip = readZip(await bytesOf(file.binary!.data));
    expect([...zip.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']));
    expect(zip.get('xl/workbook.xml')!().toString()).toContain('name="Q&amp;A &lt;1&gt;"');
    const sheet = zip.get('xl/worksheets/sheet1.xml')!().toString();
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="3">');
    expect(sheet).toContain('<c r="D2" t="b"><v>1</v></c>');
    expect(sheet).not.toContain('\u0007');
    const raw = readXlsx(await bytesOf(file.binary!.data), { rawData: true }).rows[1];
    expect(raw[4]).toBe(45311); // 2024-01-20
    expect(raw[5]).toBeCloseTo(45311.4376736, 6); // 10:30:15
  });

  it('ODS stores the mimetype first, uncompressed', async () => {
    const [file] = await ok(convertToFileNode, { operation: 'ods', binaryPropertyName: 'data', options: {} }, input);
    const bytes = await bytesOf(file.binary!.data);
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(bytes.readUInt16LE(8)).toBe(0);
    expect(bytes.subarray(30, 30 + 8 + 'application/vnd.oasis.opendocument.spreadsheet'.length).toString()).toBe('mimetypeapplication/vnd.oasis.opendocument.spreadsheet');
    expect(readZip(bytes).get('content.xml')!().toString()).toContain('office:value-type="date"');
  });

  it('writes columns past Z and many rows', async () => {
    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`c${i}`, i]));
    const [file] = await ok(convertToFileNode, { operation: 'xlsx', binaryPropertyName: 'data', options: {} }, [{ json: wide }]);
    expect(await back('xlsx', file.binary!.data)).toEqual([wide]);
    expect(readZip(await bytesOf(file.binary!.data)).get('xl/worksheets/sheet1.xml')!().toString()).toContain('r="AD1"');
  });

  it('cleans sheet names and writes a readable ZIP', () => {
    expect(sheetTitle("'a[b]:c'", 'x')).toBe('a b  c');
    expect(sheetTitle('', 'Sheet1')).toBe('Sheet1');
    expect(sheetTitle('x'.repeat(40))).toHaveLength(31);
    const zip = readZip(writeZip([{ name: 'a.txt', data: Buffer.from('hello '.repeat(100)) }, { name: 'ü.bin', data: Buffer.from([1, 2, 3]), store: true }]));
    expect(zip.get('a.txt')!().toString()).toBe('hello '.repeat(100));
    expect([...zip.get('ü.bin')!()]).toEqual([1, 2, 3]);
  });

  it('reads ODS as LibreOffice writes it: repeated cells and rows, spaces, tabs, covered cells, times', () => {
    const NSO = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';
    const content = `<?xml version="1.0"?><office:document-content ${NSO}><office:body><office:spreadsheet>
      <table:table table:name="Data"><table:table-column table:number-columns-repeated="3"/>
        <table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="1048576"/></table:table-row>
        <table:table-row><table:table-cell table:number-columns-repeated="1"/><table:table-cell office:value-type="string"><text:p>a</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>b</text:p></table:table-cell></table:table-row>
        <table:table-row><table:table-cell/><table:table-cell office:value-type="float" office:value="2"><text:p>2.00</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>x<text:s text:c="3"/>y<text:tab/>z</text:p><text:p>two <text:span>lines</text:span></text:p></table:table-cell></table:table-row>
        <table:table-row><table:table-cell/><table:table-cell office:value-type="time" office:time-value="PT10H05M09S"/><table:table-cell table:number-columns-repeated="2" office:value-type="percentage" office:value="0.5"/></table:table-row>
        <table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="1048576"/></table:table-row>
      </table:table><table:table table:name="Two"><table:table-row><table:table-cell office:value-type="boolean" office:boolean-value="true"/></table:table-row></table:table>
    </office:spreadsheet></office:body></office:document-content>`;
    const file = writeZip([
      { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.spreadsheet'), store: true },
      { name: 'content.xml', data: Buffer.from(content) },
    ]);
    const sheet = readOds(file);
    expect(sheet.sheetNames).toEqual(['Data', 'Two']);
    expect(sheet.rows).toEqual([['a', 'b'], [2, 'x   y\tz\ntwo lines'], ['10:05:09', 0.5, 0.5]]);
    expect(readOds(file, { sheetName: 'Two' }).rows).toEqual([[true]]);
    expect(() => readOds(file, { sheetName: 'No' })).toThrow(/“Data”, “Two”/);
    expect(() => readOds(XLSX)).toThrow(/no content\.xml/);
  });
});

describe('HTTP Request files', () => {
  let server: Server;
  let base = '';
  const seen: Array<{ method?: string; type?: string; length?: string; body: Buffer }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ method: req.method, type: req.headers['content-type'], length: req.headers['content-length'], body: Buffer.concat(chunks) });
        if (req.url === '/report') {
          res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="q3 report.pdf"' });
          res.end('%PDF-1.4 fake');
        } else if (req.url === '/images/logo.png') {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(Buffer.from([0x89, 0x50]));
        } else if (req.url === '/json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        } else if (req.url === '/text') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('plain text');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ received: Buffer.concat(chunks).length }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('stores non-text responses as a file, and JSON stays JSON', async () => {
    const [report] = await ok(httpRequestNode, { method: 'GET', url: `${base}/report` });
    expect(report.json).toEqual({});
    expect(report.binary?.data).toMatchObject({ fileName: 'q3 report.pdf', mimeType: 'application/pdf', fileSize: 13, fileType: 'pdf' });
    expect(await textOf(report.binary!.data)).toBe('%PDF-1.4 fake');
    // octet-stream: the type comes from the URL's name.
    const [logo] = await ok(httpRequestNode, { method: 'GET', url: `${base}/images/logo.png`, options: { outputPropertyName: 'logo', fullResponse: true } });
    expect(logo.binary?.logo).toMatchObject({ fileName: 'logo.png', mimeType: 'image/png' });
    expect(logo.json).toMatchObject({ status: 200, headers: { 'content-type': 'application/octet-stream' } });
    expect((await ok(httpRequestNode, { method: 'GET', url: `${base}/json` }))[0].json).toEqual({ ok: true });
    const [forced] = await ok(httpRequestNode, { method: 'GET', url: `${base}/text`, options: { responseFormat: 'file' } });
    expect(forced.binary?.data).toMatchObject({ mimeType: 'text/plain', fileName: 'text', fileSize: 10 });
    expect((await ok(httpRequestNode, { method: 'GET', url: `${base}/report`, options: { responseFormat: 'text' } }))[0].json).toEqual({ data: '%PDF-1.4 fake' });
  });

  it('sends multipart form data with item files, and a file as the raw body', async () => {
    const input = [await fileItem('a,b\n', 'sheet.csv', 'data', { id: 1 })];
    seen.length = 0;
    await ok(
      httpRequestNode,
      {
        method: 'POST',
        url: `${base}/upload`,
        bodyType: 'multipart',
        formData: {
          values: [
            { name: 'note', type: 'text', value: 'hi' },
            { name: 'upload', type: 'file', binaryPropertyName: 'data' },
          ],
        },
      },
      input,
    );
    const multipart = seen.at(-1)!;
    expect(multipart.type).toMatch(/^multipart\/form-data; boundary=/);
    const form = await new Response(multipart.body, { headers: { 'content-type': multipart.type! } }).formData();
    expect(form.get('note')).toBe('hi');
    const file = form.get('upload') as File;
    expect([file.name, file.type, await file.text()]).toEqual(['sheet.csv', 'text/csv', 'a,b\n']);

    const [sent] = await ok(httpRequestNode, { method: 'PUT', url: `${base}/raw`, bodyType: 'binary', binaryPropertyName: 'data' }, input);
    expect(sent.json).toEqual({ received: 4 });
    expect(seen.at(-1)).toMatchObject({ method: 'PUT', type: 'text/csv', length: '4' });
  });
});

describe('Nodes that pass files along', () => {
  const inline = { mimeType: 'text/plain', fileName: 'a.txt', fileSize: 1, data: 'YQ==' };

  it('keep item.binary through Edit Fields, Rename Keys and Merge', async () => {
    const result = await runFlow(
      [
        { name: 'Set', type: 'core.set', parameters: { mode: 'manual', includeOtherFields: true, fields: { values: [{ name: 'x', type: 'string', value: '1' }] } } },
        { name: 'Rename', type: 'core.renameKeys', parameters: { keys: { key: [{ currentKey: 'x', newKey: 'y' }] } } },
      ],
      [
        ['Start', 'Set'],
        ['Set', 'Rename'],
      ],
      { input: [{}] },
    );
    expect(outputsOf(result, 'Rename')[0]).toEqual([{ y: '1' }]);
    // The engine path above has no files; run the nodes directly with one.
    const withFile: NodeItem[] = [{ json: { x: '1' }, binary: { data: inline } }];
    for (const [node, parameters] of [
      [setNode, { mode: 'manual', includeOtherFields: true, fields: { values: [{ name: 'z', type: 'string', value: '2' }] } }],
      [renameKeysNode, { keys: { key: [{ currentKey: 'x', newKey: 'y' }] } }],
    ] as const) {
      const [item] = await ok(node, parameters, withFile);
      expect(item.binary?.data, node.description.name).toMatchObject({ fileName: 'a.txt' });
    }
    const merged = await runNode(mergeNode, {
      protocol: 'landflow.plugin/v1',
      executionId: 'ex_merge',
      workflowId: 'wf',
      mode: 'manual',
      node: { id: 'm', name: 'Merge', type: 'core.merge', typeVersion: 1 },
      parameters: { mode: 'position' },
      itemParameters: [{ mode: 'position' }],
      inputs: [[{ json: { a: 1 }, binary: { data: inline } }], [{ json: { b: 2 }, binary: { other: { ...inline, fileName: 'b.txt' } } }]],
    });
    expect(merged.error).toBeUndefined();
    expect(Object.keys(merged.outputs[0][0].binary ?? {})).toEqual(['data', 'other']);
  });
});

describe('n8n import', () => {
  it('maps n8n’s file nodes with their parameters', () => {
    const resolveType = (type: string) => corePlugin.nodes.find((n) => `core.${n.description.name}` === type)?.description;
    const node = (type: string, parameters: Record<string, unknown>) => ({ parameters, name: type, type: `n8n-nodes-base.${type}`, typeVersion: 1, position: [0, 0] });
    const { workflow, report } = importWorkflowJson(
      {
        nodes: [
          node('readWriteFile', { operation: 'write', fileName: 'out/a.csv', options: { append: true } }),
          node('extractFromFile', { operation: 'csv', binaryPropertyName: 'sheet', options: { delimiter: ';', headerRow: false } }),
          node('convertToFile', { operation: 'toJson', mode: 'each', options: { format: true } }),
        ],
        connections: {},
      },
      { resolveType },
    );
    expect(workflow.nodes.map((n) => n.type)).toEqual(['core.readWriteFile', 'core.extractFromFile', 'core.convertToFile']);
    expect(workflow.nodes[0].parameters).toMatchObject({ operation: 'write', fileName: 'out/a.csv', options: { append: true }, dataPropertyName: 'data' });
    expect(workflow.nodes[1].parameters).toMatchObject({ operation: 'csv', binaryPropertyName: 'sheet', options: { delimiter: ';', headerRow: false } });
    expect(workflow.nodes[2].parameters).toMatchObject({ operation: 'toJson', mode: 'each', options: { format: true } });
    expect(report.placeholders).toEqual([]);
  });
});
