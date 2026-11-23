/**
 * `landflow harness detect` (C15 FR-7, AS-6): which harnesses of the registry are installed (a binary on PATH or a config
 * file), their version from `<bin> --version` bound to 2 seconds, and no network.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Io } from '../src/command';
import { run } from '../src/index';

const scratch = mkdtempSync(join(tmpdir(), 'landflow-harness-detect-'));
const bin = join(scratch, 'bin');
mkdirSync(bin);
const script = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
script('claude', 'echo "2.1.330 (Claude Code)"');
script('codex', 'echo "codex-cli 0.9.1"');
script('opencode', 'exec sleep 30');

const home = join(scratch, 'home');
mkdirSync(home);

async function detect(path: string, args: string[] = []) {
  let stdout = '';
  const fetch = vi.fn();
  const io: Io = {
    stdout: (t) => void (stdout += t),
    stderr: () => {},
    readStdin: async () => '',
    env: { PATH: path },
    cwd: scratch,
    home,
    interactive: false,
    prompt: async () => '',
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async () => {},
  };
  const code = await run(['harness', 'detect', '--json', ...args], io);
  return { code, fetch, json: JSON.parse(stdout) as { ok: boolean; harnesses: Array<{ id: string; installed: boolean; version?: string; foundBy?: string }> } };
}

describe('landflow harness detect', () => {
  it('finds the fake claude and codex, not cursor, reads their versions and never touches the network (AS-6)', async () => {
    const { code, fetch, json } = await detect(`${bin}:/usr/bin:/bin`);
    expect(code).toBe(0);
    const by = Object.fromEntries(json.harnesses.map((h) => [h.id, h]));
    expect(by['claude-code']).toMatchObject({ installed: true, version: '2.1.330', foundBy: 'binary' });
    expect(by['codex']).toMatchObject({ installed: true, version: '0.9.1' });
    expect(by['cursor']?.installed).toBe(false);
    expect(json.harnesses.map((h) => h.id)).not.toContain('generic');
    expect(json.harnesses).toHaveLength(7);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a binary that hangs is cut at 2 seconds: installed, version unknown', async () => {
    const started = Date.now();
    const { json } = await detect(`${bin}:/usr/bin:/bin`);
    const opencode = json.harnesses.find((h) => h.id === 'opencode');
    expect(opencode).toMatchObject({ installed: true });
    expect(opencode?.version).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  it('a config file alone says installed, with no version', async () => {
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'settings.json'), '{}');
    const { json } = await detect('/usr/bin:/bin');
    expect(json.harnesses.find((h) => h.id === 'gemini')).toMatchObject({ installed: true, foundBy: 'config file' });
    expect(json.harnesses.find((h) => h.id === 'gemini')?.version).toBeUndefined();
  });
});
