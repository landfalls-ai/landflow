/**
 * What an artifact is, for showing it: an image, a PDF, a CSV table, an HTML page, a Markdown document, a link, data or
 * plain text. Read once from its type, its kind, its name and what it carries, so the Artifacts tab and the detail sheet
 * agree. Everything an agent makes is untrusted: `safeUrl` lets through only http(s) links and inline images or PDFs.
 */
import type { RunArtifact } from './run-trace';
import { isMarkdownArtifact } from './run-changes';

export type ArtifactShape = 'image' | 'pdf' | 'csv' | 'html' | 'markdown' | 'link' | 'data' | 'text';

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i;
const PDF_NAME = /\.pdf(\?.*)?$/i;
/** Inline images a browser draws without running anything (an SVG in an `<img>` runs no script). */
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i;
const DATA_PDF = /^data:application\/pdf[;,]/i;

export const isCsvPath = (path: string) => /\.(csv|tsv)$/i.test(path);
export const isHtmlPath = (path: string) => /\.html?$/i.test(path);

/** The URL when it is safe to load for this shape: http(s) for anything, an inline `data:` image or PDF for those. */
export function safeUrl(url: string | undefined, shape?: ArtifactShape): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).href;
    } catch {
      return undefined;
    }
  }
  if (shape === 'image' && DATA_IMAGE.test(trimmed)) return trimmed;
  if (shape === 'pdf' && DATA_PDF.test(trimmed)) return trimmed;
  return undefined;
}

/** Where a URL loads from, for "Load the image from example.com"; inline data has no host. */
export const urlHost = (url: string) => (url.startsWith('data:') ? undefined : new URL(url).host);

type Shapeable = Pick<RunArtifact, 'name' | 'kind' | 'mimeType' | 'url' | 'text' | 'data'>;

/** What an artifact is. An image or a PDF needs a URL it can load; a table, a page or a document needs its text. */
export function artifactShape(a: Shapeable): ArtifactShape {
  const mime = (a.mimeType ?? '').toLowerCase();
  const kind = (a.kind ?? '').toLowerCase();
  const url = a.url?.trim();
  const named = (re: RegExp) => re.test(a.name) || (!!url && !url.startsWith('data:') && re.test(url.split('#')[0]));
  if ((mime.startsWith('image/') || kind === 'image' || kind === 'screenshot' || named(IMAGE_NAME) || (url && DATA_IMAGE.test(url))) && safeUrl(url, 'image')) return 'image';
  if ((mime === 'application/pdf' || kind === 'pdf' || named(PDF_NAME) || (url && DATA_PDF.test(url))) && safeUrl(url, 'pdf')) return 'pdf';
  if (a.text) {
    if (mime === 'text/csv' || mime === 'text/tab-separated-values' || kind === 'csv' || isCsvPath(a.name)) return 'csv';
    if (mime === 'text/html' || kind === 'html' || isHtmlPath(a.name)) return 'html';
    if (isMarkdownArtifact(a)) return 'markdown';
  }
  if (safeUrl(url)) return 'link';
  if (a.data !== undefined && a.data !== null && typeof a.data === 'object') return 'data';
  return 'text';
}

export interface CsvTable {
  header: string[];
  rows: string[][];
  /** Rows in the text, past the header. */
  total: number;
}

/**
 * A CSV (or TSV, by its first line) read as a header and rows: quoted fields, doubled quotes and line breaks inside quotes,
 * as RFC 4180 has them. `limit` stops keeping rows after that many (the total still counts them all).
 */
export function parseCsv(text: string, limit = Infinity): CsvTable {
  const firstLine = text.split('\n', 1)[0];
  const sep = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ',';
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let total = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') {
      total++;
      if (records.length <= limit) records.push(row);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  if (field !== '' || row.length) endRow();
  const [header = [], ...rows] = records;
  return { header, rows, total: Math.max(0, total - 1) };
}

/**
 * An agent's HTML ready for a sandboxed frame: a policy in front lets it load nothing from the network (no images,
 * styles or fonts that would tell a server who looked) and run no script, and its links go nowhere (a new window the
 * sandbox forbids, and no pointer on them), with the frame's own `sandbox` as the wall.
 */
export function framedHtml(html: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><base target="_blank"><style>a,area{pointer-events:none!important}</style>${html}`;
}
