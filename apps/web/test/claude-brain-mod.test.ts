/**
 * The landflow-brain mod's pure rules (claude-plugins/landflow-brain/hooks): the journal, the summary and the queue. The
 * hooks themselves are tested with Claude Code's kit: `claude plugin test apps/web/claude-plugins/landflow-brain`.
 * Tokens below are built from parts so no file holds one.
 */
import { describe, expect, it } from 'vitest';
import { validateWorkEvent } from '../../../packages/protocol/src/work-events';
import { BACKOFF_MAX_MS, QUEUE_MAX, backoffMs, due, emptyQueue, enqueue, serverUrl, settle } from '../claude-plugins/landflow-brain/hooks/client';
import { addArea, addPrs, areaOf, bashFacts, isAllowed, newEntry, parseRepos, repoSlug } from '../claude-plugins/landflow-brain/hooks/journal';
import { redact, summaryOf, titleFrom, toEvent } from '../claude-plugins/landflow-brain/hooks/summary';

const entry = () => ({ ...newEntry({ id: 'e-1', sourceId: 'cc-1', repo: 'acme/widgets', branch: 'feature/x', now: Date.parse('2026-11-14T09:00:00Z') }), turns: 3, title: 'Fix the login redirect' });
const event = (sourceId: string) => ({ ...toEvent({ ...entry(), sourceId }) });

describe('areaOf', () => {
  it('is a directory, never a file name or an absolute path', () => {
    expect(areaOf('/work/repo/apps/web/src/app.ts', '/work/repo')).toBe('apps/web');
    expect(areaOf('apps/web/src/app.ts', '/work/repo')).toBe('apps/web');
    expect(areaOf('/work/repo/README.md', '/work/repo')).toBe('.');
    expect(areaOf('/work/repo/docs/guide.md', '/work/repo')).toBe('docs');
    expect(areaOf('/etc/hosts', '/work/repo')).toBeUndefined();
    expect(areaOf('/work/repo/../other/x/y.ts', '/work/repo')).toBeUndefined();
    expect(areaOf('/work/repo/next.js/src/a.ts', '/work/repo')).toBe('src');
    for (const path of ['/work/repo/a/b/c/d.ts', 'x/y.py', '/work/repo/.github/workflows/ci.yml']) {
      const area = areaOf(path, '/work/repo');
      expect(area?.startsWith('/')).toBeFalsy();
      expect(area).not.toMatch(/\.[a-z]{1,4}$/);
    }
  });
});

describe('the repository allow-list', () => {
  it('reads the slug of a remote and records only allowed repositories', () => {
    expect(repoSlug('https://github.com/acme/widgets.git')).toBe('acme/widgets');
    expect(repoSlug('git@github.com:acme/widgets.git')).toBe('acme/widgets');
    expect(repoSlug('ssh://git@host.example:2222/acme/widgets')).toBe('acme/widgets');
    expect(repoSlug('')).toBeUndefined();
    const allowed = parseRepos('Acme/Widgets, acme/tools nonsense');
    expect(allowed).toEqual(['acme/widgets', 'acme/tools']);
    expect(isAllowed(allowed, 'acme/widgets')).toBe(true);
    expect(isAllowed(allowed, 'acme/secret')).toBe(false);
    expect(isAllowed([], 'acme/widgets')).toBe(false);
    expect(isAllowed(allowed, undefined)).toBe(false);
  });
});

describe('commit and pull request detection', () => {
  it('counts a commit that worked and reads the URL of a pull request', () => {
    expect(bashFacts('git add -A && git commit -m "x"', '[main abc] x').commits).toBe(1);
    expect(bashFacts('git commit -m "x"', 'nothing to commit, working tree clean').commits).toBe(0);
    expect(bashFacts('git commit -m "x"', 'error', true).commits).toBe(0);
    expect(bashFacts('git push -u origin feature', '').prs).toEqual([]);
    expect(bashFacts('gh pr create --fill', 'https://github.com/acme/widgets/pull/12\n').prs).toEqual([{ url: 'https://github.com/acme/widgets/pull/12', state: 'opened' }]);
    expect(bashFacts('gh pr merge 12 --squash', '').prs).toEqual([]);
    expect(bashFacts('gh pr merge https://github.com/acme/widgets/pull/12', '').prs).toEqual([{ url: 'https://github.com/acme/widgets/pull/12', state: 'merged' }]);
    const prs = addPrs([{ url: 'https://github.com/acme/widgets/pull/12', state: 'opened' }], [{ url: 'https://github.com/acme/widgets/pull/12', state: 'merged' }]);
    expect(prs).toEqual([{ url: 'https://github.com/acme/widgets/pull/12', state: 'merged' }]);
    expect(addArea(['a'], 'a')).toEqual(['a']);
  });
});

