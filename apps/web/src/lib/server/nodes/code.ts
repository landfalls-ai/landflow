/**
 * Code node: JavaScript or Python over the items, in n8n's two modes ("Run once for all items" / "for each item").
 *
 * Where it runs ("Run In", JavaScript only):
 * - **Sandbox**: the code runner service (services/code-runner, `LANDFLOW_CODE_RUNNER_URL`), a fresh locked-down
 *   process per run. JavaScript on Node with n8n's globals (`$input`, `$json`, `$('Node')`, `$vars`, `$execution`,
 *   `$now`/`DateTime`), Python on CPython with `_input`, `_json`, `_('Node')`, … Python always runs here.
 * - **In-process**: `node:vm` inside the host, the original behaviour, with the same globals (no Luxon) and `this.helpers`. Not a security boundary; off with
 *   `LANDFLOW_CODE_IN_PROCESS=false`.
 * - **Default**: the sandbox when a runner is configured, else in-process.
 *
 * Files: `$input.item.binary` is the items' file metadata; `this.helpers.getBinaryDataBuffer(itemIndex, name)` reads one
 * (Python: `_helpers.get_binary_data_buffer`) and `this.helpers.prepareBinaryData(buffer, fileName, mimeType)` makes
 * one for `{ json, binary: { data } }`. In-process they use the context's helpers (the host's binary store); the sandbox
 * has no network, so the host sends the bytes of the input files with the request (`binary`) and stores the files the
 * snippet returns as base64. Either way `LANDFLOW_CODE_BINARY_MAX_BYTES` caps what is read and created.
 */
import vm from 'node:vm';
import { legacyNodeData, nodeAccessor } from '@landflow/engine';
import { mimeTypeFromFileName, type BinaryRef } from '@landflow/protocol';
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';
import { codeErrorMessage, codeRunnerSettings, nodesReferenced, placeCode, readsBinary, runInSandbox, type CodeRunnerSettings, type Language } from '../code-runner';
import { instanceTimezone } from '../settings';
import { variables } from '../variables';

const main = [{ type: 'main' as const }];

type Mode = 'all' | 'each';

/** The parameter holding the code for a language and mode. */
const CODE_PARAMETER: Record<Language, Record<Mode, string>> = {
  javascript: { all: 'code', each: 'codeEach' },
  python: { all: 'pythonCode', each: 'pythonCodeEach' },
};

const editor = (language: Language, mode: Mode, fallback: string) => ({
  name: CODE_PARAMETER[language][mode],
  displayName: language === 'python' ? 'Python' : 'JavaScript',
  type: 'code' as const,
  typeOptions: { language, rows: 12 },
  noDataExpression: true,
  default: fallback,
  displayOptions: { show: { language: [language], mode: [mode] } },
});

export const codeNode = defineNode({
  description: {
    name: 'code',
    displayName: 'Code',
    description: 'Run JavaScript or Python over the items',
    version: 1,
    kind: 'action',
    categories: ['Data'],
    icon: 'lucide:code-xml',
    color: '#eab308',
    subtitle: '{{mode}}',
    keywords: ['javascript', 'python', 'script', 'function'],
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'language',
        displayName: 'Language',
        type: 'options',
        default: 'javascript',
        noDataExpression: true,
        options: [
          { name: 'JavaScript', value: 'javascript' },
          { name: 'Python', value: 'python', description: 'CPython, standard library only; runs in the sandbox (needs the code runner)' },
        ],
      },
      {
        name: 'mode',
        displayName: 'Mode',
        type: 'options',
        default: 'all',
        options: [
          { name: 'Run once for all items', value: 'all', description: 'One run with every item in `items`: to combine, count or sort them' },
          { name: 'Run once for each item', value: 'each', description: 'One run per item, with that item as `$json`: it can’t see the other items' },
        ],
      },
      {
        name: 'runIn',
        displayName: 'Run In',
        type: 'options',
        default: 'auto',
        noDataExpression: true,
        description: 'The sandbox is a separate, locked-down process (the code runner); in-process code shares the host and is not isolated',
        displayOptions: { show: { language: ['javascript'] } },
        options: [
          { name: 'Default (the sandbox when a code runner is configured)', value: 'auto' },
          { name: 'Sandbox (code runner)', value: 'sandbox' },
          { name: 'In-process (not isolated)', value: 'inProcess' },
        ],
      },
      editor(
        'javascript',
        'all',
        '// `items` = input items, each { json }. Return an array of items or plain objects.\nreturn items.map((item, i) => ({\n  ...item.json,\n  index: i,\n  processedAt: new Date().toISOString(),\n}));',
      ),
      editor('javascript', 'each', '// `$json` = this item’s data. Return an object.\nreturn { ...$json, length: JSON.stringify($json).length };'),
      editor(
        'python',
        'all',
        "# _input.all() = the input items, each {'json': {...}}. Return a list of items or plain dicts.\nreturn [{**item.json, 'index': i} for i, item in enumerate(_input.all())]",
      ),
      editor('python', 'each', "# _json = this item's data. Return a dict.\nreturn {**_json, 'length': len(str(_json))}"),
    ],
  },
  async execute(ctx) {
    const language: Language = ctx.getNodeParameter<string>('language', 0, 'javascript') === 'python' ? 'python' : 'javascript';
    const mode: Mode = ctx.getNodeParameter('mode') === 'each' ? 'each' : 'all';
    const settings = codeRunnerSettings();
    if (placeCode(language, ctx.getNodeParameter<string>('runIn', 0, 'auto'), settings) === 'inProcess') return runInProcess(ctx, mode, settings);
    return runSandboxed(ctx, language, mode, settings);
  },
});

const mebibytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;

/** The bytes of the input items' files for the sandbox, up to the cap; later files get the reason they're missing. */
async function inputFiles(ctx: IExecuteContext, limit: number) {
  const binary: Record<string, string> = {};
  const skipped: Record<string, string> = {};
  let total = 0;
  for (const [index, item] of ctx.getInputData().entries()) {
    for (const [name, ref] of Object.entries(item.binary ?? {})) {
      if (!ref || typeof ref !== 'object') continue;
      const key = `${index}:${name}`;
      const size = Number(ref.fileSize) || (ref.data ? Buffer.byteLength(ref.data, 'base64') : 0);
      if (total + size > limit) {
        skipped[key] = `The file "${name}" of item ${index} (${size} bytes) is over the Code node's ${mebibytes(limit)} limit for files it reads (LANDFLOW_CODE_BINARY_MAX_BYTES)`;
        continue;
      }
      const bytes = ref.data !== undefined && !ref.id ? Buffer.from(ref.data, 'base64') : await ctx.helpers.binaryToBuffer(ref);
      total += bytes.byteLength;
      binary[key] = bytes.toString('base64');
    }
  }
  return { binary, skipped };
}

/** Files the snippet created come back inline (base64); store them through the host's helpers. */
async function storeCreatedFiles(ctx: IExecuteContext, items: NodeItem[], limit: number): Promise<void> {
  let total = 0;
  for (const item of items) {
    for (const [name, ref] of Object.entries(item.binary ?? {}) as Array<[string, BinaryRef]>) {
      if (!ref || typeof ref !== 'object' || ref.id || typeof ref.data !== 'string') continue;
      const bytes = Buffer.from(ref.data, 'base64');
      total += bytes.byteLength;
      if (total > limit) throw new NodeOperationError(`The files the code created are over the ${mebibytes(limit)} limit (LANDFLOW_CODE_BINARY_MAX_BYTES)`);
      const stored = await ctx.helpers.prepareBinaryData(bytes, ref.fileName, ref.mimeType || mimeTypeFromFileName(ref.fileName));
      item.binary![name] = { ...stored, ...(ref.fileExtension && { fileExtension: ref.fileExtension }) };
    }
  }
}

async function runSandboxed(ctx: IExecuteContext, language: Language, mode: Mode, settings: CodeRunnerSettings): Promise<NodeItem[][]> {
  const code = ctx.getNodeParameter<string>(CODE_PARAMETER[language][mode]) ?? '';
  const outputs = ctx.getNodeOutputs?.() ?? {};
  const files = readsBinary(code) ? await inputFiles(ctx, settings.binaryMaxBytes) : undefined;
  const response = await runInSandbox(
    settings,
    {
      language,
      mode,
      code,
      items: ctx.getInputData(),
      nodeOutputs: Object.fromEntries(nodesReferenced(code, language, Object.keys(outputs)).map((name) => [name, outputs[name]])),
      // $vars / _vars: the workflow's project variables over the instance's, read-only (Settings → Variables).
      variables: variables.forWorkflow(ctx.getWorkflowId()),
      execution: { id: ctx.getExecutionId(), mode: ctx.getMode() },
      workflow: { id: ctx.getWorkflowId() },
      node: { name: ctx.getNode().name },
      timezone: instanceTimezone(),
      maxBinaryBytes: settings.binaryMaxBytes,
      ...(files && { binary: files.binary, binarySkipped: files.skipped }),
    },
    { fetch: ctx.http, signal: ctx.signal },
  );
  for (const log of response.logs) ctx.logger[log.level](log.message);
  if (!response.ok) throw new NodeOperationError(codeErrorMessage(response.error), { description: response.error.stack, itemIndex: response.error.itemIndex });
  const items = response.items as NodeItem[];
  await storeCreatedFiles(ctx, items, settings.binaryMaxBytes);
  return [items];
}

