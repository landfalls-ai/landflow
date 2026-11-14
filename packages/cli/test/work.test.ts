/**
 * `landflow work`: collect, hold, review, send, forget. A fake command runner stands in for git and gh and a fake
 * fetch for the host, so nothing here touches a repository or a network. Made-up data only.
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/index';
import type { Io } from '../src/command';
import { execFileSync } from 'node:child_process';
import { branchesFrom, collectRepo, defaultRunner, parseRemote, type Runner } from '../src/work/collect';
import { prune, upsert, type HeldEntry } from '../src/work/held';
import { summarizeDay } from '../src/work/summary';
import { validateWorkEvent } from '../src/work/contract';

const LOG = [
  '@@aaa111\t2026-11-14T09:30:00+01:00\tHEAD -> main, origin/main\tFix the retry loop',
  'packages/engine/src/executor.ts',
  'packages/engine/test/executor.test.ts',
  'README.md',
  '',
  '@@bbb222\t2026-11-14T11:00:00+01:00\tfeature/docs\tAdd docs for the cli with token=abcd1234efgh5678',
  'docs/features/cli.md',
  '',
  '@@ccc333\t2026-11-13T16:00:00+01:00\t\tYesterday work',
  'apps/web/src/app.tsx',
].join('\n');

interface Fake {
  runner: Runner;
  calls: string[];
}

function fakeRunner(options: { gh?: boolean; log?: string; origin?: string; email?: string; pr?: string } = {}): Fake {
  const calls: string[] = [];
  const runner: Runner = async (command, args) => {
    calls.push([command, ...args].join(' '));
    const key = `${command} ${args[0]} ${args[1] ?? ''}`.trim();
    if (command === 'git' && args[0] === 'remote') return { code: 0, stdout: `${options.origin ?? 'git@github.com:acme/widgets.git'}\n` };
    if (command === 'git' && args[0] === 'config' && args[1] === 'user.email') return { code: 0, stdout: `${options.email ?? 'dev@example.com'}\n` };
    if (command === 'git' && args[0] === 'config') return { code: 0, stdout: 'Dev\n' };
    if (command === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'main\n' };
    if (command === 'git' && args[0] === 'log') return { code: 0, stdout: options.log ?? LOG };
    if (command === 'gh' && args[0] === '--version') return options.gh ? { code: 0, stdout: 'gh 2' } : { code: 127, stdout: '' };
    if (command === 'gh' && args[0] === 'pr') return { code: 0, stdout: options.pr ?? '[]' };
    throw new Error(`unexpected command: ${key}`);
  };
  return { runner, calls };
}

interface Host {
  posts: Array<{ events: Array<Record<string, unknown>> }>;
  deletes: string[];
  fetch: typeof fetch;
  autoSend: string;
  reject?: string;
}

function fakeHost(): Host {
  const host: Host = {
    posts: [],
    deletes: [],
    autoSend: 'allowed',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const reply = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && url.pathname === '/api/brain/briefing') return reply({ autoSend: host.autoSend });
      if (method === 'POST' && url.pathname === '/api/brain/work') {
        const body = JSON.parse(String(init?.body)) as { events: Array<{ sourceId: string }> };
        host.posts.push(body as never);
        const rejected = host.reject ? body.events.filter((e) => e.sourceId.includes(host.reject as string)).map((e) => ({ sourceId: e.sourceId, reason: 'refused' })) : [];
        const saved = body.events.filter((e) => !rejected.some((r) => r.sourceId === e.sourceId)).map((e, i) => ({ sourceId: e.sourceId, id: `srv_${i}`, created: true }));
        return reply({ saved, rejected });
      }
      if (method === 'DELETE' && url.pathname.startsWith('/api/brain/work/')) {
        host.deletes.push(decodeURIComponent(url.pathname.slice('/api/brain/work/'.length)) + url.search);
        return decodeURIComponent(url.pathname).includes('missing') ? reply({ error: 'No such work' }, 404) : reply({}, 204);
      }
      return reply({ error: 'unexpected' }, 500);
    },
  };
  return host;
}

function setup(options: { runner?: Fake; interactive?: boolean; answer?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'landflow-work-home-'));
  const repo = join(home, 'widgets');
  mkdirSync(repo);
  const fake = options.runner ?? fakeRunner({ gh: false });
  const host = fakeHost();
  const cli = async (argv: string[], overrides: Partial<Io> = {}) => {
    let stdout = '';
    let stderr = '';
    const io: Io & { exec: Runner } = {
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
      readStdin: async () => '',
      env: { LANDFLOW_URL: 'http://host.test', LANDFLOW_API_KEY: 'lf_devkey_000000000000', LANDFLOW_CONFIG: join(home, 'config', 'config.json') },
      cwd: home,
      home,
      interactive: options.interactive ?? false,
      prompt: async () => options.answer ?? 'n',
      fetch: host.fetch,
      sleep: async () => undefined,
      exec: fake.runner,
      ...overrides,
    };
    const code = await run(argv, io);
    let json: any;
    if (argv.includes('--json')) json = JSON.parse(stdout);
    return { code, stdout, stderr, json };
  };
  const heldFile = join(home, 'config', 'work', 'held.json');
  return { cli, home, repo, fake, host, heldFile };
}

const readHeld = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as { entries: HeldEntry[] }).entries;

describe('collect', () => {
  it('holds one entry per repo per day, built from the fake git log', async () => {
    const t = setup();
    expect((await t.cli(['work', 'repos', 'add', t.repo, '--json'])).json.added).toEqual({ path: t.repo, repo: 'acme/widgets' });
    const out = await t.cli(['work', 'collect', '--since', '2026-11-13', '--json']);
    expect(out.code).toBe(0);
    expect(out.json.entries.map((e: any) => e.sourceId)).toEqual(['acme/widgets@2026-11-13', 'acme/widgets@2026-11-14']);
    const today = readHeld(t.heldFile).find((e) => e.day === '2026-11-14') as HeldEntry;
    expect(today.status).toBe('held');
    expect(today.event).toMatchObject({ kind: 'work.session', source: 'landflow-cli', repo: 'acme/widgets', branch: 'main', commits: 2 });
    expect(today.event.title).toMatch(/^2 commits on main, feature\/docs: Fix the retry loop; Add docs for the cli/);
    expect(today.event.areas).toEqual(['packages/engine', 'docs/features']);
    expect(JSON.stringify(today)).not.toMatch(/executor\.ts|README|\.md|abcd1234efgh5678/);
    expect(validateWorkEvent(today.event).ok).toBe(true);
    expect(statSync(t.heldFile).mode & 0o777).toBe(0o600);
  });

  it('skips a repo that is not allowed and one whose origin changed', async () => {
    const t = setup();
    const out = await t.cli(['work', 'collect', '--repo', t.repo, '--json']);
    expect(out.json.entries).toEqual([]);
    expect(out.json.skipped[0].reason).toContain('not on the allow-list');
    await t.cli(['work', 'repos', 'add', t.repo]);
    const moved = setup({ runner: fakeRunner({ origin: 'https://github.com/other/place.git' }) });
    moved.fake.calls.length = 0;
    writeFileSync(join(moved.home, 'x'), '');
    mkdirSync(join(moved.home, 'config', 'work'), { recursive: true });
    writeFileSync(join(moved.home, 'config', 'work', 'repos.json'), JSON.stringify({ repos: [{ path: moved.repo, repo: 'acme/widgets' }] }));
    const again = await moved.cli(['work', 'collect', '--json']);
    expect(again.json.skipped[0].reason).toContain('origin is now other/place');
    expect(again.json.entries).toEqual([]);
  });

  it('never asks git or gh for a diff or a file’s contents', async () => {
    const fake = fakeRunner({ gh: true, pr: JSON.stringify([{ url: 'https://github.com/acme/widgets/pull/7', state: 'MERGED', updatedAt: '2026-11-14T12:00:00Z' }, { url: 'https://github.com/acme/widgets/pull/8', state: 'CLOSED', updatedAt: '2026-11-14T12:00:00Z' }]) });
    const t = setup({ runner: fake });
    await t.cli(['work', 'repos', 'add', t.repo]);
    const out = await t.cli(['work', 'collect', '--since', '2026-11-14', '--json']);
    expect(out.json.entries[0].prs).toEqual([{ url: 'https://github.com/acme/widgets/pull/7', state: 'merged' }]);
    expect(fake.calls.length).toBeGreaterThan(3);
    for (const call of fake.calls) {
      expect(call).not.toMatch(/\bdiff\b|\bshow\b|\bblame\b|\bcat-file\b|--patch|\s-p(\s|$)|--stat\b|--cat/);
      expect(call).toMatch(/^(git (remote get-url origin|config user\.(email|name)|rev-parse --abbrev-ref HEAD|log )|gh (--version|pr list ))/);
    }
    expect(fake.calls.find((c) => c.startsWith('git log'))).toContain('--name-only');
    expect(fake.calls.find((c) => c.startsWith('gh pr list'))).toContain('--author @me');
  });

  it('works without gh: no pull requests and no error', async () => {
    const t = setup();
    await t.cli(['work', 'repos', 'add', t.repo]);
    const out = await t.cli(['work', 'collect', '--since', '2026-11-14', '--json']);
    expect(out.code).toBe(0);
    expect(out.json.entries[0].prs).toEqual([]);
    expect(out.json.notes.join(' ')).toContain('gh is not installed');
    expect(t.fake.calls.some((c) => c.startsWith('gh pr'))).toBe(false);
  });

  it('collecting a day again updates its entry instead of adding one', async () => {
    const t = setup();
    await t.cli(['work', 'repos', 'add', t.repo]);
    await t.cli(['work', 'collect', '--since', '2026-11-14']);
    await t.cli(['work', 'collect', '--since', '2026-11-14']);
    expect(readHeld(t.heldFile)).toHaveLength(1);
  });

  it('rejects a bad --since', async () => {
    const t = setup();
    const out = await t.cli(['work', 'collect', '--since', 'last week', '--json']);
    expect(out.code).toBe(2);
  });
});

describe('summary', () => {
  const commit = (hash: string, at: string, subject: string, files: string[] = []) => ({ hash, at, subject, branches: ['main'], files });
  it('is deterministic whatever the input order, redacted and at most 200 characters', () => {
    const commits = [commit('b', '2026-11-14T10:00:00Z', 'Second', ['a/b/c.ts']), commit('a', '2026-11-14T09:00:00Z', 'Bearer abcdefghijklmnop first', ['a/b/c.ts', 'z.md']), commit('c', '2026-11-14T11:00:00Z', 'x'.repeat(500))];
    const one = summarizeDay({ repo: 'acme/widgets', day: '2026-11-14', commits, prs: [] });
    const two = summarizeDay({ repo: 'acme/widgets', day: '2026-11-14', commits: [...commits].reverse(), prs: [] });
    expect(one).toEqual(two);
    expect(one.title).toBe(`3 commits on main: Bearer [redacted] first; Second; ${'x'.repeat(59)}…`);
    expect(one.title.length).toBeLessThanOrEqual(200);
    expect(one.areas).toEqual(['a/b']);
  });

  it('describes a day with only a pull request', () => {
    const e = summarizeDay({ repo: 'acme/widgets', day: '2026-11-14', commits: [], prs: [{ url: 'https://github.com/acme/widgets/pull/1', state: 'opened', day: '2026-11-14' }] });
    expect(e.title).toBe('1 pull request on acme/widgets');
    expect(e.commits).toBe(0);
  });

  it('parses remotes and decorations', () => {
    expect(parseRemote('git@github.com:acme/widgets.git')).toBe('acme/widgets');
    expect(parseRemote('https://github.com/acme/widgets')).toBe('acme/widgets');
    expect(parseRemote('nonsense')).toBeUndefined();
    expect(branchesFrom('HEAD -> main, tag: v1, origin/main, origin/HEAD, origin/feature/x')).toEqual(['main', 'feature/x']);
  });
});

describe('held file caps', () => {
  const entry = (n: number, day: string, status: HeldEntry['status'] = 'sent'): HeldEntry => ({ id: String(n), sourceId: `r@${day}#${n}`, day, status, event: {} as never, heldAt: `${day}T00:00:00Z` });
  it('drops entries older than 14 days and keeps at most 500, settled ones first', () => {
    const now = new Date('2026-11-14T12:00:00Z');
    expect(prune([entry(1, '2026-10-01'), entry(2, '2026-11-10')], now).map((e) => e.id)).toEqual(['2']);
    const many = Array.from({ length: 502 }, (_, i) => entry(i, '2026-11-12', i < 2 ? 'held' : 'sent'));
    const kept = prune(many, now);
    expect(kept).toHaveLength(500);
    expect(kept.filter((e) => e.status === 'held')).toHaveLength(2);
  });
});

describe('review, send, status and forget', () => {
  async function held() {
    const t = setup();
    await t.cli(['work', 'repos', 'add', t.repo]);
    await t.cli(['work', 'collect', '--since', '2026-11-13']);
    return t;
  }

  it('lists held entries and sends nothing by itself', async () => {
    const t = await held();
    const out = await t.cli(['work', 'review', '--json']);
    expect(out.json).toMatchObject({ ok: true, held: 2, sent: [], refused: [] });
    expect(Object.keys(out.json.entries[0]).sort()).toEqual(['areas', 'branch', 'commits', 'day', 'error', 'heldAt', 'id', 'prs', 'repo', 'sentAt', 'serverId', 'sourceId', 'status', 'title']);
    expect(t.host.posts).toHaveLength(0);
  });

  it('retitles, drops and sends one entry by id with a private visibility', async () => {
    const t = await held();
    const [a, b] = readHeld(t.heldFile);
    expect((await t.cli(['work', 'review', '--title', a.id, 'Hardened the retry loop'])).code).toBe(0);
    expect((await t.cli(['work', 'review', '--drop', b.id])).code).toBe(0);
    const out = await t.cli(['work', 'review', '--send', a.id, '--yes', '--json']);
    expect(out.json.sent).toHaveLength(1);
    expect(t.host.posts).toHaveLength(1);
    expect(t.host.posts[0].events[0]).toMatchObject({ sourceId: a.sourceId, title: 'Hardened the retry loop', visibility: 'private' });
    const after = readHeld(t.heldFile);
    expect(after.find((e) => e.id === a.id)).toMatchObject({ status: 'sent', serverId: 'srv_0' });
    expect(after.find((e) => e.id === b.id)?.status).toBe('dropped');
    expect(statSync(t.heldFile).mode & 0o777).toBe(0o600);
    const status = await t.cli(['work', 'status', '--json']);
    expect(status.json).toMatchObject({ ok: true, held: 0 });
    expect(status.json.sent[0]).toMatchObject({ id: a.id, serverId: 'srv_0' });
  });

  it('send refuses without a terminal and without --yes, and sends nothing', async () => {
    const t = await held();
    const out = await t.cli(['work', 'send', '--json']);
    expect(out.code).toBe(2);
    expect(out.json.error.message).toContain('--yes');
    expect(t.host.posts).toHaveLength(0);
  });

  it('send --yes sends everything; the host refusing an automatic send stops it', async () => {
    const t = await held();
    t.host.autoSend = 'forbidden';
    const blocked = await t.cli(['work', 'send', '--yes', '--json']);
    expect(blocked.code).toBe(4);
    expect(t.host.posts).toHaveLength(0);
    t.host.autoSend = 'allowed';
    const out = await t.cli(['work', 'send', '--yes', '--json']);
    expect(out.json.sent).toHaveLength(2);
    expect(t.host.posts).toHaveLength(1);
    expect((await t.cli(['work', 'send', '--yes'])).stdout).toContain('Nothing is held');
  });

  it('asks on a terminal and cancels on anything but yes', async () => {
    const t = setup({ interactive: true, answer: 'n' });
    await t.cli(['work', 'repos', 'add', t.repo]);
    await t.cli(['work', 'collect', '--since', '2026-11-14']);
    expect((await t.cli(['work', 'send'])).stdout).toContain('Cancelled');
    expect(t.host.posts).toHaveLength(0);
    const yes = setup({ interactive: true, answer: 'y' });
    await yes.cli(['work', 'repos', 'add', yes.repo]);
    await yes.cli(['work', 'collect', '--since', '2026-11-14']);
    expect((await yes.cli(['work', 'send', '--json'])).json.sent).toHaveLength(1);
  });

  it('keeps an entry the host refused, with its reason', async () => {
    const t = await held();
    t.host.reject = '2026-11-13';
    const out = await t.cli(['work', 'send', '--yes', '--json']);
    expect(out.json.refused).toHaveLength(1);
    expect(out.json.refused[0].error).toBe('refused');
    expect(readHeld(t.heldFile).filter((e) => e.status === 'held')).toHaveLength(1);
  });

  it('batches 50 at a time', async () => {
    const t = setup();
    const entries = Array.from({ length: 120 }, (_, i) => {
      const event = { kind: 'work.session', source: 'landflow-cli', sourceId: `acme/widgets@2026-11-14#${i}`, occurredAt: '2026-11-14T09:00:00Z', title: `t${i}` };
      return { id: String(i).padStart(8, '0'), sourceId: event.sourceId, day: '2026-11-14', status: 'held', event, heldAt: '2026-11-14T09:00:00Z' };
    });
    mkdirSync(join(t.home, 'config', 'work'), { recursive: true });
    writeFileSync(t.heldFile, JSON.stringify({ version: 1, entries }));
    await t.cli(['work', 'send', '--yes']);
    expect(t.host.posts.map((p) => p.events.length)).toEqual([50, 50, 20]);
  });

  it('forget deletes on the host and locally', async () => {
    const t = await held();
    await t.cli(['work', 'send', '--yes']);
    const out = await t.cli(['work', 'forget', 'acme/widgets@2026-11-13', '--json']);
    expect(out.json).toMatchObject({ ok: true, deletedOnHost: true, deletedLocally: true });
    expect(t.host.deletes).toEqual(['acme/widgets@2026-11-13?source=landflow-cli']);
    expect(readHeld(t.heldFile).map((e) => e.sourceId)).toEqual(['acme/widgets@2026-11-14']);
    expect((await t.cli(['work', 'forget', 'nowhere@missing', '--json'])).code).toBe(3);
  });
});

describe('repos', () => {
  it('adds, lists and removes', async () => {
    const t = setup();
    await t.cli(['work', 'repos', 'add', t.repo]);
    expect((await t.cli(['work', 'repos', 'list', '--json'])).json.repos).toEqual([{ path: t.repo, repo: 'acme/widgets' }]);
    expect((await t.cli(['work', 'repos', 'remove', t.repo, '--json'])).json.repos).toEqual([]);
    expect((await t.cli(['work', 'repos', 'remove', t.repo])).code).toBe(3);
    expect((await t.cli(['work', 'repos', 'bogus'])).code).toBe(2);
    expect(statSync(join(t.home, 'config', 'work', 'repos.json')).mode & 0o777).toBe(0o600);
  });
});

describe('the copied contract', () => {
  it('matches packages/protocol/src/work-events.ts', () => {
    const copy = readFileSync(new URL('../src/work/contract.ts', import.meta.url), 'utf8').split('\n').slice(2).join('\n');
    expect(copy).toBe(readFileSync(new URL('../../protocol/src/work-events.ts', import.meta.url), 'utf8'));
  });
});

describe('git arguments and a real repository', () => {
  it('gives git a midnight for a bare day and leaves out refs/stash', async () => {
    const fake = fakeRunner({ gh: false });
    await collectRepo(fake.runner, '/x', '2026-11-14');
    const log = fake.calls.find((c) => c.startsWith('git log')) as string;
    expect(log).toContain('--since=2026-11-14T00:00:00');
    expect(log).toContain('--branches --remotes');
    expect(log).not.toContain('--all');
  });

  it('finds a commit from earlier today and ignores a stash, with the real git', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'landflow-work-git-'));
    const git = (args: string[], env: Record<string, string> = {}) => execFileSync('git', args, { cwd: dir, env: { ...process.env, ...env }, stdio: 'pipe' }).toString();
    try {
      git(['init', '-q']);
      git(['config', 'user.email', 'dev@example.com']);
      git(['config', 'user.name', 'Dev']);
    } catch {
      return; // no git on this machine
    }
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const stamp = `${day}T00:05:00`;
    writeFileSync(join(dir, 'a.txt'), 'a');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'Early work'], { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp });
    writeFileSync(join(dir, 'a.txt'), 'b');
    git(['stash', '-q']);
    const collected = await collectRepo(defaultRunner, dir, day);
    expect(collected.commits.map((c) => c.subject)).toEqual(['Early work']);
  });
});

describe('a re-collect keeps the title the person edited', () => {
  const ev = (extra: Record<string, unknown> = {}) => ({ kind: 'work.session', source: 'landflow-cli', sourceId: 'acme/widgets@2026-11-14', occurredAt: '2026-11-14T09:00:00Z', title: 'Machine title', commits: 1, ...extra }) as never;
  const entry = (over: Partial<HeldEntry>): HeldEntry => ({ id: 'abcd1234', sourceId: 'acme/widgets@2026-11-14', day: '2026-11-14', status: 'held', event: ev({ title: 'My title' }), heldAt: '2026-11-14T10:00:00Z', titleEdited: true, ...over });
  const now = new Date('2026-11-14T18:00:00Z');

  it('leaves a held or sent entry alone when only the title differs', () => {
    for (const status of ['held', 'sent'] as const) {
      const before = [entry({ status })];
      const out = upsert(before, ev(), '2026-11-14', now);
      expect(out.changed).toBe(false);
      expect(out.entries).toBe(before);
    }
  });

  it('updates other fields, keeps the edited title and goes back to held', () => {
    const out = upsert([entry({ status: 'sent', serverId: 'srv_1' })], ev({ commits: 3 }), '2026-11-14', now);
    expect(out.entry).toMatchObject({ status: 'held', titleEdited: true, serverId: 'srv_1', event: { title: 'My title', commits: 3 } });
  });

  it('review --title marks the entry edited and a later collect keeps it', async () => {
    const t = setup();
    await t.cli(['work', 'repos', 'add', t.repo]);
    await t.cli(['work', 'collect', '--since', '2026-11-14']);
    const [a] = readHeld(t.heldFile);
    await t.cli(['work', 'review', '--title', a.id, 'Reviewed title']);
    await t.cli(['work', 'collect', '--since', '2026-11-14']);
    expect(readHeld(t.heldFile)[0]).toMatchObject({ titleEdited: true, event: { title: 'Reviewed title' } });
  });
});

describe('review --send is guarded like send', () => {
  async function held(autoSend = 'allowed') {
    const t = setup();
    t.host.autoSend = autoSend;
    await t.cli(['work', 'repos', 'add', t.repo]);
    await t.cli(['work', 'collect', '--since', '2026-11-13']);
    return t;
  }

  it('is refused without a terminal and without --yes', async () => {
    const t = await held();
    const out = await t.cli(['work', 'review', '--send', 'all', '--json']);
    expect(out.code).toBe(2);
    expect(t.host.posts).toHaveLength(0);
  });

  it('is refused with --yes when the host forbids automatic sending, and works when allowed', async () => {
    const t = await held('forbidden');
    expect((await t.cli(['work', 'review', '--send', 'all', '--yes', '--json'])).code).toBe(4);
    expect(t.host.posts).toHaveLength(0);
    t.host.autoSend = 'allowed';
    expect((await t.cli(['work', 'review', '--send', 'all', '--yes', '--json'])).json.sent).toHaveLength(2);
  });

  it('send --yes refuses when the setting cannot be read', async () => {
    const t = await held();
    t.host.fetch = (async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const out = await t.cli(['work', 'send', '--yes', '--json'], { fetch: t.host.fetch });
    expect(out.code).not.toBe(0);
    expect(t.host.posts).toHaveLength(0);
  });
});
