/**
 * `harness watch codex` (C05, C08): runs Codex and tells Landflow when a provider limit stops one of its turns. See
 * `./harness/rollout-watch.ts` for what is read and what is sent (one `quota_blocked` event, nothing else).
 *
 * `harness detect`: which coding harnesses of the registry (`@landflow/protocol/harnesses`, C15) are on this machine. A
 * harness is installed when one of its binaries is on PATH or one of its config files exists; the version is whatever
 * `<binary> --version` prints within 2 seconds. Nothing leaves the machine: no request to the host, no network, and no
 * connection needed, so it works before `landflow auth login`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { HARNESS_REGISTRY, type HarnessEntry } from '@landflow/protocol/harnesses';
import type { Command, Io } from '../command';
import { CliError, usage } from '../errors';
import { watchRollouts, type QuotaBlockedEvent } from '../harness/rollout-watch';
import { table } from '../output';

/** How long `--version` may take before the binary counts as installed with an unknown version. */
const VERSION_TIMEOUT_MS = 2_000;

export interface DetectedHarness {
  id: string;
  label: string;
  installed: boolean;
  /** `binary` (found on PATH) or `config file`; absent when not installed. */
  foundBy?: 'binary' | 'config file';
  path?: string;
  version?: string;
  /** How Landflow can see the harness (the registry's strategy). */
  strategy: string;
}

function onPath(name: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? '').split(delimiter).filter(Boolean)) {
    const file = join(dir, name);
    try {
      if (statSync(file).isFile()) {
        accessSync(file, constants.X_OK);
        return file;
      }
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/** The first dotted version in the first line `<file> --version` prints, or undefined (it failed, hung or printed none). */
function versionOf(file: string, env: Record<string, string | undefined>): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawn(file, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], env: env as NodeJS.ProcessEnv });
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Resolve at the timeout without waiting for the pipe to close: a child of the binary may hold it open.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(undefined);
    }, VERSION_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (out.length < 4_096) out += chunk.toString();
    });
    child.on('error', () => finish(undefined));
    child.on('close', () => finish(out.split('\n')[0]?.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0]));
  });
}

const expand = (file: string, home: string) => (file.startsWith('~/') ? join(home, file.slice(2)) : file);

async function detectOne(entry: HarnessEntry, io: Io): Promise<DetectedHarness> {
  const base = { id: entry.id, label: entry.label, strategy: entry.strategy };
  for (const name of entry.detect.binaries) {
    const file = onPath(name, io.env.PATH);
    if (file) {
      const version = await versionOf(file, io.env);
      return { ...base, installed: true, foundBy: 'binary', path: file, ...(version && { version }) };
    }
  }
  for (const config of entry.detect.configFiles) {
    const file = expand(config, io.home);
    if (existsSync(file)) return { ...base, installed: true, foundBy: 'config file', path: file };
  }
  return { ...base, installed: false };
}

const detectCommands: Command[] = [
  {
    name: 'harness detect',
    summary: 'List the coding harnesses installed on this machine (Claude Code, Codex, Cursor and more)',
    details: 'Looks for each harness’s binary on PATH or its config file, and reads the version with `<binary> --version` (cut at 2 seconds). Nothing is sent anywhere.',
    async run({ io }) {
      const harnesses = await Promise.all(HARNESS_REGISTRY.filter((h) => h.detect.binaries.length || h.detect.configFiles.length).map((h) => detectOne(h, io)));
      return {
        data: { harnesses },
        human: () =>
          table(
            harnesses,
            [
              { label: 'harness', value: (h) => h.label },
              { label: 'installed', value: (h) => h.installed },
              { label: 'version', value: (h) => h.version },
              { label: 'found', value: (h) => h.foundBy },
              { label: 'status', value: (h) => (h.strategy === 'mcp-only' ? 'MCP only' : 'live status') },
            ],
            'No harnesses known.',
          ),
      };
    },
  },
];

// ---- harness watch codex ----

/** A running harness: when it ends, and how to stop it. */
export interface HarnessChild {
  /** Resolves with the exit code when the process ends (127 when the program is not there). */
  exit: Promise<number>;
  stop(): void;
}

