/**
 * The HTTP Request node's request and response handling (its parameters are in data.ts). Bodies: JSON (the
 * default), multipart form data with text fields and item files, or one item file as the raw body. Responses:
 * JSON or text as before, or a file (`binary.data`) when "Response Format" is File, or when autodetect sees a
 * non-text Content-Type (a PDF, an image, octet-stream).
 */
import { baseMimeType, extensionFromMimeType, type JsonObject, type NodeItem } from '@landflow/protocol';
import { NodeOperationError, type IExecuteContext } from '@landflow/sdk';
import { dispositionFileName, isTextual, safeFileName } from '../binary/http';

export const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

export interface HttpRequestOptions {
  timeoutMs?: number;
  fullResponse?: boolean;
  splitArray?: boolean;
  /** autodetect (default) | file | json | text */
  responseFormat?: string;
  /** Where a file response goes (default `data`). */
  outputPropertyName?: string;
}

interface FormField {
  name?: string;
  type?: 'text' | 'file';
  value?: unknown;
  binaryPropertyName?: string;
}

/** Files up to this size are sent from memory, so the request gets a Content-Length (some servers require it). */
const BUFFERED_UPLOAD_BYTES = 16 * 1024 * 1024;

const hasHeader = (headers: Record<string, string>, name: string) => Object.keys(headers).some((key) => key.toLowerCase() === name);
const dropHeader = (headers: Record<string, string>, name: string) => {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name) delete headers[key];
};

/** The request body for item `i`; may set Content-Type in `headers`. */
async function requestBody(ctx: IExecuteContext, i: number, headers: Record<string, string>): Promise<BodyInit | undefined> {
  const bodyType = ctx.getNodeParameter<string>('bodyType', i, 'json') || 'json';
  if (bodyType === 'binary') {
    const name = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data').trim();
    const ref = ctx.helpers.assertBinaryData(i, name);
    if (!hasHeader(headers, 'content-type')) headers['content-type'] = ref.mimeType;
    return ref.fileSize <= BUFFERED_UPLOAD_BYTES ? new Uint8Array(await ctx.helpers.getBinaryDataBuffer(i, name)) : await ctx.helpers.getBinaryStream(i, name);
  }
  if (bodyType === 'multipart') {
    const form = new FormData();
    for (const field of ctx.getNodeParameter<{ values?: FormField[] }>('formData', i)?.values ?? []) {
      const key = String(field.name ?? '').trim();
      if (!key) continue;
      if (field.type === 'file') {
        const property = String(field.binaryPropertyName || 'data').trim();
        const ref = ctx.helpers.assertBinaryData(i, property);
        const bytes = await ctx.helpers.getBinaryDataBuffer(i, property);
        form.append(key, new Blob([new Uint8Array(bytes)], { type: ref.mimeType }), ref.fileName ?? `${property}.${ref.fileExtension ?? extensionFromMimeType(ref.mimeType) ?? 'bin'}`);
      } else form.append(key, typeof field.value === 'string' ? field.value : JSON.stringify(field.value ?? ''));
    }
    // fetch writes the multipart Content-Type with its boundary.
    dropHeader(headers, 'content-type');
    return form;
  }
  let body = ctx.getNodeParameter<unknown>('body', i);
  if (typeof body === 'string' && body.trim()) {
    const text = body;
    try {
      body = JSON.parse(text);
    } catch {
      return text; // send as raw text
    }
  } else if (typeof body === 'string' || body === undefined || body === null) return undefined;
  if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
  return JSON.stringify(body);
}

/** The last path segment of a URL, as a file name. */
function fileNameFromUrl(url: URL): string | undefined {
  const last = url.pathname.split('/').filter(Boolean).pop();
  try {
    return last ? safeFileName(decodeURIComponent(last)) : undefined;
  } catch {
    return safeFileName(last);
  }
}

export async function executeHttpRequest(ctx: IExecuteContext): Promise<NodeItem[][]> {
  const out: NodeItem[] = [];
  const items = ctx.getInputData();
  for (let i = 0; i < Math.max(items.length, 1); i++) {
    const pairs = (key: string, group: string) =>
      Object.fromEntries(
        (ctx.getNodeParameter<Record<string, Array<{ name: string; value: string }>>>(key, i)?.[group] ?? [])
          .filter((p) => p.name)
          .map((p) => [p.name, String(p.value ?? '')]),
      );
    const options = ctx.getNodeParameter<HttpRequestOptions>('options', i) ?? {};
    const method = String(ctx.getNodeParameter('method', i));
    const url = new URL(String(ctx.getNodeParameter('url', i)));
    for (const [key, value] of Object.entries(pairs('query', 'parameter'))) url.searchParams.set(key, value);
    const headers = pairs('headers', 'header');
    const body = BODY_METHODS.includes(method) ? await requestBody(ctx, i, headers) : undefined;
    const response = await ctx.http(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      ...(body instanceof ReadableStream && { duplex: 'half' }),
    } as RequestInit);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => (responseHeaders[key] = value));
    if (response.status >= 400) throw new NodeOperationError(`HTTP ${response.status}`, { itemIndex: i, description: (await response.text()).slice(0, 500) });

    const format = options.responseFormat || 'autodetect';
    const contentType = response.headers.get('content-type');
    if (format === 'file' || (format === 'autodetect' && method !== 'HEAD' && response.body && !isTextual(contentType))) {
      const fileName = dispositionFileName(response.headers.get('content-disposition')) ?? fileNameFromUrl(url);
      const mimeType = contentType && baseMimeType(contentType) !== 'application/octet-stream' ? contentType : undefined;
      const ref = await ctx.helpers.prepareBinaryData(response.body ?? new Uint8Array(), fileName, mimeType);
      const json: JsonObject = options.fullResponse ? { status: response.status, headers: responseHeaders } : {};
      out.push({ json, binary: { [String(options.outputPropertyName || 'data').trim() || 'data']: ref }, pairedItem: { item: i } });
      continue;
    }
    const text = await response.text();
    let parsed: unknown = text;
    if (format === 'json' || (format === 'autodetect' && (contentType ?? '').includes('json'))) {
      try {
        parsed = text ? JSON.parse(text) : text;
      } catch (error) {
        if (format === 'json') throw new NodeOperationError('The response isn’t valid JSON', { itemIndex: i, description: (error as Error).message });
      }
    }
    if (options.fullResponse) {
      out.push({ json: { status: response.status, headers: responseHeaders, body: parsed as never }, pairedItem: { item: i } });
    } else if (Array.isArray(parsed) && options.splitArray !== false) {
      for (const entry of parsed) out.push({ json: (typeof entry === 'object' && entry ? entry : { value: entry }) as JsonObject, pairedItem: { item: i } });
    } else if (parsed && typeof parsed === 'object') {
      out.push({ json: parsed as JsonObject, pairedItem: { item: i } });
    } else {
      out.push({ json: { data: parsed as never }, pairedItem: { item: i } });
    }
  }
  return [out];
}
