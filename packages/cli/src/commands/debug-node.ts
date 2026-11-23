/**
 * `debug-node`: run ONE node of a recorded execution against a plugin build served on your machine (the one-node local
 * override, docs/specs/19-debug-token.md). It mints a single-use `runs:debug` token with your own key, bound to that
 * execution and node, and spends it at once on `POST /api/debug-node`: the host calls `--plugin-url` with the node's recorded
 * input and resolved parameters (never credentials) and returns the result, tagged as a debug run. Nothing is written to the
 * execution. Needs an owner to have turned the override on in the Local node override card of the Debug access dialog (Run Trace page) and to have allowed the plugin's host.
 */
import { Client, seg } from '../client';
import { flag, type Command } from '../command';
import { CliError, usage } from '../errors';
import { fields } from '../output';
import { parseTtl } from './debug-token';

interface Minted {
  token: string;
  record: { id: string; nodeName?: string; expiresAt: string };
}

interface DebugResult {
  debugRun: true;
  status: 'success' | 'error';
  node: string;
  nodeType?: string;
  pluginHost?: string;
  inputItems?: number;
  outputItems?: number[];
  output?: unknown[];
  error?: { message: string; description?: string };
  nodeLogs?: Array<{ level: string; message: string }>;
  recorded?: { status: string };
  notRecorded?: string;
}

export const debugNode: Command = {
  name: 'debug-node',
  summary: 'Run one node of a recorded execution against a plugin on your machine (a debug run, not recorded)',
  usage: '<execution id> <node name or id> --plugin-url http://localhost:PORT [--ttl 15m]',
  details:
    'The host calls your plugin (its /landflow/v1/execute) with the input the node had in that recorded run and its resolved\n' +
    'parameters, never its credentials ($vars read “[redacted]”). The result comes back tagged as a debug run and is NOT written\n' +
    'to the execution. It uses a single-use runs:debug token the command mints with your key and spends at once.\n' +
    'It works only when an owner has turned “Local node override” on in the Local node override card of the Debug access dialog (Run Trace page) AND listed the host of --plugin-url\n' +
    '(a tunnel you open, or localhost when the host runs on your machine); the host never reaches out on its own.\n' +
    'You need the right to run the workflow, not only to read it. Every use is in the audit log (debug.node.run).',
  flags: {
    'plugin-url': flag.string('Where your plugin is served (the host appends /landflow/v1/execute)', 'url'),
    ttl: flag.string('How long the one-use token lives if unused: 90s, 15m, 1h (default 15m, at most 1h)', 'duration'),
  },
  args: { min: 2, max: 2 },
  async run(ctx) {
    const [execution, node] = ctx.args;
    const pluginUrl = ctx.flags['plugin-url'] === undefined ? undefined : String(ctx.flags['plugin-url']);
    if (!pluginUrl) throw usage('Name your plugin: --plugin-url http://localhost:PORT');
    const ttlSeconds = ctx.flags.ttl === undefined ? undefined : parseTtl(String(ctx.flags.ttl));
    if (ttlSeconds !== undefined && ttlSeconds > 3600) throw usage('--ttl is at most 1 hour for a debug-run token');

    const base = `/api/executions/${seg(execution)}/debug-tokens`;
    const minted = await ctx.client.post<Minted>(base, { scopes: ['runs:debug'], node, label: 'debug-node (CLI)', ...(ttlSeconds !== undefined && { ttlSeconds }) });
    if (!minted.token) throw new CliError('server_error', 'The host answered without a token');
    // The token is the credential for the run, not the CLI's key: the host checks it is bound to this execution and node.
    const asToken = new Client(ctx.connection.url, minted.token, ctx.io.fetch);
    let result: DebugResult;
    try {
      result = (await asToken.request<DebugResult>('POST', '/api/debug-node', { body: { executionId: execution, node, pluginUrl }, accept: [502] })).body;
    } catch (caught) {
      // A refused call leaves the token unspent: close it rather than leave it live.
      await ctx.client.delete(`${base}/${seg(minted.record.id)}`).catch(() => undefined);
      throw caught;
    }
    return {
      data: { ...result, tokenId: minted.record.id },
      exitCode: result.status === 'error' ? 1 : 0,
      human: () =>
        [
          `DEBUG RUN (not recorded): “${result.node}” of ${execution} on ${result.pluginHost ?? new URL(pluginUrl).host}`,
          fields([
            ['status', result.status],
            ['recorded run', result.recorded?.status ?? '?'],
            ['input items', result.inputItems ?? '?'],
            ['output items', (result.outputItems ?? []).join(', ') || '0'],
          ]),
          ...(result.error ? ['', `error: ${result.error.message}${result.error.description ? `\n${result.error.description}` : ''}`] : []),
          ...(result.output?.length ? ['', 'output:', JSON.stringify(result.output, null, 2)] : []),
          ...(result.nodeLogs?.length ? ['', 'logs:', ...result.nodeLogs.map((l) => `  [${l.level}] ${l.message}`)] : []),
          '',
          result.notRecorded ?? 'Not stored in the execution.',
        ].join('\n'),
    };
  },
};

export const debugNodeCommands = [debugNode];
