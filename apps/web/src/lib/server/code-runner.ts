/**
 * The Code node's sandbox: the code runner service (services/code-runner), called over HTTP with a shared secret.
 *
 *   LANDFLOW_CODE_RUNNER_URL      http://127.0.0.1:53300 (the Docker runner from the Mac), http://code-runner:7300 (in compose)
 *   LANDFLOW_CODE_RUNNER_SECRET   the runner's CODE_RUNNER_SECRET
 *   LANDFLOW_CODE_IN_PROCESS      `false`: no in-process JavaScript (node:vm) on this host at all
 *   LANDFLOW_CODE_BINARY_MAX_BYTES  files a Code node reads (all together) and creates, either path (default 6 MiB)
 *
 * Read on every run. With a runner configured the sandbox is the default for JavaScript; Python always needs it.
 */
import { NodeOperationError, type TracedFetch } from '@landflow/sdk';
import type { Language, RunError, RunRequest, RunResponse } from '@landflow/code-runner/protocol';

export type { Language, RunRequest, RunResponse };

/** protocol.ts's SECRET_HEADER (a type-only import keeps the runner package out of the host bundle). */
const SECRET_HEADER = 'x-landflow-runner-secret';
const DOCS = 'see docs/deployment.md, "Code runner"';

export interface CodeRunnerSettings {
  /** Without a trailing slash; undefined when no runner is configured. */
  url?: string;
  secret?: string;
  /** In-process JavaScript allowed (LANDFLOW_CODE_IN_PROCESS isn't `false`). */
  inProcess: boolean;
  /** How long the host waits for an answer (the runner's own timeout is shorter). */
  timeoutMs: number;
  /** Bytes of files the code reads or creates (`this.helpers`), each way; the runner applies its own cap too. */
  binaryMaxBytes: number;
}

export function codeRunnerSettings(env: NodeJS.ProcessEnv = process.env): CodeRunnerSettings {
  const url = env.LANDFLOW_CODE_RUNNER_URL?.trim().replace(/\/+$/, '');
  const timeout = Number(env.LANDFLOW_EXECUTE_TIMEOUT_MS);
  const binaryMax = Number(env.LANDFLOW_CODE_BINARY_MAX_BYTES);
  return {
    ...(url && { url }),
    ...(env.LANDFLOW_CODE_RUNNER_SECRET && { secret: env.LANDFLOW_CODE_RUNNER_SECRET }),
    inProcess: !['false', '0', 'off', 'no'].includes((env.LANDFLOW_CODE_IN_PROCESS ?? '').trim().toLowerCase()),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
    binaryMaxBytes: Number.isFinite(binaryMax) && binaryMax > 0 ? binaryMax : 6 * 1024 * 1024,
  };
}

export type Placement = 'sandbox' | 'inProcess';

/**
 * Where a Code node runs: `runIn` is the node's "Run In" (`auto`, `sandbox`, `inProcess`). Throws the error the user
 * sees when the choice can't be honoured on this host.
 */
export function placeCode(language: Language, runIn: string, settings: CodeRunnerSettings): Placement {
  const missing = (what: string) =>
    new NodeOperationError(`${what} needs the code runner, and this host has none`, {
      description: `Start the code runner and set LANDFLOW_CODE_RUNNER_URL and LANDFLOW_CODE_RUNNER_SECRET on the host (${DOCS}).`,
    });
  if (language === 'python') {
    if (!settings.url) throw missing('Python code');
    return 'sandbox';
  }
  if (runIn === 'sandbox') {
    if (!settings.url) throw missing('Run In: Sandbox');
    return 'sandbox';
  }
  if (runIn === 'inProcess' || !settings.url) {
    if (!settings.inProcess) {
      throw new NodeOperationError('In-process code is disabled on this host (LANDFLOW_CODE_IN_PROCESS=false)', {
        description: settings.url ? 'Set Run In to Sandbox or Default.' : `Configure the code runner to run code (${DOCS}).`,
      });
    }
    return 'inProcess';
  }
  return 'sandbox';
}

