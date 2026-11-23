/**
 * A thin, safe wrapper around the `dot-agent-deck` CLI (https://github.com/dot-agent-deck, read at commit 720a5f05).
 *
 * The deck is called, never copied: every call is `execFile` with one argument per word (no shell), the task text goes on
 * stdin (`--task-file -`, the deck's shell-safe path, at most 1 MiB), and the plugin never runs `trust approve`: a person
 * approves an orchestration. The CLI refuses outside a deck pane (`DOT_AGENT_DECK_PANE_ID`), so this plugin must be
 * started from one; without it every call fails with a message that says so instead of hanging.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** What the deck itself accepts for `--task-file`. */
export const MAX_TASK_BYTES = 1024 * 1024;

export class DeckError extends Error {
  constructor(message: string, readonly description?: string) {
    super(message);
  }
}

export interface DeckRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** The binary: `LANDFLOW_DECK_BIN`, else `dot-agent-deck` on PATH. Read at call time. */
export const deckBinary = (): string => process.env.LANDFLOW_DECK_BIN || 'dot-agent-deck';

/** Whether this process runs inside a deck pane (the deck puts its pane id in the environment). */
export const inPane = (env: NodeJS.ProcessEnv = process.env): boolean => Boolean(env.DOT_AGENT_DECK_PANE_ID);

const NOT_IN_PANE = new DeckError(
  'run the deck plugin from a deck pane',
  'The deck\'s dispatch and inbox commands only work from a process started inside one of its panes (DOT_AGENT_DECK_PANE_ID is set there). Open a pane in the deck and start the plugin in it: pnpm plugin:deck.',
);

/** Runs the deck. A missing binary is a DeckError; any other exit is returned for the caller to read. */
export function runDeck(args: string[], stdin?: string, timeoutMs = 15_000): Promise<DeckRun> {
  return new Promise((resolve, reject) => {
    const child = execFile(deckBinary(), args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') return reject(new DeckError('dot-agent-deck not found on PATH', `Install the deck, or set LANDFLOW_DECK_BIN to its binary (looked for "${deckBinary()}").`));
      resolve({ code: error ? (typeof code === 'number' ? code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (error && error.message) || '') });
    });
    // A deck that exits before reading stdin must not crash the plugin with EPIPE.
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin ?? '');
  });
}

/** Whether the deck binary runs, for the plugin's start-up warning. */
export async function checkDeck(): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
  try {
    const run = await runDeck(['--version'], undefined, 5_000);
    return run.code === 0 ? { ok: true, version: run.stdout.trim() } : { ok: false, reason: (run.stderr || run.stdout).trim().slice(0, 300) };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

export interface DispatchInput {
  name: string;
  task: string;
  agent?: string;
  command?: string;
  dir?: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const AGENT = /^[a-z][a-z0-9-]{0,30}$/;

/** `LANDFLOW_DECK_ALLOW_COMMAND`: a flow may choose the command a unit starts with only when the person who runs the plugin says so. */
const commandsAllowed = () => /^(1|true|yes)$/i.test(process.env.LANDFLOW_DECK_ALLOW_COMMAND ?? '');

/** The arguments of one dispatch, checked. Nothing here reaches a shell. */
export function dispatchArgs(input: DispatchInput): string[] {
  if (!NAME.test(input.name)) throw new DeckError(`Not a usable unit name: ${JSON.stringify(input.name)}`, 'Use 1-40 lowercase letters, digits and dashes, starting with a letter or digit. The name becomes the unit\'s tab, worktree and branch.');
  if (!input.task.trim()) throw new DeckError('The task is empty', 'Say what the unit should do in "Task".');
  if (Buffer.byteLength(input.task, 'utf8') > MAX_TASK_BYTES) throw new DeckError('The task is over 1 MiB', 'The deck takes at most 1 MiB of task text.');
  const args = ['dispatch', input.name, '--task-file', '-'];
  if (input.agent) {
    if (!AGENT.test(input.agent)) throw new DeckError(`Not a usable agent name: ${JSON.stringify(input.agent)}`, 'Name one of the deck\'s agents: claude, opencode, pi, codex or devin.');
    args.push('--agent', input.agent);
  }
  if (input.command) {
    if (!commandsAllowed()) throw new DeckError('Choosing a unit\'s command is off: set LANDFLOW_DECK_ALLOW_COMMAND=1 on the plugin', 'Set LANDFLOW_DECK_ALLOW_COMMAND=1 where the plugin runs to let a flow pick the command a unit starts with. It runs as you, on this machine.');
    if (input.command.length > 2000) throw new DeckError('The command is too long');
    args.push('--command', input.command);
  }
  if (input.dir) {
    if (!isAbsolute(input.dir)) throw new DeckError('Directory must be an absolute path', 'The deck starts the unit in an existing directory; give its full path.');
    let isDir = false;
    try {
      isDir = statSync(input.dir).isDirectory();
    } catch {
      // handled below
    }
    if (!isDir) throw new DeckError(`Directory does not exist: ${input.dir}`);
    args.push('--dir', input.dir);
  }
  return args;
}

/**
 * Starts a unit. Exit 0 means the daemon admitted the request (the deck says the worktree and the unit may still fail
 * afterwards; that outcome arrives in the inbox). A refusal, a trust refusal included, is the node's error with the
 * deck's own words, so the `approve` command it names reaches the person.
 */
export async function dispatch(input: DispatchInput): Promise<{ admitted: true; message: string }> {
  const args = dispatchArgs(input);
  if (!inPane()) throw NOT_IN_PANE;
  const run = await runDeck(args, input.task, 30_000);
  if (run.code !== 0) {
    const text = (run.stderr || run.stdout).trim();
    const first = text.split('\n')[0].replace(/^Error:\s*/, '').slice(0, 300);
    throw new DeckError(first || `dot-agent-deck dispatch exited ${run.code}`, text.slice(0, 1500));
  }
  return { admitted: true, message: run.stdout.trim() };
}

/** One message of the deck's inbox as `inbox fetch --json` prints it. */
export interface DeckMessage {
  id: string;
  subject: string;
  from: string;
  text: string;
}

/** Takes the messages waiting for this pane (the deck hands each over once). */
export async function fetchInbox(): Promise<DeckMessage[]> {
  if (!inPane()) throw NOT_IN_PANE;
  const run = await runDeck(['inbox', 'fetch', '--json']);
  if (run.code !== 0) throw new DeckError('Could not read the deck inbox', (run.stderr || run.stdout).trim().slice(0, 600));
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout.trim().split('\n').pop() ?? '');
  } catch {
    throw new DeckError('The deck inbox answer was not JSON');
  }
  const messages = (parsed as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) throw new DeckError('The deck inbox answer had no messages list');
  return messages.map((m) => ({ id: String(m?.id ?? ''), subject: String(m?.subject ?? ''), from: String(m?.from ?? ''), text: String(m?.text ?? '') }));
}
