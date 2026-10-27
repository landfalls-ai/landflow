/**
 * The landflow CLI: `run(argv, io)` parses the arguments, runs one command and prints its result — a table or text
 * for people, or with `--json` exactly one JSON document on stdout:
 *
 *   success  { "ok": true, ...the command's data }                       exit 0
 *   failure  { "ok": false, "error": { "code", "message", "status"?, "details"? } }   exit 1–7 (see errors.ts)
 *
 * `main.ts` wires it to the process; the tests call it in-process with a fake Io.
 */
import { describeFlags, parseArgs, type FlagSpecs } from './args';
import { Client } from './client';
import type { Command, Context, Io } from './command';
import { auditCommands } from './commands/audit';
import { authCommands } from './commands/auth';
import { dataCommands } from './commands/data';
import { envCommands } from './commands/env';
import { runCommands } from './commands/runs';
import { syncCommands } from './commands/sync';
import { transferCommands } from './commands/transfer';
import { workflowCommands } from './commands/workflows';
import { configPath, resolveConnection } from './config';
import { CliError, EXIT } from './errors';
import { VERSION } from './version';

export type { Io } from './command';
export { EXIT } from './errors';
export { VERSION } from './version';

export const COMMANDS: Command[] = [...authCommands, ...workflowCommands, ...runCommands, ...transferCommands, ...dataCommands, ...syncCommands, ...envCommands, ...auditCommands];

const GLOBAL_FLAGS: FlagSpecs = {
  json: { type: 'boolean', description: 'Print one JSON document (stable shapes; errors too)' },
  url: { type: 'string', description: 'The Landflow URL (else LANDFLOW_URL, the config file, http://localhost:3000)', placeholder: 'url' },
  'api-key': { type: 'string', description: 'The API key (else LANDFLOW_API_KEY, the config file)', placeholder: 'key' },
  help: { type: 'boolean', description: 'Show help', short: 'h' },
  version: { type: 'boolean', description: 'Show the version' },
};

const GROUPS: Record<string, string> = {
  workflows: 'Create, change, publish and delete workflows',
  executions: 'Inspect, retry and stop executions',
  'data-tables': 'Read data tables',
  variables: 'Manage variables',
  sync: 'Git sync: workflows as files in a directory',
  'source-control': 'The host’s own Git repository (Settings → Source control)',
  env: 'Environments: promote between environments’ branches, pull this one',
  audit: 'The audit log: verify its hash chain and signed heads, with or without the host',
};

/** Find the command in `tokens` (one or two words, global flags may come first) and drop its words. */
function locate(tokens: string[]): { command?: Command; group?: string; rest: string[]; words: string[] } {
  const words: Array<{ word: string; index: number }> = [];
  for (let i = 0; i < tokens.length && words.length < 2; i++) {
    const token = tokens[i];
    if (token === '--') break;
    if (token.startsWith('-') && token !== '-') {
      const spec = GLOBAL_FLAGS[token.replace(/^--?/, '').split('=')[0]] ?? Object.values(GLOBAL_FLAGS).find((s) => s.short && `-${s.short}` === token);
      if (spec?.type === 'string' && !token.includes('=')) i++;
      if (!spec) break;
      continue;
    }
    words.push({ word: token, index: i });
  }
  const drop = (n: number) => tokens.filter((_, i) => !words.slice(0, n).some((w) => w.index === i));
  const two = words.length === 2 ? COMMANDS.find((c) => c.name === `${words[0].word} ${words[1].word}`) : undefined;
  if (two) return { command: two, rest: drop(2), words: words.map((w) => w.word) };
  const one = words.length ? COMMANDS.find((c) => c.name === words[0].word) : undefined;
  if (one) return { command: one, rest: drop(1), words: words.map((w) => w.word) };
  if (words.length && GROUPS[words[0].word]) return { group: words[0].word, rest: drop(1), words: words.map((w) => w.word) };
  return { rest: tokens, words: words.map((w) => w.word) };
}

function commandHelp(command: Command): string {
  const flags = { ...command.flags, ...GLOBAL_FLAGS };
  const usage = `Usage: landflow ${command.name}${command.usage ? ` ${command.usage}` : ''}`;
  return [usage, '', command.summary + (command.details ? `\n\n${command.details}` : ''), '', 'Options:', describeFlags(flags)].join('\n');
}

