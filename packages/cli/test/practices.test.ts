/**
 * `landflow practices`: a fake host (fetch) answers the routes, and a made-up git repository in a temp directory is the
 * checkout. Made-up data only.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/index';
import type { Io } from '../src/command';
import { runCheck } from '../src/practices/check';
import { parseAdded, parseChange, parseNameStatus } from '../src/practices/diff';
import type { PracticeCheck } from '../src/practices/types';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

/** A repo with `main` holding a chart, then a branch with `files` changed on top. */
function repoWith(files: Record<string, string | null>, start: Record<string, string> = { 'README.md': 'hello\n', 'deploy/helm/web/Chart.yaml': 'name: web\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'landflow-practices-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  const put = (name: string, content: string) => {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  };
  for (const [name, content] of Object.entries(start)) put(name, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'start');
  git(dir, 'checkout', '-q', '-b', 'work');
  for (const [name, content] of Object.entries(files)) {
    if (content === null) git(dir, 'rm', '-q', name);
    else put(name, content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'change');
  return dir;
}

const REQUIRED = { handle: 'helm/chart-location', version: 3, title: 'Chart location', level: 'org', strength: 'required', summary: 'Charts live in deploy/helm/<service>/', topics: ['helm'], repos: [], paths: [] };
const RECOMMENDED = { handle: 'docs/readme-mentions', version: 1, title: 'README', level: 'org', strength: 'recommended', summary: 'The README names the service', topics: ['docs'], repos: [], paths: [] };
const NOCHECK = { handle: 'config/loader', version: 2, title: 'Config loader', level: 'org', strength: 'required', summary: 'Load config in one place', topics: ['config'], repos: [], paths: [] };

interface Fake {
  calls: Array<{ method: string; url: URL; body?: any }>;
  fetch: typeof fetch;
}

function fakeHost(options: { applicable?: unknown[]; approved?: unknown[]; learn?: unknown; omitted?: number } = {}): Fake {
  const calls: Fake['calls'] = [];
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const approved = (options.approved ?? []) as Array<Record<string, any>>;
  return {
    calls,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (method === 'GET' && url.pathname === '/api/practices/applicable') return reply({ practices: options.applicable ?? [], text: '## Practices to follow\n- x', budget: 3000, omitted: options.omitted ?? 0 });
      // The route that gives a practice's rules the way delivery does (`GET /api/practices` is the Brain page's list and is never read for a body).
      if (method === 'GET' && url.pathname === '/api/practices/resolve') {
        const handle = url.searchParams.get('handle');
        const level = url.searchParams.get('level');
        const found = approved.filter((p) => p.handle === handle && (!level || p.level === level)).sort((a, b) => (a.level === 'project' ? -1 : 0) - (b.level === 'project' ? -1 : 0))[0];
        if (!found?.approved) return reply({ error: 'No approved practice' }, 404);
        const { version, body, checks } = found.approved;
        return reply({ practice: { handle: found.handle, version, title: found.title, strength: found.strength, scope: { level: found.level, topics: [], repos: [], paths: [] }, summary: '', body, checks } });
      }
      if (url.pathname === '/api/practices' && method === 'GET') return reply({ error: 'a client read the list for a body' }, 500);
      if (method === 'POST' && url.pathname === '/api/practices/learn') return reply(options.learn ?? { drafts: [{ practiceId: 'prc_1', handle: 'helm/chart-location', version: 1, url: 'http://host.test/brain?practice=prc_1' }], skipped: [] }, 201);
      return reply({ error: 'unexpected' }, 500);
    },
  };
}

async function cli(host: Fake, cwd: string, argv: string[]) {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    readStdin: async () => '',
    env: { LANDFLOW_URL: 'http://host.test', LANDFLOW_API_KEY: 'lf_devkey_000000000000', LANDFLOW_CONFIG: join(cwd, '.no-config.json') },
    cwd,
    home: cwd,
    interactive: false,
    prompt: async () => 'n',
    fetch: host.fetch,
    sleep: async () => undefined,
  };
  const code = await run(argv, io);
  let json: any;
  if (argv.includes('--json')) json = JSON.parse(stdout);
  return { code, stdout, stderr, json };
}