describe('the summary', () => {
  it('is deterministic and masks a token in the first prompt', () => {
    const token = ['gh', 'p_', 'a'.repeat(36)].join('');
    const prompt = `Use ${token} to fix the login redirect. Then run the tests.`;
    const title = titleFrom(prompt);
    expect(title).toBe('Use [redacted GitHub token] to fix the login redirect.');
    expect(titleFrom(prompt)).toBe(title);
    expect(redact(token)).toBe('[redacted GitHub token]');
  });

  it('reduces file paths to directories and keeps no code, URL or email', () => {
    expect(titleFrom('Fix /Users/x/repo/apps/web/src/app.ts please')).not.toMatch(/app\.ts|Users/);
    expect(titleFrom('Fix apps/web/src/app.ts today.')).toBe('Fix web/src today.');
    expect(titleFrom('See https://example.com/a?b=1 and mail me@example.com now.')).toBe('See and mail now.');
    expect(titleFrom('const a = () => { return 1; }')).toBe('Coding session');
    expect(titleFrom('Fix this:\n```ts\nconst secret = 1\n```')).toBe('Fix this:');
    expect(titleFrom('x'.repeat(500)).length).toBeLessThanOrEqual(200);
    expect(titleFrom(undefined)).toBe('Coding session');
  });

  it('makes an event that validates, private, with counts and directories only', () => {
    const value = { ...entry(), areas: ['apps/web', 'docs'], commits: 2, prs: [{ url: 'https://github.com/acme/widgets/pull/12', state: 'opened' as const }], endedAt: '2026-11-14T10:00:00Z' };
    const sent = toEvent(value);
    const checked = validateWorkEvent(sent);
    expect(checked.ok).toBe(true);
    expect(sent).toMatchObject({ kind: 'work.session', source: 'claude-code', sourceId: 'cc-1', visibility: 'private', turns: 3, commits: 2 });
    expect(Object.keys(sent).sort()).toEqual(['areas', 'branch', 'commits', 'endedAt', 'kind', 'occurredAt', 'prs', 'repo', 'source', 'sourceId', 'summary', 'title', 'turns', 'visibility']);
    expect(summaryOf(value)).toBe('3 turns, 2 commits, 1 pull request in acme/widgets; apps/web, docs');
    expect(JSON.stringify(sent)).not.toMatch(/\/Users|\.ts"|diff/);
  });
});

describe('the queue', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  it('keeps at most 500 events and 14 days, oldest dropped, one per session', () => {
    let queue = emptyQueue();
    for (let i = 0; i < QUEUE_MAX + 20; i++) queue = enqueue(queue, event(`s-${i}`), now + i);
    expect(queue.items).toHaveLength(QUEUE_MAX);
    expect(queue.items[0]?.event.sourceId).toBe('s-20');
    queue = enqueue(queue, event('s-100'), now + 1000);
    expect(queue.items).toHaveLength(QUEUE_MAX);
    const old = { ...emptyQueue(), items: [{ event: event('old'), at: now - 15 * 86_400_000 }] };
    expect(enqueue(old, event('new'), now).items.map(item => item.event.sourceId)).toEqual(['new']);
  });

  it('backs off from 30 s to 30 min and recovers on success', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
    let queue = enqueue(emptyQueue(), event('a'), now);
    const batch = due(queue, now);
    expect(batch).toHaveLength(1);
    queue = settle(queue, batch, 503, now);
    expect(queue.items).toHaveLength(1);
    expect(due(queue, now + 29_000)).toEqual([]);
    expect(due(queue, now + 30_000)).toHaveLength(1);
    queue = settle(queue, due(queue, now + 30_000), undefined, now + 30_000);
    expect(queue.nextAt).toBe(now + 30_000 + 60_000);
    queue = settle(queue, due(queue, queue.nextAt), 200, queue.nextAt);
    expect(queue).toMatchObject({ items: [], failures: 0, nextAt: 0 });
  });

  it('stops sending on a 401', () => {
    let queue = enqueue(emptyQueue(), event('a'), now);
    queue = settle(queue, due(queue, now), 401, now);
    expect(queue.stopped).toBe('key');
    expect(queue.items).toHaveLength(1);
    expect(due(queue, now + 99 * 3_600_000)).toEqual([]);
  });
});

describe('the server URL', () => {
  it('is https, or http on localhost, and nothing else', () => {
    expect(serverUrl('https://landflow.example.com/')).toBe('https://landflow.example.com');
    expect(serverUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(serverUrl('http://landflow.example.com')).toBeUndefined();
    expect(serverUrl('http://localhost.evil.example')).toBeUndefined();
    expect(serverUrl('ftp://x')).toBeUndefined();
    expect(serverUrl(undefined)).toBeUndefined();
  });
});
