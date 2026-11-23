/**
 * The file dataset of a workflow's evaluation: a CSV or JSON file kept in the binary store, read by an Evaluation Trigger whose
 * Dataset is "Uploaded file".
 *
 * GET → { file?, preview } (the metadata and the first rows); PUT — upload it (multipart with a `file` field, or the raw
 * CSV/JSON as the body with `?fileName=`); DELETE — remove it. Up to 10 MB.
 */
import { readDatasetFile, removeDatasetFile, saveDatasetFile } from '@/lib/server/evaluations';
import { MAX_DATASET_BYTES } from '@/lib/server/evaluations/files';
import { error, handler, json } from '@/lib/server/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const PREVIEW_ROWS = 5;

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  const dataset = await readDatasetFile(id);
  return json(dataset ? { file: dataset.file, preview: dataset.rows.slice(0, PREVIEW_ROWS) } : { preview: [] });
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  const length = Number(request.headers.get('content-length'));
  if (length > MAX_DATASET_BYTES + 64 * 1024) return error(`The file is larger than ${MAX_DATASET_BYTES / 1024 / 1024} MB`, 413);
  let bytes: Uint8Array;
  let fileName = new URL(request.url).searchParams.get('fileName') ?? request.headers.get('x-file-name') ?? '';
  if ((request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
    const file = (await request.formData()).get('file');
    if (!file || typeof file === 'string') return error('Send the file in the "file" field', 400);
    bytes = new Uint8Array(await file.arrayBuffer());
    fileName ||= file.name;
  } else {
    bytes = new Uint8Array(await request.arrayBuffer());
  }
  if (!bytes.length) return error('The file is empty', 400);
  return json({ file: await saveDatasetFile(id, bytes, fileName) }, 201);
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  return json({ removed: await removeDatasetFile(id) });
});
