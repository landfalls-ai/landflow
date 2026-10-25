import { defineNode, NodeOperationError, type JsonObject, type NodeItem } from '@landflow/sdk';
import { BODY_METHODS, executeHttpRequest, httpAuthCredentials, httpAuthProperties } from './http-request';

const main = [{ type: 'main' as const }];

interface FieldAssignment {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'json';
  value?: unknown;
}

function coerce(field: FieldAssignment): unknown {
  const { value } = field;
  switch (field.type) {
    case 'number':
      return typeof value === 'number' ? value : Number(value);
    case 'boolean':
      return value === true || value === 'true';
    case 'json':
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        throw new NodeOperationError(`Field "${field.name}" is not valid JSON`);
      }
    default:
      return typeof value === 'string' ? value : value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/** Dot-path set: "user.address.city". */
function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split('.');
  let cursor = target;
  keys.slice(0, -1).forEach((key) => {
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  });
  cursor[keys[keys.length - 1]] = value;
}

export const setNode = defineNode({
  description: {
    name: 'set',
    displayName: 'Edit Fields',
    description: 'Add, overwrite or build item fields — supports {{ expressions }}',
    version: 1,
    kind: 'action',
    categories: ['Data'],
    icon: 'lucide:pencil-line',
    color: '#14b8a6',
    subtitle: '{{mode}}',
    keywords: ['set', 'map', 'transform'],
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'mode',
        displayName: 'Mode',
        type: 'options',
        default: 'manual',
        options: [
          { name: 'Manual mapping', value: 'manual' },
          { name: 'JSON', value: 'json' },
        ],
      },
      {
        name: 'fields',
        displayName: 'Fields to Set',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { values: [{ name: 'greeting', type: 'string', value: 'Hello {{ $json.name ?? "world" }}' }] },
        displayOptions: { show: { mode: ['manual'] } },
        groups: [
          {
            name: 'values',
            displayName: 'Field',
            values: [
              { name: 'name', displayName: 'Name', type: 'string', default: '', placeholder: 'user.email' },
              {
                name: 'type',
                displayName: 'Type',
                type: 'options',
                default: 'string',
                options: ['string', 'number', 'boolean', 'json'].map((t) => ({ name: t, value: t })),
              },
              { name: 'value', displayName: 'Value', type: 'string', default: '' },
            ],
          },
        ],
      },
      {
        name: 'json',
        displayName: 'JSON',
        type: 'json',
        default: '{\n  "items": [1, 2, 3]\n}',
        displayOptions: { show: { mode: ['json'] } },
      },
      {
        name: 'includeOtherFields',
        displayName: 'Keep Other Fields',
        type: 'boolean',
        default: true,
        description: 'Keep the incoming item’s fields alongside the new ones',
      },
      {
        name: 'splitArray',
        displayName: 'Split Array Into Items',
        type: 'string',
        default: '',
        placeholder: 'items',
        description: 'If set, emit one item per element of this array field',
      },
    ],
  },
  execute(ctx) {
    const out: NodeItem[] = [];
    ctx.getInputData().forEach((item, i) => {
      const base: Record<string, unknown> = ctx.getNodeParameter<boolean>('includeOtherFields', i) ? structuredClone(item.json) : {};
      if (ctx.getNodeParameter('mode', i) === 'json') {
        const raw = ctx.getNodeParameter<unknown>('json', i);
        let parsed: unknown = raw;
        if (typeof raw === 'string') {
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            throw new NodeOperationError(`Invalid JSON: ${(error as Error).message}`, { itemIndex: i });
          }
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new NodeOperationError('JSON must be an object', { itemIndex: i });
        }
        Object.assign(base, parsed);
      } else {
        const fields = ctx.getNodeParameter<{ values?: FieldAssignment[] }>('fields', i)?.values ?? [];
        for (const field of fields) if (field.name) setPath(base, field.name, coerce(field));
      }
      const split = ctx.getNodeParameter<string>('splitArray', i);
      if (split) {
        const list = base[split];
        if (!Array.isArray(list)) throw new NodeOperationError(`"${split}" is not an array`, { itemIndex: i });
        for (const entry of list) {
          out.push({ json: (typeof entry === 'object' && entry !== null ? entry : { value: entry }) as JsonObject, pairedItem: { item: i } });
        }
      } else {
        out.push({ json: base as JsonObject, ...(item.binary && { binary: item.binary }), pairedItem: { item: i } });
      }
    });
    return [out];
  },
});