const STRING = String.raw`(['"\x60])((?:\\.|(?!\1).)*)\1`;

/**
 * The node names `code` looks up, so the request carries only those outputs: `$('Name')`, `$node['Name']`,
 * `$node.Name` (JavaScript) or `_('Name')` (Python). A lookup by a computed name sends every output.
 */
export function nodesReferenced(code: string, language: Language, available: string[]): string[] {
  const call = language === 'python' ? String.raw`(?<![\w$.])_\(\s*` : String.raw`(?<![\w$.])\$\(\s*`;
  const computed =
    new RegExp(`${call}(?![\\s'"\`)])`).test(code) ||
    (language === 'javascript' && (/\$node\[\s*(?![\s'"`])/.test(code) || /(?<![\w$.])\$\(\s*`[^`]*\$\{/.test(code)));
  if (computed) return available;
  const names = new Set<string>();
  const patterns = [new RegExp(`${call}${STRING}\\s*\\)`, 'g')];
  if (language === 'javascript') patterns.push(new RegExp(String.raw`\$node\[\s*${STRING}\s*\]`, 'g'), /\$node\.([A-Za-z_$][\w$]*)/g);
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const name = match.length > 2 ? match[2].replace(/\\(.)/g, '$1') : match[1];
      if (available.includes(name)) names.add(name);
    }
  }
  return [...names];
}

/** Whether the code reads input files, so the host loads their bytes (JavaScript and Python helper names). */
export function readsBinary(code: string): boolean {
  return /getBinaryDataBuffer|get_binary_data_buffer/.test(code);
}

/** n8n's format: "TypeError: x is not a function [line 3, for item 1]"; limits keep their own message. */
export function codeErrorMessage(error: RunError): string {
  if (error.kind !== 'error' && error.kind !== 'syntax') return error.message;
  const where = [error.line !== undefined && `line ${error.line}`, error.itemIndex !== undefined && `for item ${error.itemIndex}`].filter(Boolean).join(', ');
  return `${error.name ?? 'Error'}: ${error.message}${where ? ` [${where}]` : ''}`;
}

/** POST /v1/run. Transport and runner problems throw NodeOperationError; a failed snippet comes back as `ok: false`. */
export async function runInSandbox(
  settings: CodeRunnerSettings,
  request: RunRequest,
  options: { fetch?: TracedFetch; signal?: AbortSignal } = {},
): Promise<RunResponse> {
  if (!settings.url) throw new NodeOperationError('No code runner is configured (LANDFLOW_CODE_RUNNER_URL)');
  if (!settings.secret) throw new NodeOperationError('LANDFLOW_CODE_RUNNER_SECRET is not set', { description: `It must match the runner's CODE_RUNNER_SECRET (${DOCS}).` });
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${settings.url}/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: settings.secret },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timeout.aborted) throw new NodeOperationError(`The code runner didn't answer within ${settings.timeoutMs / 1000} s`);
    const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
    throw new NodeOperationError(`Can't reach the code runner at ${settings.url}`, { description: cause?.code ?? cause?.message ?? (error as Error).message });
  }
  if (response.status === 200) return (await response.json()) as RunResponse;
  const detail = await response
    .json()
    .then((body: { error?: string }) => body.error ?? '')
    .catch(() => '');
  if (response.status === 401) {
    throw new NodeOperationError('The code runner rejected this host’s secret', { description: `LANDFLOW_CODE_RUNNER_SECRET must match the runner's CODE_RUNNER_SECRET (${DOCS}).` });
  }
  if (response.status === 503) throw new NodeOperationError('The code runner is busy; try again shortly', { description: detail });
  throw new NodeOperationError(`The code runner answered HTTP ${response.status}`, { description: detail });
}