const CHART_CHECK: PracticeCheck[] = [{ kind: 'pathAbsent', glob: '**/Chart.yaml', unless: 'deploy/helm/*/Chart.yaml' }];
const row = (p: typeof REQUIRED, checks: PracticeCheck[], version = p.version) => ({ ...p, approved: { version, body: `Rules for ${p.handle}.`, checks } });

describe('list and show', () => {
  it('list reads applicable with the repo from origin, the full size and preview, and sends nothing else', async () => {
    const host = fakeHost({ applicable: [REQUIRED] });
    const dir = repoWith({ 'README.md': 'hi\n' });
    const out = await cli(host, dir, ['practices', 'list', '--path', 'a/b.ts', '--path', 'c.ts']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('helm/chart-location@3');
    const url = host.calls[0].url;
    expect(url.searchParams.get('repo')).toBe('acme/widgets');
    expect(url.searchParams.get('size')).toBe('full');
    expect(url.searchParams.get('preview')).toBe('1');
    expect(url.searchParams.getAll('path')).toEqual(['a/b.ts', 'c.ts']);
    expect(host.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('list --json, with --repo and --project', async () => {
    const host = fakeHost({ applicable: [REQUIRED] });
    const out = await cli(host, tmpdir(), ['practices', 'list', '--repo', 'acme/other', '--project', 'prj_1', '--json']);
    expect(out.json).toMatchObject({ ok: true, repo: 'acme/other', practices: [{ handle: 'helm/chart-location' }] });
    expect(host.calls[0].url.searchParams.get('projectId')).toBe('prj_1');
  });

  it('list says when nothing applies', async () => {
    const out = await cli(fakeHost(), tmpdir(), ['practices', 'list', '--repo', 'acme/other']);
    expect(out.stdout).toContain('No approved practices apply here.');
  });

  it('show prints the approved body and checks; an unknown handle is not found', async () => {
    const host = fakeHost({ approved: [row(REQUIRED, CHART_CHECK)] });
    const out = await cli(host, tmpdir(), ['practices', 'show', 'helm/chart-location']);
    expect(out.stdout).toContain('Rules for helm/chart-location.');
    expect(out.stdout).toContain('pathAbsent **/Chart.yaml (unless deploy/helm/*/Chart.yaml)');
    expect(host.calls.every((c) => c.url.pathname !== '/api/practices')).toBe(true);
    const none = await cli(host, tmpdir(), ['practices', 'show', 'no/such', '--json']);
    expect(none.code).toBe(3);
    expect(none.json.error.code).toBe('not_found');
    const shown = await cli(host, tmpdir(), ['practices', 'show', 'helm/chart-location', '--json']);
    expect(shown.json.practices[0].checks).toEqual(CHART_CHECK);
  });
});

describe('check', () => {
  it('passes when the change meets every check, and sends only reads', async () => {
    const dir = repoWith({ 'deploy/helm/api/Chart.yaml': 'name: api\n' });
    const host = fakeHost({ applicable: [REQUIRED, NOCHECK], approved: [row(REQUIRED, CHART_CHECK), row(NOCHECK, [])] });
    const out = await cli(host, dir, ['practices', 'check', '--json']);
    expect(out.code).toBe(0);
    expect(out.json.ok).toBe(true);
    expect(out.json.changed).toEqual([{ path: 'deploy/helm/api/Chart.yaml', status: 'A' }]);
    expect(out.json.practices.map((p: any) => [p.handle, p.result])).toEqual([['config/loader', 'none'], ['helm/chart-location', 'pass']]);
    expect(host.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(host.calls[0].url.searchParams.getAll('path')).toEqual(['deploy/helm/api/Chart.yaml']);
    const human = await cli(host, dir, ['practices', 'check']);
    expect(human.stdout).toContain('no machine check  config/loader@2');
    expect(human.stdout).toContain('Passed.');
  });

  it('a failed required check exits 1 and names the files', async () => {
    const dir = repoWith({ 'charts/Chart.yaml': 'name: stray\n' });
    const host = fakeHost({ applicable: [REQUIRED], approved: [row(REQUIRED, CHART_CHECK)] });
    const out = await cli(host, dir, ['practices', 'check']);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain('FAIL  helm/chart-location@3 (required)');
    expect(out.stdout).toContain('charts/Chart.yaml');
    expect(out.stdout).toContain('Failed: helm/chart-location (required).');
    const json = await cli(host, dir, ['practices', 'check', '--json']);
    expect(json.code).toBe(1);
    expect(json.json).toMatchObject({ ok: false, practices: [{ result: 'fail', checks: [{ pass: false, files: ['charts/Chart.yaml'] }] }] });
  });

  it('a failed recommended check warns and exits 0', async () => {
    const dir = repoWith({ 'src/a.ts': 'export const a = 1;\n' });
    const check: PracticeCheck[] = [{ kind: 'fileMatches', glob: 'src/**', pattern: 'otel', absent: false }];
    const host = fakeHost({ applicable: [RECOMMENDED], approved: [row(RECOMMENDED as any, check)] });
    const out = await cli(host, dir, ['practices', 'check']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('warn  docs/readme-mentions@1 (recommended)');
    expect(out.stdout).toContain('Passed, with 1 warning.');
  });

  it('asks again for each group of 20 changed paths and joins the practices by handle', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) files[`src/f${i}.ts`] = `export const v${i} = ${i};\n`;
    const dir = repoWith(files);
    const host = fakeHost({ applicable: [REQUIRED], approved: [row(REQUIRED, [])] });
    const out = await cli(host, dir, ['practices', 'check', '--json']);
    const asks = host.calls.filter((c) => c.url.pathname === '/api/practices/applicable');
    expect(asks.map((a) => a.url.searchParams.getAll('path').length)).toEqual([20, 5]);
    expect(out.json.practices).toHaveLength(1);
  });

  it('a practice whose approved version moved has no machine check to run', async () => {
    const dir = repoWith({ 'README.md': 'hello again\n' });
    const host = fakeHost({ applicable: [REQUIRED], approved: [row(REQUIRED, CHART_CHECK, 4)] });
    const out = await cli(host, dir, ['practices', 'check', '--json']);
    expect(out.json.practices[0].result).toBe('none');
  });

  it('an org and a project practice of one handle and version: the check runs the one that was delivered', async () => {
    const dir = repoWith({ 'README.md': 'hello again\n' });
    const orgRow = row({ ...REQUIRED, level: 'org' }, []);
    const projectRow = row({ ...REQUIRED, level: 'project' }, CHART_CHECK);
    const host = fakeHost({ applicable: [{ ...REQUIRED, level: 'project' }], approved: [orgRow, projectRow] });
    const out = await cli(host, dir, ['practices', 'check', '--json']);
    expect(out.json.practices[0].checks.length).toBeGreaterThan(0);
    expect(host.calls.find((c) => c.url.pathname === '/api/practices/resolve')?.url.searchParams.get('level')).toBe('project');
    const orgOnly = fakeHost({ applicable: [{ ...REQUIRED, level: 'org' }], approved: [projectRow, orgRow] });
    const asOrg = await cli(orgOnly, dir, ['practices', 'check', '--json']);
    expect(asOrg.json.practices[0].result).toBe('none');
  });

  it('does not pass quietly when practices were omitted: it narrows the ask, then says what is left', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3; i++) files[`src/f${i}.ts`] = `export const v${i} = ${i};\n`;
    const dir = repoWith(files);
    const host = fakeHost({ applicable: [REQUIRED], approved: [row(REQUIRED, [])], omitted: 2 });
    const out = await cli(host, dir, ['practices', 'check', '--json']);
    expect(out.json.omitted).toBeGreaterThan(0);
    expect(host.calls.filter((c) => c.url.pathname === '/api/practices/applicable').length).toBeGreaterThan(1);
    const human = await cli(host, dir, ['practices', 'check']);
    expect(human.stdout).toContain('did not fit');
    expect(human.stdout).not.toMatch(/^Passed\.$/m);
  });

  it('refuses a base that looks like a flag', async () => {
    const out = await cli(fakeHost(), repoWith({ 'README.md': 'x\n' }), ['practices', 'check', '--base=--output=x']);
    expect(out.code).toBe(2);
  });
});

describe('the three check kinds', () => {
  const change = (name: string, diff: string) => parseChange(name, diff);
  const files = 'A\tdeploy/helm/api/Chart.yaml\nM\tsrc/otel.ts\nD\told/Chart.yaml\n';
  const diff = ['diff --git a/src/otel.ts b/src/otel.ts', '--- a/src/otel.ts', '+++ b/src/otel.ts', '@@ -1,0 +2,2 @@', '+import { trace } from "@opentelemetry/api";', '+export const t = 1;', ''].join('\n');
  const c = change(files, diff);

  it('pathExists: with `when`, only when something matched it', () => {
    expect(runCheck({ kind: 'pathExists', glob: 'deploy/helm/*/Chart.yaml' }, c).pass).toBe(true);
    expect(runCheck({ kind: 'pathExists', glob: 'docs/**' }, c).pass).toBe(false);
    expect(runCheck({ kind: 'pathExists', glob: 'docs/**', when: 'src/**' }, c).pass).toBe(false);
    expect(runCheck({ kind: 'pathExists', glob: 'docs/**', when: 'infra/**' }, c).pass).toBe(true);
    // A deleted file is not there.
    expect(runCheck({ kind: 'pathExists', glob: 'old/**' }, c).pass).toBe(false);
  });

  it('pathAbsent: no match, unless the exception matches; a deleted file is gone', () => {
    expect(runCheck({ kind: 'pathAbsent', glob: '**/Chart.yaml' }, c)).toMatchObject({ pass: false, files: ['deploy/helm/api/Chart.yaml'] });
    expect(runCheck({ kind: 'pathAbsent', glob: '**/Chart.yaml', unless: 'deploy/helm/*/Chart.yaml' }, c).pass).toBe(true);
    expect(runCheck({ kind: 'pathAbsent', glob: 'old/**' }, c).pass).toBe(true);
  });

  it('fileMatches: every matching file has the pattern in its added lines, or never with absent', () => {
    expect(runCheck({ kind: 'fileMatches', glob: 'src/**', pattern: '@opentelemetry/api' }, c).pass).toBe(true);
    expect(runCheck({ kind: 'fileMatches', glob: 'src/**', pattern: '^export const' }, c).pass).toBe(true);
    expect(runCheck({ kind: 'fileMatches', glob: 'src/**', pattern: 'console\\.log' }, c)).toMatchObject({ pass: false, files: ['src/otel.ts'] });
    expect(runCheck({ kind: 'fileMatches', glob: 'src/**', pattern: 'trace', absent: true }, c)).toMatchObject({ pass: false, files: ['src/otel.ts'] });
    expect(runCheck({ kind: 'fileMatches', glob: 'src/**', pattern: 'console\\.log', absent: true }, c).pass).toBe(true);
    // No file matches the glob: nothing to hold to the pattern.
    expect(runCheck({ kind: 'fileMatches', glob: 'lib/**', pattern: 'x' }, c).pass).toBe(true);
    // A pattern that is not a regular expression fails in words instead of throwing.
    expect(runCheck({ kind: 'fileMatches', glob: 'src/**', pattern: '(' }, c).pass).toBe(false);
  });

  it('parses git’s name-status and -U0 output', () => {
    expect(parseNameStatus('A\ta b.txt\nT\tx\nR100\told\tnew\n')).toEqual([{ path: 'a b.txt', status: 'A' }, { path: 'x', status: 'M' }, { path: 'old\tnew', status: 'M' }]);
    const added = parseAdded(['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-old', '+new', '+++ not a header inside a hunk', 'diff --git a/y b/y', '--- a/y', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone'].join('\n'));
    expect(added.get('x')).toEqual(['new', '++ not a header inside a hunk']);
    expect(added.has('y')).toBe(false);
  });
});

describe('learn', () => {
  it('posts the files with the head sha, skips oversized ones and lists the drafts', async () => {
    const dir = repoWith({ 'CLAUDE.md': '# Rules\nCharts live in deploy/helm.\n', 'deploy/big.yaml': `a: ${'x'.repeat(20_001)}\n`, 'deploy/small.yaml': 'a: 1\n', 'deploy/bin.dat': 'ab\u0000cd' });
    const sha = git(dir, 'rev-parse', 'HEAD').trim();
    const host = fakeHost();
    const out = await cli(host, dir, ['practices', 'learn', 'CLAUDE.md', 'deploy/', '--topic', 'helm', '--json']);
    expect(out.code).toBe(0);
    const post = host.calls.find((c) => c.method === 'POST');
    expect(post?.url.pathname).toBe('/api/practices/learn');
    expect(post?.body).toMatchObject({ repo: 'acme/widgets', sha, topics: ['helm'] });
    expect(post?.body.files.map((f: any) => f.path)).toEqual(['CLAUDE.md', 'deploy/helm/web/Chart.yaml', 'deploy/small.yaml']);
    expect(post?.body.files[0].content).toContain('Charts live in deploy/helm');
    expect(out.json.skippedFiles).toEqual([{ path: 'deploy/big.yaml', reason: 'over 20,000 bytes' }, { path: 'deploy/bin.dat', reason: 'not a text file' }]);
    expect(out.json.drafts[0]).toMatchObject({ handle: 'helm/chart-location', url: 'http://host.test/brain?practice=prc_1' });
    const human = await cli(host, dir, ['practices', 'learn', 'CLAUDE.md']);
    expect(human.stdout).toContain('Drafted 1 practice');
    expect(human.stdout).toContain('/brain → Practices');
  });

  it('reads at most 20 files and names the rest', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 23; i++) files[`docs/p${String(i).padStart(2, '0')}.md`] = `rule ${i}\n`;
    const dir = repoWith(files);
    const host = fakeHost();
    const out = await cli(host, dir, ['practices', 'learn', 'docs', '--json']);
    expect(host.calls.find((c) => c.method === 'POST')?.body.files).toHaveLength(20);
    expect(out.json.skippedFiles).toHaveLength(3);
  });

  it('refuses a path outside the repository and a repo it cannot name', async () => {
    const dir = repoWith({ 'README.md': 'x\n' });
    const outside = await cli(fakeHost(), dir, ['practices', 'learn', '../elsewhere']);
    expect(outside.code).toBe(2);
    const bare = mkdtempSync(join(tmpdir(), 'landflow-practices-bare-'));
    const noRepo = await cli(fakeHost(), bare, ['practices', 'learn', 'x.md']);
    expect(noRepo.code).toBe(2);
    expect(noRepo.stderr).toContain('--repo owner/name');
  });

  it('sends the project when one is named', async () => {
    const dir = repoWith({ 'CLAUDE.md': 'rules\n' });
    const host = fakeHost();
    await cli(host, dir, ['practices', 'learn', 'CLAUDE.md', '--project', 'prj_1']);
    expect(host.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ level: 'project', projectId: 'prj_1' });
  });
});