/** The CLI's Io, optionally with the program starter (tests pass a fake one; the real CLI runs the binary with the terminal). */
export type WatchIo = Io & { startHarness?: (binary: string, args: string[], env: Record<string, string | undefined>, cwd: string) => HarnessChild };

/** Runs the program on this terminal: its input and output are the person's own, and Ctrl-C is for the program, which then exits. */
function startOnTerminal(binary: string, args: string[], env: Record<string, string | undefined>, cwd: string): HarnessChild {
  const child: ChildProcess = spawn(binary, args, { stdio: 'inherit', env: env as NodeJS.ProcessEnv, cwd });
  // The terminal sends Ctrl-C to the whole group: the program handles it and exits, and the watch then finishes its last read.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  const exit = new Promise<number>((resolve) => {
    child.on('error', (error) => resolve((error as { code?: string }).code === 'ENOENT' ? 127 : 1));
    child.on('close', (code, signal) => resolve(code ?? (signal ? 130 : 1)));
  }).finally(() => process.off('SIGINT', ignore));
  return { exit, stop: () => void child.kill('SIGTERM') };
}

/** Codex's sessions folder: `$CODEX_HOME/sessions`, else `~/.codex/sessions`. */
const sessionsDir = (io: Io) => join(io.env.CODEX_HOME?.trim() || join(io.home, '.codex'), 'sessions');

const WATCH_SCOPE = 'harness:write';

const watchCommands: Command[] = [
  {
    name: 'harness watch',
    summary: 'Run Codex and tell Landflow when a provider limit stops a turn (status only)',
    usage: 'codex [-- <codex args>]',
    details:
      'Starts `codex` with your terminal and watches the rollout files of the sessions it starts (under $CODEX_HOME/sessions, default ~/.codex/sessions). When a turn ends on a usage limit or because credits ran out, one Blocked event goes to Landflow with the session id, the kind of limit and the provider’s message. No prompt, tool output or path is read out of the files or sent. Needs an API key with the harness:write scope (landflow auth login, or LANDFLOW_API_KEY). Arguments after -- go to codex.',
    args: { min: 1 },
    async run(ctx) {
      const [which, ...passed] = ctx.args;
      if (which !== 'codex') throw usage(`Only Codex is watched: landflow harness watch codex (got "${which}")`);
      if (!ctx.connection.apiKey) throw new CliError('unauthorized', `The watch reports to Landflow with an API key that has the ${WATCH_SCOPE} scope: run \`landflow auth login\` or set LANDFLOW_API_KEY`);
      const io = ctx.io as WatchIo;
      const dir = sessionsDir(io);
      let refused = false;
      const post = async (event: QuotaBlockedEvent) => {
        if (refused) return;
        try {
          await ctx.client.request('POST', '/api/harness/codex/hooks', { body: event, accept: [204] });
        } catch (error) {
          if (error instanceof CliError && (error.code === 'forbidden' || error.code === 'unauthorized')) {
            refused = true;
            ctx.note(`Landflow refused the report: the key needs the ${WATCH_SCOPE} scope (Settings → API keys). The watch goes on without reporting.`);
            return;
          }
          if (error instanceof CliError && error.code === 'not_supported') {
            refused = true;
            ctx.note('This Landflow has no Codex status route (an older host): the watch goes on without reporting.');
            return;
          }
          throw error;
        }
      };
      ctx.note(`Watching Codex sessions in ${dir} for provider limits. Only a Blocked event is sent: no prompts, tool output or paths.`);
      // Files made before this moment are never read: the watch covers the sessions it starts.
      const watch = watchRollouts({ dir, since: Date.now(), post, onGiveUp: () => ctx.note('Could not reach Landflow to report a Blocked turn.') });
      const child = (io.startHarness ?? startOnTerminal)('codex', passed, io.env, io.cwd);
      const code = await child.exit;
      await watch.stop();
      if (code === 127) throw new CliError('not_found', 'codex is not on PATH: install Codex first (landflow harness detect)');
      return { data: { harness: 'codex', sessionsDir: dir, exitCode: code, reported: watch.delivered }, human: () => (watch.delivered ? `Reported ${watch.delivered} Blocked turn${watch.delivered === 1 ? '' : 's'} to Landflow.` : ''), exitCode: code };
    },
  },
];

export const harnessCommands: Command[] = [...detectCommands, ...watchCommands];
