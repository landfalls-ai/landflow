/**
 * The built binary (the same esbuild bundle as `pnpm build`, written to a temp file): it runs with plain `node`,
 * prints JSON on stdout, and exits with the documented codes — also against a real host over HTTP.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type Host } from './host';

const out = join(mkdtempSync(join(tmpdir(), 'landflow-cli-bin-')), 'main.js');
const home = mkdtempSync(join(tmpdir(), 'landflow-cli-bin-home-'));
let host: Host;

/** Run the binary without blocking this process (the host answers from it). */
function landflow(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [out, ...args], { env: { PATH: process.env.PATH ?? '', HOME: home, LANDFLOW_CONFIG: join(home, 'config.json'), ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  await build({ entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))], bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: out, logLevel: 'silent' });
  host = await startHost();
});

afterAll(async () => {
  await host?.close();
});

describe('the landflow binary', () => {
  it('is an executable node script with the package version', async () => {
    expect(readFileSync(out, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; bin: Record<string, string> };
    expect(pkg.bin).toEqual({ landflow: './dist/main.js' });
    expect(await landflow(['--version'])).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: '' });
  });

  it('exits with the documented codes and prints JSON errors on stdout', async () => {
    const usage = await landflow(['nope', '--json']);
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stdout)).toMatchObject({ ok: false, error: { code: 'usage' } });
    const network = await landflow(['workflows', 'list', '--json'], { LANDFLOW_URL: 'http://127.0.0.1:9' });
    expect(network.code).toBe(6);
    expect(JSON.parse(network.stdout).error.code).toBe('network');
    const human = await landflow(['workflows', 'get', 'missing'], { LANDFLOW_URL: host.url });
    expect(human.code).toBe(3);
    expect(human.stderr).toBe('error: No workflow with the id or name "missing"\n');
  });

  it('talks to a host over HTTP', async () => {
    const result = await landflow(['workflows', 'list', '--json'], { LANDFLOW_URL: host.url });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, workflows: [] });
  });
});
