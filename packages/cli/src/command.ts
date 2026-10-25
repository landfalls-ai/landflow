/**
 * What a command is: a name (`workflows list`), its flags and positionals, and a `run` that returns the JSON payload
 * plus a function rendering it for people. `main` prints one or the other, so `--json` always prints exactly one
 * document: `{ "ok": true, ...data }`.
 */
import type { FlagSpecs, FlagValues } from './args';
import type { Client } from './client';
import type { Connection } from './config';

/** Everything a command touches outside itself, so tests can run the CLI in-process. */
export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
  /** stdin and stdout are terminals: prompts and confirmations are possible. */
  interactive: boolean;
  prompt(question: string, options?: { secret?: boolean }): Promise<string>;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
}

export interface Context {
  args: string[];
  flags: FlagValues;
  io: Io;
  json: boolean;
  connection: Connection;
  client: Client;
  /** A note for people on stderr (never mixed into `--json` output). */
  note(text: string): void;
}

export interface Result {
  data: Record<string, unknown>;
  human: () => string;
  /** Exit with this code although the command worked (`sync diff --exit-code`). */
  exitCode?: number;
}

export interface Command {
  name: string;
  summary: string;
  /** Positionals and notable flags for the usage line, e.g. `<workflow> [--wait]`. */
  usage?: string;
  /** More help text. */
  details?: string;
  flags?: FlagSpecs;
  args?: { min?: number; max?: number };
  run(ctx: Context): Promise<Result>;
}

export const flag = {
  string: (description: string, placeholder?: string, short?: string) => ({ type: 'string' as const, description, ...(placeholder && { placeholder }), ...(short && { short }) }),
  number: (description: string, placeholder = 'n') => ({ type: 'number' as const, description, placeholder }),
  boolean: (description: string, short?: string) => ({ type: 'boolean' as const, description, ...(short && { short }) }),
};
