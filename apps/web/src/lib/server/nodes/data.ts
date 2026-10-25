import vm from 'node:vm';
import { defineNode, NodeOperationError, type JsonObject, type NodeItem } from '@landflow/sdk';
import { variables } from '../variables';

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
        out.push({ json: base as JsonObject, pairedItem: { item: i } });
      }
    });
    return [out];
  },
});

export const codeNode = defineNode({
  description: {
    name: 'code',
    displayName: 'Code',
    description: 'Run JavaScript over the items',
    version: 1,
    kind: 'action',
    categories: ['Data'],
    icon: 'lucide:code-xml',
    color: '#eab308',
    subtitle: '{{mode}}',
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'mode',
        displayName: 'Mode',
        type: 'options',
        default: 'all',
        options: [
          { name: 'Run once for all items', value: 'all' },
          { name: 'Run once for each item', value: 'each' },
        ],
      },
      {
        name: 'code',
        displayName: 'JavaScript',
        type: 'code',
        typeOptions: { language: 'javascript', rows: 12 },
        noDataExpression: true,
        default:
          '// `items` = input items, each { json }. Return an array of items or plain objects.\nreturn items.map((item, i) => ({\n  ...item.json,\n  index: i,\n  processedAt: new Date().toISOString(),\n}));',
        displayOptions: { show: { mode: ['all'] } },
      },
      {
        name: 'codeEach',
        displayName: 'JavaScript',
        type: 'code',
        typeOptions: { language: 'javascript', rows: 12 },
        noDataExpression: true,
        default: '// `$json` = this item’s data. Return an object.\nreturn { ...$json, length: JSON.stringify($json).length };',
        displayOptions: { show: { mode: ['each'] } },
      },
    ],
  },
  execute(ctx) {
    const items = ctx.getInputData();
    const $vars = Object.freeze(variables.record());
    const logs: string[] = [];
    const console = { log: (...args: unknown[]) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) };
    const run = (source: string, scope: Record<string, unknown>) => {
      // $vars: the instance variables, read-only (Settings → Variables).
      const context = vm.createContext({ ...scope, $vars, console });
      try {
        return new vm.Script(`(function () {\n${source}\n})()`, { filename: 'code-node.js' }).runInContext(context, { timeout: 2_000 });
      } catch (error) {
        throw new NodeOperationError(`Code error: ${(error as Error).message}`);
      }
    };
    const toItems = (result: unknown): NodeItem[] => {
      const list = Array.isArray(result) ? result : result === undefined ? [] : [result];
      return list.map((entry) =>
        entry && typeof entry === 'object' && 'json' in entry ? (entry as NodeItem) : { json: (typeof entry === 'object' && entry !== null ? entry : { value: entry }) as JsonObject },
      );
    };
    let output: NodeItem[];
    if (ctx.getNodeParameter('mode') === 'each') {
      output = items.flatMap((item, i) =>
        toItems(run(ctx.getNodeParameter<string>('codeEach'), { $json: structuredClone(item.json), $itemIndex: i, items })).map((o) => ({ ...o, pairedItem: { item: i } })),
      );
    } else {
      output = toItems(run(ctx.getNodeParameter<string>('code'), { items: structuredClone(items), $input: { all: () => items, first: () => items[0] } }));
    }
    logs.forEach((line) => ctx.logger.info(line));
    // Results cross the vm realm boundary; normalize to plain JSON.
    return [JSON.parse(JSON.stringify(output)) as NodeItem[]];
  },
});

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
    properties: [
      {
        name: 'method',
        displayName: 'Method',
        type: 'options',
        default: 'GET',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ name: m, value: m })),
      },
      { name: 'url', displayName: 'URL', type: 'string', default: 'http://127.0.0.1:3000/api/health', required: true },
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
        name: 'body',
        displayName: 'JSON Body',
        type: 'json',
        default: '',
        displayOptions: { show: { method: ['POST', 'PUT', 'PATCH', 'DELETE'] } },
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
        ],
      },
    ],
  },
  async execute(ctx) {
    const out: NodeItem[] = [];
    const items = ctx.getInputData();
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      const pairs = (key: string, group: string) =>
        Object.fromEntries(
          (ctx.getNodeParameter<Record<string, Array<{ name: string; value: string }>>>(key, i)?.[group] ?? [])
            .filter((p) => p.name)
            .map((p) => [p.name, String(p.value ?? '')]),
        );
      const options = ctx.getNodeParameter<{ timeoutMs?: number; fullResponse?: boolean; splitArray?: boolean }>('options', i) ?? {};
      let body = ctx.getNodeParameter<unknown>('body', i);
      if (typeof body === 'string' && body.trim()) {
        try {
          body = JSON.parse(body);
        } catch {
          // send as raw text
        }
      } else if (typeof body === 'string') body = undefined;

      const response = await ctx.helpers.httpRequest({
        url: String(ctx.getNodeParameter('url', i)),
        method: String(ctx.getNodeParameter('method', i)),
        query: pairs('query', 'parameter'),
        headers: pairs('headers', 'header'),
        body,
        timeoutMs: options.timeoutMs,
      });
      if (response.status >= 400) {
        throw new NodeOperationError(`HTTP ${response.status}`, {
          itemIndex: i,
          description: typeof response.body === 'string' ? response.body.slice(0, 500) : JSON.stringify(response.body).slice(0, 500),
        });
      }
      if (options.fullResponse) {
        out.push({ json: { status: response.status, headers: response.headers, body: response.body as never }, pairedItem: { item: i } });
      } else if (Array.isArray(response.body) && options.splitArray !== false) {
        for (const entry of response.body) out.push({ json: (typeof entry === 'object' && entry ? entry : { value: entry }) as JsonObject, pairedItem: { item: i } });
      } else if (response.body && typeof response.body === 'object') {
        out.push({ json: response.body as JsonObject, pairedItem: { item: i } });
      } else {
        out.push({ json: { data: response.body as never }, pairedItem: { item: i } });
      }
    }
    return [out];
  },
});