function generalHelp(group?: string): string {
  const list = COMMANDS.filter((c) => !group || c.name.startsWith(`${group} `));
  const width = Math.max(...list.map((c) => c.name.length));
  const lines = list.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  const head = group
    ? `landflow ${group}: ${GROUPS[group]}\n\nCommands:`
    : `landflow ${VERSION}: the Landflow command line\n\nUsage: landflow <command> [options]   (landflow <command> --help for its options)\n\nCommands:`;
  return [head, ...lines, '', 'Global options:', describeFlags(GLOBAL_FLAGS), '', 'Exit codes: 0 ok, 1 error, 2 usage, 3 not found, 4 auth, 5 conflict, 6 network, 7 timeout.'].join('\n');
}

/** Run the CLI; resolves to the exit code. Never throws. */
export async function run(argv: string[], io: Io): Promise<number> {
  const json = argv.includes('--json') || argv.includes('--json=true');
  const print = (value: unknown) => io.stdout(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const { command, group, rest, words } = locate(argv);
    if (!command) {
      const parsed = parseArgs(rest, GLOBAL_FLAGS);
      if (parsed.flags.version && !words.length) {
        if (json) print({ ok: true, version: VERSION });
        else io.stdout(`${VERSION}\n`);
        return EXIT.ok;
      }
      const helpWanted = parsed.flags.help || words[0] === 'help' || (!words.length && !parsed.positionals.length);
      if (group && !parsed.positionals.length) {
        // `landflow workflows` alone: the group's commands.
        if (json) print({ ok: true, commands: COMMANDS.filter((c) => c.name.startsWith(`${group} `)).map((c) => ({ name: c.name, summary: c.summary, usage: c.usage ?? '' })) });
        else io.stdout(`${generalHelp(group)}\n`);
        return parsed.flags.help ? EXIT.ok : EXIT.usage;
      }
      if (helpWanted) {
        const target = words[0] === 'help' ? parsed.positionals.slice(1).join(' ') : '';
        const about = target ? COMMANDS.find((c) => c.name === target) : undefined;
        if (json) print({ ok: true, version: VERSION, commands: COMMANDS.map((c) => ({ name: c.name, summary: c.summary, usage: c.usage ?? '' })) });
        else io.stdout(`${about ? commandHelp(about) : generalHelp(GROUPS[target] ? target : undefined)}\n`);
        return EXIT.ok;
      }
      throw new CliError('usage', `Unknown command "${parsed.positionals.slice(0, 2).join(' ')}": see landflow --help`);
    }

    const parsed = parseArgs(rest, { ...GLOBAL_FLAGS, ...command.flags });
    if (parsed.flags.help) {
      if (json) print({ ok: true, command: { name: command.name, summary: command.summary, usage: command.usage ?? '', flags: Object.keys(command.flags ?? {}) } });
      else io.stdout(`${commandHelp(command)}\n`);
      return EXIT.ok;
    }
    const { min = 0, max = Infinity } = command.args ?? {};
    if (parsed.positionals.length < min) throw new CliError('usage', `Missing arguments: landflow ${command.name} ${command.usage ?? ''}`.trim());
    if (parsed.positionals.length > max) throw new CliError('usage', `Too many arguments: landflow ${command.name} ${command.usage ?? ''}`.trim());

    const connection = resolveConnection({ url: parsed.flags.url as string | undefined, apiKey: parsed.flags['api-key'] as string | undefined }, io.env, configPath(io.env, io.home));
    const ctx: Context = {
      args: parsed.positionals,
      flags: parsed.flags,
      io,
      json,
      connection,
      client: new Client(connection.url, connection.apiKey, io.fetch),
      note: (text) => {
        if (!json) io.stderr(`${text}\n`);
      },
    };
    const result = await command.run(ctx);
    if (json) print({ ok: true, ...result.data });
    else {
      const text = result.human();
      if (text) io.stdout(`${text}\n`);
    }
    return result.exitCode ?? EXIT.ok;
  } catch (caught) {
    const failure = caught instanceof CliError ? caught : new CliError('internal', `Unexpected error: ${(caught as Error)?.stack ?? String(caught)}`);
    if (json) print({ ok: false, error: failure.toJSON() });
    else io.stderr(`error: ${failure.message}\n`);
    return failure.exitCode;
  }
}
