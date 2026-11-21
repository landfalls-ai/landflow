/**
 * `harness detect`: which coding harnesses of the registry (`@landflow/protocol/harnesses`, C15) are on this machine. A
 * harness is installed when one of its binaries is on PATH or one of its config files exists; the version is whatever
 * `<binary> --version` prints within 2 seconds. Nothing leaves the machine: no request to the host, no network, and no
 * connection needed, so it works before `landflow auth login`.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { HARNESS_REGISTRY, type HarnessEntry } from '@landflow/protocol/harnesses';
import type { Command, Io } from '../command';
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

export const harnessCommands: Command[] = [
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
