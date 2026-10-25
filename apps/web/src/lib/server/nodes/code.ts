/**
 * Code node: JavaScript or Python over the items, in n8n's two modes ("Run once for all items" / "for each item").
 *
 * Where it runs ("Run In", JavaScript only):
 * - **Sandbox**: the code runner service (services/code-runner, `LANDFLOW_CODE_RUNNER_URL`), a fresh locked-down
 *   process per run. JavaScript on Node with n8n's globals (`$input`, `$json`, `$('Node')`, `$vars`, `$execution`,
 *   `$now`/`DateTime`), Python on CPython with `_input`, `_json`, `_('Node')`, … Python always runs here.
 * - **In-process**: `node:vm` inside the host, the original behaviour. Not a security boundary; off with
 *   `LANDFLOW_CODE_IN_PROCESS=false`.
 * - **Default**: the sandbox when a runner is configured, else in-process.
 */
import vm from 'node:vm';
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';
import { codeErrorMessage, codeRunnerSettings, nodesReferenced, placeCode, runInSandbox, type CodeRunnerSettings, type Language } from '../code-runner';
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
          { name: 'Run once for all items', value: 'all' },
          { name: 'Run once for each item', value: 'each' },
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
    if (placeCode(language, ctx.getNodeParameter<string>('runIn', 0, 'auto'), settings) === 'inProcess') return runInProcess(ctx, mode);
    return runSandboxed(ctx, language, mode, settings);
  },
});

async function runSandboxed(ctx: IExecuteContext, language: Language, mode: Mode, settings: CodeRunnerSettings): Promise<NodeItem[][]> {
  const code = ctx.getNodeParameter<string>(CODE_PARAMETER[language][mode]) ?? '';
  const outputs = ctx.getNodeOutputs?.() ?? {};
  const response = await runInSandbox(
    settings,
    {
      language,
      mode,
      code,
      items: ctx.getInputData(),
      nodeOutputs: Object.fromEntries(nodesReferenced(code, language, Object.keys(outputs)).map((name) => [name, outputs[name]])),
      // $vars / _vars: the instance variables, read-only (Settings → Variables).
      variables: variables.record(),
      execution: { id: ctx.getExecutionId(), mode: ctx.getMode() },
      workflow: { id: ctx.getWorkflowId() },
      node: { name: ctx.getNode().name },
      timezone: instanceTimezone(),
    },
    { fetch: ctx.http, signal: ctx.signal },
  );
  for (const log of response.logs) ctx.logger[log.level](log.message);
  if (!response.ok) throw new NodeOperationError(codeErrorMessage(response.error), { description: response.error.stack, itemIndex: response.error.itemIndex });
  return [response.items as NodeItem[]];
}

/** The original Code node: JavaScript in a `node:vm` context of the host process. */
function runInProcess(ctx: IExecuteContext, mode: Mode): NodeItem[][] {
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
  if (mode === 'each') {
    output = items.flatMap((item, i) =>
      toItems(run(ctx.getNodeParameter<string>('codeEach'), { $json: structuredClone(item.json), $itemIndex: i, items })).map((o) => ({ ...o, pairedItem: { item: i } })),
    );
  } else {
    output = toItems(run(ctx.getNodeParameter<string>('code'), { items: structuredClone(items), $input: { all: () => items, first: () => items[0] } }));
  }
  logs.forEach((line) => ctx.logger.info(line));
  // Results cross the vm realm boundary; normalize to plain JSON.
  return [JSON.parse(JSON.stringify(output)) as NodeItem[]];
}