/** The original Code node: JavaScript in a `node:vm` context of the host process. */
async function runInProcess(ctx: IExecuteContext, mode: Mode, settings: CodeRunnerSettings): Promise<NodeItem[][]> {
  const items = ctx.getInputData();
  const outputs = ctx.getNodeOutputs?.() ?? {};
  const limit = settings.binaryMaxBytes;
  const logs: string[] = [];
  const console = { log: (...args: unknown[]) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) };
  let current = 0;
  // The globals both paths share (the sandbox adds Luxon): $input, $('Node'), $node, $vars, $execution, $workflow, $now.
  const shared = {
    console,
    Buffer,
    // $vars: the workflow's variables over the instance's, read-only (Settings → Variables).
    $vars: Object.freeze(variables.forWorkflow(ctx.getWorkflowId())),
    $input: nodeAccessor(undefined, items, () => current),
    $: (name: string) => nodeAccessor(name, Object.hasOwn(outputs, name) ? outputs[name] : undefined, () => current),
    $node: Object.fromEntries(Object.entries(outputs).map(([name, list]) => [name, legacyNodeData(list)])),
    $execution: { id: ctx.getExecutionId(), mode: ctx.getMode() },
    $workflow: { id: ctx.getWorkflowId() },
    $now: new Date(),
    $today: new Date(new Date().toDateString()),
    $runIndex: 0,
  };
  // `this` in the snippet, as in n8n: `this.helpers.getBinaryDataBuffer(i, 'data')`, `this.helpers.prepareBinaryData(…)`.
  let created = 0;
  const self = {
    helpers: {
      assertBinaryData: (itemIndex: number, propertyName = 'data') => ctx.helpers.assertBinaryData(itemIndex, propertyName),
      async getBinaryDataBuffer(itemIndex: number, propertyName = 'data') {
        const ref = ctx.helpers.assertBinaryData(itemIndex, propertyName);
        if (Number(ref.fileSize) > limit) throw new NodeOperationError(`The file "${propertyName}" of item ${itemIndex} (${ref.fileSize} bytes) is over the Code node's ${mebibytes(limit)} limit for files it reads (LANDFLOW_CODE_BINARY_MAX_BYTES)`);
        return ctx.helpers.getBinaryDataBuffer(itemIndex, propertyName);
      },
      async prepareBinaryData(data: unknown, fileName?: string, mimeType?: string) {
        let bytes: Buffer;
        if (typeof data === 'string') bytes = Buffer.from(data);
        else if (ArrayBuffer.isView(data)) bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        else if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') bytes = Buffer.from(data as ArrayBuffer);
        else throw new NodeOperationError('prepareBinaryData needs a Buffer, Uint8Array, ArrayBuffer or string');
        created += bytes.byteLength;
        if (created > limit) throw new NodeOperationError(`The files the code created are over the ${mebibytes(limit)} limit (LANDFLOW_CODE_BINARY_MAX_BYTES)`);
        return ctx.helpers.prepareBinaryData(bytes, fileName, mimeType);
      },
    },
  };
  // The wrapper is async so `await this.helpers…` works; the 2 s timeout covers the synchronous part of the run.
  const run = async (source: string, scope: Record<string, unknown>) => {
    const context = vm.createContext({ ...shared, ...scope });
    try {
      const snippet = new vm.Script(`(async function () {\n${source}\n})`, { filename: 'code-node.js' }).runInContext(context, { timeout: 2_000 }) as () => Promise<unknown>;
      return await snippet.call(self);
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
  let output: NodeItem[] = [];
  if (mode === 'each') {
    for (const [i, item] of items.entries()) {
      current = i;
      const result = await run(ctx.getNodeParameter<string>('codeEach'), { $json: structuredClone(item.json), $itemIndex: i, item: structuredClone(item), items });
      output.push(...toItems(result).map((o) => ({ ...o, pairedItem: { item: i } })));
    }
  } else {
    output = toItems(await run(ctx.getNodeParameter<string>('code'), { items: structuredClone(items), $json: structuredClone(items[0]?.json ?? {}), $itemIndex: 0 }));
  }
  logs.forEach((line) => ctx.logger.info(line));
  // Results cross the vm realm boundary; normalize to plain JSON.
  return [JSON.parse(JSON.stringify(output)) as NodeItem[]];
}
