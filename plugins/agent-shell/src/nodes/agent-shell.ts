import { NodeOperationError, type IExecuteContext, type INodeType, type NodeDescriptor, type NodeItem } from '@landflow/sdk';
import { LIMITS, ShellError, runShell } from '../shell';

/** A string-to-string map from a JSON string, an object or nothing. */
function fileMap(value: unknown, what: string): Record<string, string> {
  if (value === undefined || value === null || value === '') return {};
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ShellError(`${what} is not valid JSON`);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ShellError(`${what} must be an object of file name to text`);
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(parsed as Record<string, unknown>)) out[name] = typeof text === 'string' ? text : JSON.stringify(text);
  return out;
}

export class AgentShell implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'agentShell',
    displayName: 'Agent Shell',
    description: 'Run a shell command in a simulated bash over an in-memory filesystem: no host files, no network',
    version: 1,
    kind: 'action',
    categories: ['Core', 'AI'],
    icon: 'file:agent-shell.svg',
    color: '#334155',
    subtitle: '{{command}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    outputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        exitCode: { type: 'number', description: '0 is success, 124 a timeout, 126 a limit was hit, 127 command not found' },
        stdoutTruncated: { type: 'boolean' },
        stderrTruncated: { type: 'boolean' },
        timedOut: { type: 'boolean' },
        files: {
          type: 'array',
          description: 'files this command created, changed or deleted: path, size, change, and small text contents',
          items: { type: 'object', properties: { path: { type: 'string' }, size: { type: 'number' }, change: { type: 'string' }, content: { type: 'string' } } },
        },
        persisted: { type: 'boolean', description: 'the filesystem is kept for later calls of this run' },
      },
    },
    usableAsTool: true,
    toolDescription:
      'Run a bash command (ls, cat, grep, sed, awk, jq, sort, wc, find, tar, sqlite3 and the like) on a private in-memory filesystem. Files you pass in `files` ({"name": "text"}) appear in the working directory, /home/user. There is no network, no internet and none of the host\'s files; there is no python or node. Nothing is kept between calls unless the node is set to keep files for the run. Output over its limit is cut.',
    toolInputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command or script to run' },
        files: {
          type: 'object',
          description: 'Files to put in the working directory first, file name to text content, for example {"data.csv": "a,b\\n1,2"}',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['command'],
    },
    properties: [
      { name: 'command', displayName: 'Command', type: 'string', default: 'ls -la', typeOptions: { rows: 4 }, description: 'Bash, run in /home/user. No network, no host files' },
      {
        name: 'files',
        displayName: 'Files (JSON)',
        type: 'json',
        default: '{}',
        description: 'Files written before the command runs: {"notes.txt": "text", "data/a.csv": "a,b"}. Names go under /home/user. Expressions like {{ $json.text }} work inside',
      },
      {
        name: 'useBinary',
        displayName: 'Include Input Files',
        type: 'boolean',
        default: true,
        description: "Also write the item's binary files (read as UTF-8 text) into the working directory, under their file names",
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'keepFiles', displayName: 'Keep Files for the Run', type: 'boolean', default: false, description: 'Keep the filesystem between calls of the same execution (for an agent that works in steps). Dropped after 30 minutes idle. Off: every call starts empty' },
          { name: 'timeoutSeconds', displayName: 'Time Limit (seconds)', type: 'number', default: LIMITS.defaultTimeoutMs / 1000, description: `Up to ${LIMITS.maxTimeoutMs / 1000}` },
          { name: 'maxOutputKb', displayName: 'Max Output (KB)', type: 'number', default: LIMITS.defaultMaxOutputChars / 1000, description: 'stdout and stderr are each cut at this size' },
          { name: 'maxFilesystemMb', displayName: 'Max Filesystem (MB)', type: 'number', default: LIMITS.defaultMaxFsBytes / 1024 / 1024, description: `All files together, up to ${LIMITS.maxFsBytes / 1024 / 1024}. A kept filesystem over this is dropped` },
        ],
      },
    ],
  };

  async execute(ctx: IExecuteContext) {
    const items = ctx.getInputData();
    const out: NodeItem[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const options = ctx.getNodeParameter<Record<string, unknown>>('options', i, {});
        const command = String(ctx.getNodeParameter('command', i, ''));
        // A tool call puts its arguments in the item; they win over the parameters.
        const files = fileMap(items[i].json.files ?? ctx.getNodeParameter('files', i, '{}'), 'Files');
        if (ctx.getNodeParameter<boolean>('useBinary', i, true)) {
          for (const [property, ref] of Object.entries(items[i].binary ?? {})) {
            if ((ref.fileSize ?? 0) > LIMITS.maxSeedBytes) throw new ShellError(`The file ${property} is too big to seed (${ref.fileSize} bytes)`);
            const name = ref.fileName || property;
            files[name] ??= (await ctx.helpers.getBinaryDataBuffer(i, property)).toString('utf8');
          }
        }
        const result = await runShell({
          command,
          files,
          timeoutMs: options.timeoutSeconds ? Number(options.timeoutSeconds) * 1000 : undefined,
          maxOutputChars: options.maxOutputKb ? Number(options.maxOutputKb) * 1000 : undefined,
          maxFsBytes: options.maxFilesystemMb ? Number(options.maxFilesystemMb) * 1024 * 1024 : undefined,
          persistKey: options.keepFiles ? ctx.getExecutionId() : undefined,
        });
        out.push({ json: { command, ...result }, pairedItem: { item: i } });
      } catch (error) {
        if (!(error instanceof ShellError)) throw error;
        if (ctx.continueOnFail()) out.push({ json: { error: error.message }, pairedItem: { item: i } });
        else throw new NodeOperationError(error.message, { itemIndex: i });
      }
    }
    return [out];
  }
}
