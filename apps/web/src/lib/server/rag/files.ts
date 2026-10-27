/**
 * Files as documents: the text of a PDF (one entry per page, unpdf like Extract from File), a DOCX (the
 * paragraphs of word/document.xml, read from the zip without a library), plain text, Markdown, HTML, CSV and
 * JSON. The Default Data Loader reads an item's binary files with it, and so does an agent's knowledge base
 * when a document is uploaded. Every entry is a page (PDF, and DOCX with explicit page breaks) or the whole
 * file; `page` is set only where the format says where a page is.
 */
import type { AiDocument } from '@landflow/engine';
import type { JsonObject } from '@landflow/sdk';
import { decodeEntities, htmlText, parseCsv, readZip } from '../binary/formats';
import { textOf } from './text';

export interface FileInput {
  bytes: Uint8Array;
  fileName?: string;
  mimeType?: string;
}

export interface FileText {
  /** 1-based page number, when the format has pages we can tell apart. */
  page?: number;
  text: string;
}

export type FileKind = 'pdf' | 'docx' | 'html' | 'markdown' | 'csv' | 'json' | 'text';

export const SUPPORTED_FILES = 'PDF, DOCX, text, Markdown, HTML, CSV and JSON';

/** Files larger than this are refused by the loader (the text of a bigger file is better split before loading). */
export const MAX_LOAD_BYTES = 50 * 1024 * 1024;

/** An error for a file the loader can't read, worded for the node that shows it. */
export class FileLoadError extends Error {
  constructor(
    message: string,
    readonly description?: string,
  ) {
    super(message);
  }
}

const TEXT_TYPES: Record<string, FileKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'application/json': 'json',
  'text/plain': 'text',
};

const EXTENSIONS: Record<string, FileKind> = {
  pdf: 'pdf',
  docx: 'docx',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  md: 'markdown',
  markdown: 'markdown',
  csv: 'csv',
  json: 'json',
  txt: 'text',
  text: 'text',
  log: 'text',
  rst: 'text',
};

/** What a file is, by its content first (PDF and zip signatures), then MIME type, then extension. */
export function fileKind(file: FileInput): FileKind | undefined {
  const head = Buffer.from(file.bytes.subarray(0, 8));
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  const mimeType = (file.mimeType ?? '').toLowerCase().split(';')[0].trim();
  const extension = /\.([a-z0-9]+)$/i.exec(file.fileName ?? '')?.[1]?.toLowerCase();
  const byType = TEXT_TYPES[mimeType];
  const byExtension = extension ? EXTENSIONS[extension] : undefined;
  if (head.length >= 2 && head.readUInt16LE(0) === 0x4b50) return byType === 'docx' || byExtension === 'docx' ? 'docx' : undefined;
  // A generic type (octet-stream) says nothing: the extension decides.
  if (byType && !(byType === 'text' && byExtension)) return byType;
  if (byExtension) return byExtension;
  if (mimeType.startsWith('text/')) return 'text';
  return undefined;
}

/** The text of a PDF, one entry per page (pdf.js through unpdf, loaded on first use; no OCR). */
export async function pdfPages(bytes: Uint8Array): Promise<FileText[]> {
  const { getDocumentProxy } = await import('unpdf');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js takes ownership of the buffer it's given.
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    throw new FileLoadError(/password/i.test(message) ? 'The PDF is password protected' : 'Can’t read the PDF', message);
  }
  try {
    const pages: FileText[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      const text = content.items
        .map((entry) => ('str' in entry ? `${entry.str}${entry.hasEOL ? '\n' : ''}` : ''))
        .join('')
        .trim();
      pages.push({ page: n, text });
    }
    return pages;
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}

