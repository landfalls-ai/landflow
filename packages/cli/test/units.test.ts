/** The argument parser, the unified diff, the config file rules and the error contract — no host needed. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, type FlagSpecs } from '../src/args';
import { maskKey, normalizeUrl, resolveConnection } from '../src/config';
import { CliError, EXIT } from '../src/errors';
import { diffLines, unifiedDiff } from '../src/sync/diff';
import { isManagedPath, isSafePath, sameDocument } from '../src/sync/files';

const specs: FlagSpecs = {
  json: { type: 'boolean', description: '' },
  file: { type: 'string', description: '', short: 'f' },
  limit: { type: 'number', description: '' },
  tag: { type: 'string', description: '', multiple: true },
  wait: { type: 'boolean', description: '', short: 'w' },
};

describe('parseArgs', () => {
  it('reads flags in every spelling', () => {
    expect(parseArgs(['a', '--file', 'x.json', '--limit=5', '-w', '--tag', 't1', '--tag=t2', 'b'], specs)).toEqual({
      positionals: ['a', 'b'],
      flags: { file: 'x.json', limit: 5, wait: true, tag: ['t1', 't2'] },
    });
    expect(parseArgs(['-fx.json', '-', '--json=false'], specs)).toEqual({ positionals: ['-'], flags: { file: 'x.json', json: false } });
    expect(parseArgs(['--', '--file', '-w'], specs).positionals).toEqual(['--file', '-w']);
  });

  it('rejects what it doesn’t know as usage errors', () => {
    const fail = (tokens: string[]) => {
      try {
        parseArgs(tokens, specs);
      } catch (caught) {
        return caught as CliError;
      }
      throw new Error('expected a usage error');
    };
    expect(fail(['--nope']).message).toBe('Unknown option --nope');
    expect(fail(['--file']).code).toBe('usage');
    expect(fail(['--limit', 'many']).message).toContain('must be a number');
    expect(fail(['--json=maybe']).exitCode).toBe(EXIT.usage);
    expect(fail(['-z']).message).toBe('Unknown option -z');
  });
});

describe('unifiedDiff', () => {
  it('prints hunks with three lines of context, stable and git-compatible', () => {
    const before = `${Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
    const after = before.replace('line 2\n', 'line two\n').replace('line 11\n', 'line 11\nline 11b\n');
    const diff = unifiedDiff('a.txt', before, after);
    expect(diff).toBe(
      [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,5 +1,5 @@',
        ' line 1',
        '-line 2',
        '+line two',
        ' line 3',
        ' line 4',
        ' line 5',
        '@@ -9,4 +9,5 @@',
        ' line 9',
        ' line 10',
        ' line 11',
        '+line 11b',
        ' line 12',
        '',
      ].join('\n'),
    );
    expect(unifiedDiff('a.txt', before, after)).toBe(diff);
    expect(unifiedDiff('a.txt', before, before)).toBe('');
    expect(unifiedDiff('new.txt', undefined, 'x\ny\n')).toBe('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n');
    expect(unifiedDiff('old.txt', 'x\n', undefined)).toBe('--- a/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n');

    // `git apply` takes it (in a scratch directory, not a repository).
    const scratch = mkdtempSync(join(tmpdir(), 'landflow-cli-diff-'));
    writeFileSync(join(scratch, 'a.txt'), before);
    writeFileSync(join(scratch, 'patch.diff'), diff);
    execFileSync('git', ['apply', 'patch.diff'], { cwd: scratch, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    expect(readFileSync(join(scratch, 'a.txt'), 'utf8')).toBe(after);
  });

  it('finds a shortest edit script that rebuilds the target', () => {
    const random = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const next = random(7);
    for (let round = 0; round < 50; round++) {
      const a = Array.from({ length: Math.floor(next() * 30) }, () => String(Math.floor(next() * 5)));
      const b = Array.from({ length: Math.floor(next() * 30) }, () => String(Math.floor(next() * 5)));
      const ops = diffLines(a, b);
      expect(ops.filter((o) => o.type !== '+').map((o) => o.line)).toEqual(a);
      expect(ops.filter((o) => o.type !== '-').map((o) => o.line)).toEqual(b);
    }
  });
});

describe('sync files', () => {
  it('owns only the layout’s paths, and only safe ones', () => {
    expect(['landflow-sync.json', 'variables.json', 'data-tables/x.schema.json', 'workflows/a/b.workflow.json', 'workflows/a/.folder.json'].every(isManagedPath)).toBe(true);
    expect(['README.md', 'data-tables/a/b.schema.json', 'workflows/notes.txt', '.landflow/state.json'].some(isManagedPath)).toBe(false);
    expect(['../x', '/etc/passwd', 'a//b', 'a\\b', 'workflows/./x'].some(isSafePath)).toBe(false);
  });

  it('compares JSON documents regardless of key order and whitespace', () => {
    expect(sameDocument('{"a":1,"b":[1,{"c":2,"d":3}]}', '{\n  "b": [1, {"d": 3, "c": 2}],\n  "a": 1\n}\n')).toBe(true);
    expect(sameDocument('{"a":1}', '{"a":2}')).toBe(false);
    expect(sameDocument('not json', 'not json ')).toBe(false);
  });
});

describe('config', () => {
  it('takes flags over the environment over the file, and masks keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'landflow-cli-config-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ url: 'http://file:3000/', apiKey: 'lf_fromfile0000' }));
    expect(resolveConnection({}, {}, path)).toMatchObject({ url: 'http://file:3000', urlSource: 'config', apiKey: 'lf_fromfile0000', keySource: 'config' });
    expect(resolveConnection({}, { LANDFLOW_URL: 'https://env.example', LANDFLOW_API_KEY: 'lf_env' }, path)).toMatchObject({ url: 'https://env.example', urlSource: 'env', keySource: 'env' });
    expect(resolveConnection({ url: 'http://flag', apiKey: 'lf_flag' }, { LANDFLOW_URL: 'https://env.example' }, path)).toMatchObject({ url: 'http://flag', urlSource: 'flag', keySource: 'flag' });
    expect(resolveConnection({}, {}, join(dir, 'missing.json'))).toMatchObject({ url: 'http://localhost:3000', urlSource: 'default', keySource: 'none' });
    expect(maskKey('lf_abcdefghijklmnop')).toBe('lf_…mnop');
    expect(() => normalizeUrl('ftp://x')).toThrow(/http/);
  });

  it('serializes errors with a stable shape', () => {
    expect(new CliError('not_found', 'gone', { status: 404 }).toJSON()).toEqual({ code: 'not_found', message: 'gone', status: 404 });
    expect(new CliError('conflict', 'x').exitCode).toBe(5);
    expect(EXIT).toEqual({ ok: 0, error: 1, usage: 2, notFound: 3, auth: 4, conflict: 5, network: 6, timeout: 7, approvalPending: 8 });
  });
});
