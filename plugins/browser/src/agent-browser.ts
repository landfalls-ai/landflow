/**
 * A thin, safe wrapper around Vercel's agent-browser CLI (https://github.com/vercel-labs/agent-browser).
 *
 * Pages are untrusted, so every call runs with an allow-list of domains (the CLI blocks the rest of the network and
 * refuses saved profiles and replayed state with it), page text wrapped in boundary markers and a length cap. The CLI
 * is started without a shell, one argument per word, so nothing a flow or a page says can become a command.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}
export type Exec = (args: string[], options: { timeoutMs: number }) => Promise<ExecResult>;

/** Runs the real CLI (`LANDFLOW_AGENT_BROWSER_BIN` overrides the name on PATH). */
export const execCli: Exec = (args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(process.env.LANDFLOW_AGENT_BROWSER_BIN || 'agent-browser', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException).code === 'number' ? ((error as NodeJS.ErrnoException).code as unknown as number) : 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr || (error && (error as Error).message) || ''), code });
    });
  });

export class BrowserError extends Error {
  constructor(message: string, readonly description?: string) {
    super(message);
  }
}

/** Domains as written by a user: comma, space or newline separated; `*.example.com` is allowed. */
export function parseDomains(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

const matches = (host: string, pattern: string) => (pattern.startsWith('*.') ? host === pattern.slice(2) || host.endsWith(pattern.slice(1)) : host === pattern);

/** Whether everything `request` allows is also allowed by `ceiling`: a wildcard request needs a wildcard ceiling that covers it. */
function within(request: string, ceiling: string): boolean {
  if (!request.startsWith('*.')) return matches(request, ceiling);
  if (!ceiling.startsWith('*.')) return false;
  const [r, c] = [request.slice(2), ceiling.slice(2)];
  return r === c || r.endsWith(`.${c}`);
}

/**
 * The allow-list for a call: what the node asks for, held inside the operator's ceiling (`LANDFLOW_BROWSER_ALLOWED_DOMAINS`)
 * when one is set. With none named it is the URL's own host (`defaultHost`); a call with no allow-list at all is refused rather than left open.
 */
export function effectiveDomains(requested: string[], ceiling: string[], defaultHost?: string): string[] {
  if (requested.length === 0) {
    // Nothing named: the page's own host, when the operator's ceiling (if any) allows it; else the ceiling itself.
    if (defaultHost && (!ceiling.length || ceiling.some((c) => matches(defaultHost, c)))) return [defaultHost];
    if (ceiling.length) return ceiling;
    throw new BrowserError('No allowed domains', 'Name the sites this node may visit in "Allowed Domains" (for example example.com, *.example.org), or give a URL so its own site is used. A browser with no allow-list is refused.');
  }
  if (ceiling.length) {
    const outside = requested.filter((d) => !ceiling.some((c) => within(d, c)));
    if (outside.length) throw new BrowserError(`Not allowed on this host: ${outside.join(', ')}`, `The operator limits browsing to ${ceiling.join(', ')} (LANDFLOW_BROWSER_ALLOWED_DOMAINS).`);
  }
  return requested;
}

/** The page address, which must be http or https and on the allow-list. */
export function checkUrl(raw: string, domains: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserError(`Not a URL: ${raw || '(empty)'}`, 'Give a full address such as https://example.com/page.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BrowserError(`Only http and https pages can be opened, not ${url.protocol}`);
  if (!domains.some((d) => matches(url.hostname.toLowerCase(), d))) throw new BrowserError(`${url.hostname} is not an allowed domain`, `Allowed: ${domains.join(', ')}.`);
  return url;
}

export const EXTRACT_ACTIONS = ['getText', 'getValue', 'getAttr'] as const;
export type StepAction = 'getText' | 'getValue' | 'getAttr' | 'click' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'hover' | 'scroll' | 'wait' | 'back' | 'reload';
export interface Step {
  action: StepAction;
  /** A ref from a snapshot (`@e3`) or a selector. */
  target?: string;
  text?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  pixels?: number;
  ms?: number;
  /** Extract steps: the key under `results`. */
  name?: string;
  /** getAttr: the attribute to read. */
  attr?: string;
}

export const isExtract = (action: string) => (EXTRACT_ACTIONS as readonly string[]).includes(action);

/** Words people (and models) use for a step's parts, mapped to ours. Any other field is an error, so a typo is not silently dropped. */
const TARGET_KEYS = ['target', 'selector', 'ref', 'element'];
const TEXT_KEYS = ['text', 'value', 'option'];
const MS_KEYS = ['ms', 'milliseconds', 'durationMs'];
const STEP_KEYS = new Set(['action', 'key', 'direction', 'pixels', 'seconds', 'name', 'attr', ...TARGET_KEYS, ...TEXT_KEYS, ...MS_KEYS]);

/** A step as written, with the aliases resolved to `target`, `text` and `ms`. */
export function normalizeStep(raw: unknown): Step {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BrowserError('Each step must be an object', 'For example {"action":"click","target":"#send"}.');
  const step = raw as Record<string, unknown>;
  const action = String(step.action ?? '');
  const unknown = Object.keys(step).filter((k) => !STEP_KEYS.has(k));
  if (unknown.length) throw new BrowserError(`Step "${action}" has an unknown field: ${unknown.join(', ')}`, 'Fields are action, target (or selector), text (or value), key, direction, pixels, ms (or milliseconds, seconds), and for Extract name and attr.');
  const pick = (keys: string[]) => keys.map((k) => step[k]).find((v) => v !== undefined && v !== null && v !== '');
  const target = pick(TARGET_KEYS);
  const text = pick(TEXT_KEYS);
  const ms = pick(MS_KEYS);
  return {
    action: action as StepAction,
    ...(target !== undefined && { target: String(target) }),
    ...(text !== undefined && { text: String(text) }),
    ...(step.key !== undefined && { key: String(step.key) }),
    ...(step.direction !== undefined && { direction: step.direction as Step['direction'] }),
    ...(step.pixels !== undefined && { pixels: Number(step.pixels) }),
    ...(step.name !== undefined && step.name !== '' && { name: String(step.name) }),
    ...(step.attr !== undefined && step.attr !== '' && { attr: String(step.attr) }),
    ...(ms !== undefined ? { ms: Number(ms) } : step.seconds !== undefined ? { ms: Number(step.seconds) * 1000 } : {}),
  };
}

const NEEDS_TARGET = new Set<StepAction>(['getText', 'getValue', 'getAttr', 'click', 'fill', 'type', 'select', 'check', 'uncheck', 'hover']);

/** The CLI words for one step. Only these actions exist: no eval, upload, download, cookies or network control. */
export function stepArgs(input: Step | Record<string, unknown>): string[] {
  const step = normalizeStep(input);
  const a = step.action;
  if (!['getText', 'getValue', 'getAttr', 'click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll', 'wait', 'back', 'reload'].includes(a)) {
    throw new BrowserError(`Unknown step "${String(a)}"`, 'Use click, fill, type, press, select, check, uncheck, hover, scroll, wait, back, reload, or getText, getValue, getAttr to extract.');
  }
  if (NEEDS_TARGET.has(a) && !step.target) throw new BrowserError(`Step "${a}" needs a target`, 'Use a ref from a snapshot (@e3) or a selector.');
  switch (a) {
    case 'getText':
      return ['get', 'text', step.target!];
    case 'getValue':
      return ['get', 'value', step.target!];
    case 'getAttr':
      if (!step.attr) throw new BrowserError('Step "getAttr" needs an attribute', 'Name it in "attr", for example href.');
      return ['get', 'attr', step.target!, step.attr];
    case 'fill':
    case 'type':
    case 'select':
      if (step.text === undefined) throw new BrowserError(`Step "${a}" needs text`);
      return [a, step.target!, step.text];
    case 'press':
      if (!step.key) throw new BrowserError('Step "press" needs a key', 'For example Enter, Tab or Control+a.');
      return ['press', step.key];
    case 'scroll':
      return ['scroll', step.direction ?? 'down', ...(step.pixels ? [String(Math.round(step.pixels))] : [])];
    case 'wait':
      return ['wait', String(Math.max(0, Math.min(Math.round(step.ms ?? 1000), 30_000)))];
    case 'back':
    case 'reload':
      return [a];
    default:
      return [a, step.target!];
  }
}

/**
 * Extracted text comes back fenced by the CLI (`--content-boundaries`) in a marker with a random nonce. The value a flow
 * reads is the text inside; the fence stays on everything else (the snapshot). The text is still untrusted page content.
 */
export function unfence(text: string): string {
  const m = /^--- AGENT_BROWSER_PAGE_CONTENT nonce=(\S+)[^\n]*---\n([\s\S]*)\n--- END_AGENT_BROWSER_PAGE_CONTENT nonce=\1 ---$/.exec(text.trim());
  return m ? m[2] : text;
}

export interface SessionOptions {
  domains: string[];
  headed: boolean;
  maxOutput: number;
  timeoutMs: number;
  exec?: Exec;
}

/** One isolated browser session; `close()` always runs, even when a step fails. */
export class BrowserSession {
  readonly name = `lf-${randomUUID().slice(0, 8)}`;
  private readonly exec: Exec;
  constructor(private readonly options: SessionOptions) {
    this.exec = options.exec ?? execCli;
  }

  private globals(): string[] {
    return [
      '--session', this.name,
      '--allowed-domains', this.options.domains.join(','),
      '--content-boundaries',
      '--max-output', String(this.options.maxOutput),
      ...(this.options.headed ? ['--headed'] : []),
    ];
  }

  async run(args: string[]): Promise<string> {
    const { stdout, stderr, code } = await this.exec([...this.globals(), ...args], { timeoutMs: this.options.timeoutMs });
    if (code !== 0) {
      const text = (stderr || stdout).trim();
      if (/ENOENT|command not found/i.test(text) && !text.includes('\n')) throw new BrowserError('agent-browser is not installed', 'Install it with `npm i -g agent-browser` (or `brew install agent-browser`), then `agent-browser install`.');
      throw new BrowserError(`agent-browser ${args[0]} failed`, text.slice(0, 600) || `exit code ${code}`);
    }
    return stdout.trim();
  }

  async close(): Promise<void> {
    try {
      await this.exec(['--session', this.name, 'close'], { timeoutMs: 15_000 });
    } catch {
      // Nothing to clean up if the browser never started.
    }
  }
}