/** The text of a DOCX: one line per paragraph, tabs and line breaks kept, a new entry at each explicit page break. */
export function docxPages(bytes: Uint8Array): FileText[] {
  let xml: string | undefined;
  try {
    xml = readZip(bytes).get('word/document.xml')?.().toString('utf8');
  } catch (error) {
    throw new FileLoadError('Can’t read the DOCX file', (error as Error).message);
  }
  if (xml === undefined) throw new FileLoadError('Can’t read the DOCX file', 'It has no word/document.xml: it may be another kind of zip file, or a legacy .doc.');
  const pages: string[][] = [[]];
  for (const paragraph of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    let line = '';
    for (const part of paragraph[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:br\s+w:type="page"\s*\/>|<w:lastRenderedPageBreak\s*\/>/g)) {
      const tag = part[0];
      if (tag.startsWith('<w:t>') || tag.startsWith('<w:t ')) line += decodeEntities(part[1] ?? '');
      else if (tag.startsWith('<w:tab')) line += '\t';
      else if (tag.includes('w:type="page"')) {
        if (line.trim()) pages.at(-1)!.push(line);
        line = '';
        pages.push([]);
      } else if (tag.startsWith('<w:br')) line += '\n';
    }
    pages.at(-1)!.push(line);
  }
  const texts = pages.map((lines) => lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()).filter((text, index, all) => text || all.length === 1);
  // Pages are only reported when the document marks them.
  return texts.map((text, index) => ({ ...(texts.length > 1 && { page: index + 1 }), text }));
}

/** CSV as blocks of `column: value` lines, one block per row (so a splitter cuts between rows). */
function csvText(text: string): string {
  const rows = parseCsv(text);
  if (rows.length < 2) return text;
  const [header, ...body] = rows;
  return body
    .filter((row) => row.some((cell) => cell !== ''))
    .map((row) => header.map((name, i) => (row[i] === undefined || row[i] === '' ? '' : `${name || `column ${i + 1}`}: ${row[i]}`)).filter(Boolean).join('\n'))
    .join('\n\n');
}

/** JSON as readable text: an array's entries as `key: value` blocks, an object as its lines. */
function jsonText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new FileLoadError('The JSON file is not valid JSON', (error as Error).message);
  }
  return Array.isArray(parsed) ? parsed.map((entry) => textOf(entry)).filter(Boolean).join('\n\n') : textOf(parsed);
}

/** The text of any supported file, as pages. Throws a FileLoadError for a file that can't be read. */
export async function fileText(file: FileInput): Promise<FileText[]> {
  const name = file.fileName ?? 'the file';
  if (file.bytes.byteLength > MAX_LOAD_BYTES) throw new FileLoadError(`${name} is too large to load`, `${Math.round(file.bytes.byteLength / 1024 / 1024)} MB; the limit is ${MAX_LOAD_BYTES / 1024 / 1024} MB.`);
  const kind = fileKind(file);
  if (!kind) throw new FileLoadError(`Can’t load ${name}: its type (${file.mimeType || 'unknown'}) isn’t supported`, `Files can be ${SUPPORTED_FILES}.`);
  if (kind === 'pdf') return pdfPages(file.bytes);
  if (kind === 'docx') return docxPages(file.bytes);
  const raw = Buffer.from(file.bytes).toString('utf8').replace(/^﻿/, '');
  if (kind === 'html') return [{ text: htmlText(raw.replace(/<\/(p|div|h[1-6]|li|tr|table|section|article|ul|ol|blockquote|pre)\s*>/gi, '\n$&')) }];
  if (kind === 'csv') return [{ text: csvText(raw) }];
  if (kind === 'json') return [{ text: jsonText(raw) }];
  return [{ text: raw }];
}

/**
 * A file as documents: each page's text cut into chunks by `split`, with `fileName`, `mimeType`, `page` (where known)
 * and a `chunk` number running through the file.
 */
export async function fileDocuments(file: FileInput, split: (text: string) => Promise<string[]>, extra: JsonObject = {}): Promise<AiDocument[]> {
  const pages = await fileText(file);
  const documents: AiDocument[] = [];
  let chunk = 0;
  for (const { page, text } of pages) {
    if (!text.trim()) continue;
    for (const piece of await split(text)) {
      documents.push({
        pageContent: piece,
        metadata: {
          ...extra,
          ...(file.fileName && { fileName: file.fileName }),
          ...(file.mimeType && { mimeType: file.mimeType }),
          ...(page !== undefined && { page }),
          chunk: chunk++,
        },
      });
    }
  }
  return documents;
}