/** The Code node lives in ./code (JavaScript or Python, in-process or in the sandboxed code runner). */
export { codeNode } from './code';

export const httpRequestNode = defineNode({
  description: {
    name: 'httpRequest',
    displayName: 'HTTP Request',
    description: 'Call any HTTP API',
    version: 1,
    kind: 'action',
    categories: ['Core'],
    icon: 'lucide:globe',
    color: '#3b82f6',
    subtitle: '{{method}} {{url}}',
    usableAsTool: true,
    toolDescription: 'Make an HTTP request. Arguments: `url` (required), `method`, and optionally `body` (JSON).',
    inputs: main,
    outputs: main,
    credentials: httpAuthCredentials,
    properties: [
      {
        name: 'method',
        displayName: 'Method',
        type: 'options',
        default: 'GET',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ name: m, value: m })),
      },
      { name: 'url', displayName: 'URL', type: 'string', default: 'http://127.0.0.1:3000/api/health', required: true },
      ...httpAuthProperties,
      {
        name: 'query',
        displayName: 'Query Parameters',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        groups: [{ name: 'parameter', displayName: 'Parameter', values: [{ name: 'name', displayName: 'Name', type: 'string', default: '' }, { name: 'value', displayName: 'Value', type: 'string', default: '' }] }],
      },
      {
        name: 'headers',
        displayName: 'Headers',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        groups: [{ name: 'header', displayName: 'Header', values: [{ name: 'name', displayName: 'Name', type: 'string', default: '' }, { name: 'value', displayName: 'Value', type: 'string', default: '' }] }],
      },
      {
        name: 'bodyType',
        displayName: 'Body Content Type',
        type: 'options',
        default: 'json',
        noDataExpression: true,
        displayOptions: { show: { method: BODY_METHODS } },
        options: [
          { name: 'JSON', value: 'json' },
          { name: 'Form-Data (Multipart)', value: 'multipart', description: 'Text fields and files' },
          { name: 'Binary File', value: 'binary', description: 'A file of the item as the raw body' },
        ],
      },
      {
        name: 'body',
        displayName: 'JSON Body',
        type: 'json',
        default: '',
        displayOptions: { show: { method: BODY_METHODS, bodyType: ['json'] } },
      },
      {
        name: 'binaryPropertyName',
        displayName: 'Input Binary Field',
        type: 'string',
        default: 'data',
        description: 'The item file to send (item.binary.<name>); its MIME type becomes the Content-Type',
        displayOptions: { show: { method: BODY_METHODS, bodyType: ['binary'] } },
      },
      {
        name: 'formData',
        displayName: 'Form Fields',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        placeholder: 'Add field',
        default: {},
        displayOptions: { show: { method: BODY_METHODS, bodyType: ['multipart'] } },
        groups: [
          {
            name: 'values',
            displayName: 'Field',
            values: [
              { name: 'name', displayName: 'Name', type: 'string', default: '' },
              { name: 'type', displayName: 'Type', type: 'options', default: 'text', options: [{ name: 'Text', value: 'text' }, { name: 'File', value: 'file' }] },
              { name: 'value', displayName: 'Value', type: 'string', default: '', displayOptions: { show: { type: ['text'] } } },
              { name: 'binaryPropertyName', displayName: 'Input Binary Field', type: 'string', default: 'data', displayOptions: { show: { type: ['file'] } } },
            ],
          },
        ],
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'timeoutMs', displayName: 'Timeout (ms)', type: 'number', default: 30000 },
          { name: 'fullResponse', displayName: 'Include Status & Headers', type: 'boolean', default: false },
          { name: 'splitArray', displayName: 'Split Array Response Into Items', type: 'boolean', default: true },
          {
            name: 'responseFormat',
            displayName: 'Response Format',
            type: 'options',
            default: 'autodetect',
            options: [
              { name: 'Autodetect', value: 'autodetect', description: 'JSON, text, or a file for other content types (PDF, images…)' },
              { name: 'File', value: 'file', description: 'Store the response as a file (binary data)' },
              { name: 'JSON', value: 'json' },
              { name: 'Text', value: 'text' },
            ],
          },
          { name: 'outputPropertyName', displayName: 'Put Output File in Field', type: 'string', default: 'data', description: 'A file response goes to item.binary.<name>' },
        ],
      },
    ],
  },
  // Bodies with files and file responses: ./http-request.ts.
  execute: (ctx) => executeHttpRequest(ctx),
});
