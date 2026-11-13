/**
 * The file dataset of an evaluation: a CSV or JSON file uploaded on the Evaluations tab, kept in the binary store (one
 * scope per upload, `evds_<random>`; replacing the file deletes the old scope) with its metadata in
 * `evaluation_settings`. The Evaluation Trigger's "File" source reads it, one test case per row.
 *
 * CSV: the first row names the columns (comma, semicolon or tab). JSON: an array of objects, an object with such an
 * array under `rows`, `cases`, `data`, `items`, `dataset` or `examples`, or JSON Lines (one object per line).
 */
import { nanoid } from 'nanoid';
import type { JsonObject, JsonValue } from '@landflow/protocol';
import type { EvaluationFile } from '../../shared/evaluations';
import { binaryStore } from '../binary/access';
import { parseCsv, rowsToItems } from '../binary/formats';
import { readAll } from '../binary/store';
import { getSettings, saveSettings } from './store';
import { HttpError } from '../errors';

/** The largest dataset file. */
export const MAX_DATASET_BYTES = 10 * 1024 * 1024;
const ARRAY_KEYS = ['rows', 'cases', 'data', 'items', 'dataset', 'examples', 'records'];

export class DatasetFileError extends HttpError {
  constructor(message: string) {
    super(message, 400);
  }
}

export interface ParsedDataset {
  format: 'csv' | 'json';
  rows: Array<Record<string, unknown>>;
  columns: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function detectDelimiter(text: string): string {
  const header = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const [best] = [',', ';', '\t'].map((delimiter) => [delimiter, header.split(delimiter).length - 1] as const).sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? best[0] : ',';
}

function jsonRows(text: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // JSON Lines: one object per line.
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    try {
      return lines.map((line) => JSON.parse(line) as unknown);
    } catch {
      throw new DatasetFileError(`The file is not valid JSON: ${(error as Error).message}`);
    }
  }
  if (Array.isArray(value)) return value;
  if (isObject(value)) {
    const key = ARRAY_KEYS.find((name) => Array.isArray(value[name]));
    if (key) return value[key] as unknown[];
  }
  throw new DatasetFileError('JSON datasets are an array of objects, or an object with the array under rows, cases, data, items, dataset or examples');
}

/** Parse a dataset file's text; throws a DatasetFileError saying what is wrong. */
export function parseDatasetText(text: string, fileName = ''): ParsedDataset {
  const lower = fileName.toLowerCase();
  const first = text.replace(/^﻿/, '').trimStart()[0];
  const format: 'csv' | 'json' = /\.(json|jsonl|ndjson)$/.test(lower) ? 'json' : /\.(csv|tsv|txt)$/.test(lower) ? 'csv' : first === '[' || first === '{' ? 'json' : 'csv';
  let rows: Array<Record<string, unknown>>;
  if (format === 'json') {
    const list = jsonRows(text);
    list.forEach((row, index) => {
      if (!isObject(row)) throw new DatasetFileError(`Row ${index + 1} is not an object: every test case is an object of named values`);
    });
    rows = list as Array<Record<string, unknown>>;
  } else {
    try {
      rows = rowsToItems(parseCsv(text, { delimiter: detectDelimiter(text), relaxQuotes: true }) as JsonValue[][], { includeEmptyCells: true }) as JsonObject[];
    } catch (error) {
      throw new DatasetFileError((error as Error).message);
    }
  }
  if (!rows.length) throw new DatasetFileError('The file has no rows: add one row per test case');
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return { format, rows, columns };
}

/** Keep `bytes` as the workflow's evaluation dataset (replacing the previous file); returns its metadata. */
export async function saveDatasetFile(workflowId: string, bytes: Uint8Array, fileName: string): Promise<EvaluationFile> {
  if (bytes.length > MAX_DATASET_BYTES) throw new DatasetFileError(`The file is larger than ${MAX_DATASET_BYTES / 1024 / 1024} MB`);
  const name = fileName.replace(/[\\/]+/g, '_').trim().slice(0, 200) || 'dataset';
  const parsed = parseDatasetText(Buffer.from(bytes).toString('utf8'), name);
  const binary = await binaryStore();
  const ref = await binary.put(`evds_${nanoid(10)}`, bytes, { fileName: name, mimeType: parsed.format === 'csv' ? 'text/csv' : 'application/json' }, { maxBytes: MAX_DATASET_BYTES });
  const settings = getSettings(workflowId);
  const previous = settings.file?.binaryId.split('.')[0];
  const file: EvaluationFile = { fileName: name, fileSize: bytes.length, format: parsed.format, rows: parsed.rows.length, columns: parsed.columns, uploadedAt: new Date().toISOString() };
  saveSettings(workflowId, { ...settings, file: { ...file, binaryId: ref.id! } });
  if (previous) await binary.deleteScope(previous).catch(() => 0);
  return file;
}

/** Remove the workflow's file dataset. */
export async function removeDatasetFile(workflowId: string): Promise<boolean> {
  const settings = getSettings(workflowId);
  if (!settings.file) return false;
  const scope = settings.file.binaryId.split('.')[0];
  const { file: _file, ...rest } = settings;
  saveSettings(workflowId, rest);
  await (await binaryStore()).deleteScope(scope).catch(() => 0);
  return true;
}

/** The workflow's file dataset, read and parsed. */
export async function readDatasetFile(workflowId: string): Promise<(ParsedDataset & { file: EvaluationFile }) | undefined> {
  const file = getSettings(workflowId).file;
  if (!file) return undefined;
  const opened = await (await binaryStore()).open(file.binaryId);
  if (!opened) throw new DatasetFileError(`The uploaded file “${file.fileName}” is missing from the binary store: upload it again`);
  const parsed = parseDatasetText((await readAll(opened.stream)).toString('utf8'), file.fileName);
  const { binaryId: _binaryId, ...meta } = file;
  return { ...parsed, file: meta };
}
