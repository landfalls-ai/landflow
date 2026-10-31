/** The GitHub node and the githubApi credential against a fake GitHub REST API. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { GitHub, parseFiles } from '../src/nodes/github';
import { FakeGitHub, OWNER, REPO, TOKEN } from './fake-github';
import { jsonOf, run, startFakeApi, testCredentials, type FakeApi } from './helpers';

const fake = new FakeGitHub();
let api: FakeApi;
const creds = () => ({ githubApi: { accessToken: TOKEN, baseUrl: `${api.url}/api/v3/` } });
const call = (parameters: JsonObject, credentials = creds()) => run(GitHub, { owner: OWNER, repository: REPO, ...parameters }, { credentials });
const repoUrl = `/api/v3/repos/${OWNER}/${REPO}`;
const summary = () => api.requests.map((r) => `${r.method} ${r.path.replace(repoUrl, '')}`);

beforeAll(async () => {
  api = await startFakeApi(fake.handle);
});
afterAll(() => api.close());
beforeEach(() => {
  fake.reset();
  api.requests.length = 0;
});

describe('githubApi credential', () => {
  it('GET /user, with the token as a Bearer and the API version header', async () => {
    const result = await testCredentials('githubApi', { accessToken: TOKEN, baseUrl: `${api.url}/api/v3` });
    expect(result).toEqual({ ok: true, message: `Authenticated as octo-bot at ${api.url}/api/v3` });
    expect(api.requests[0].headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'x-github-api-version': '2022-11-28', accept: 'application/vnd.github+json' });
    expect(await testCredentials('githubApi', { accessToken: 'ghp_nope', baseUrl: `${api.url}/api/v3` })).toEqual({ ok: false, message: 'GitHub API error 401: Bad credentials' });
  });
});

describe('Repository', () => {
  it('gets a repository', async () => {
    const response = await call({ resource: 'repository', operation: 'get' });
    expect(response.error).toBeUndefined();
    expect(jsonOf(response)[0]).toMatchObject({ fullName: 'acme/widgets', defaultBranch: 'main', private: true });
    expect(summary()).toEqual(['GET ']);
  });
});

describe('Repository: compare', () => {
  it('lists what a branch holds beyond another, with the files and their patches', async () => {
    const tree = fake.addTree({ ...fake.trees.get(fake.commits.get(fake.refs.get('main')!)!.tree)!.files, 'docs/guide.md': fake.addBlob('Guide v2\nmore\n'), 'src/new.ts': fake.addBlob('export {};\n') });
    fake.refs.set('feature', fake.addCommit('Change', tree, [fake.refs.get('main')!]));
    const response = await call({ resource: 'repository', operation: 'compare', compareBase: 'main', compareHead: 'feature' });
    expect(response.error).toBeUndefined();
    expect(jsonOf(response)[0]).toMatchObject({
      base: 'main',
      head: 'feature',
      status: 'ahead',
      aheadBy: 1,
      behindBy: 0,
      totalCommits: 1,
      url: 'https://github.test/acme/widgets/compare/main...feature',
      truncated: false,
      files: [
        { path: 'docs/guide.md', status: 'modified', additions: 2, deletions: 1, previousPath: null, patch: expect.stringContaining('+more') },
        { path: 'src/new.ts', status: 'added', additions: 1, deletions: 0 },
      ],
    });
    expect(jsonOf(response)[0]).not.toHaveProperty('note');
    expect(api.requests.map((r) => `${r.method} ${r.path.replace(repoUrl, '')}`)).toEqual(['GET /compare/main...feature']);
  });

  it('compares against the default branch when no base is given, and escapes branch names', async () => {
    fake.refs.set('agents/x', fake.refs.get('main')!);
    const response = await call({ resource: 'repository', operation: 'compare', compareHead: 'agents/x' });
    expect(jsonOf(response)[0]).toMatchObject({ base: 'main', status: 'identical', aheadBy: 0, files: [] });
    expect(summary()).toEqual(['GET ', 'GET /compare/main...agents/x']);
  });

  it('cuts at 300 files and says so', async () => {
    fake.refs.set('many', fake.refs.get('main')!);
    const out = jsonOf(await call({ resource: 'repository', operation: 'compare', compareBase: 'main', compareHead: 'many' }))[0];
    expect(out.files).toHaveLength(300);
    expect(out).toMatchObject({ truncated: true, note: expect.stringMatching(/at most 300 files/) });
    expect(api.requests.map((r) => r.query.get('page'))).toEqual(['1', '2', '3']);
  });

  it('fails on a branch that does not exist', async () => {
    const response = await call({ resource: 'repository', operation: 'compare', compareHead: 'nope' });
    expect(response.error?.message).toBe('GitHub API error 404: Not Found');
    expect((await call({ resource: 'repository', operation: 'compare' })).error?.message).toBe('Head is required');
  });
});

describe('File', () => {
  it('gets a file decoded, with its sha', async () => {
    const response = await call({ resource: 'file', operation: 'get', path: 'docs/guide.md', branch: 'main' });
    expect(jsonOf(response)[0]).toMatchObject({ path: 'docs/guide.md', content: 'Guide v1\n', size: 9 });
    expect(jsonOf(response)[0].sha).toBe(fake.trees.get(fake.commits.get(fake.refs.get('main')!)!.tree)!.files['docs/guide.md']);
    expect(api.requests[0].path).toBe(`${repoUrl}/contents/docs/guide.md`);
    expect(api.requests[0].query.get('ref')).toBe('main');
  });

  it('reads a big file through the blob API', async () => {
    const big = 'x'.repeat(2000);
    fake.refs.set('main', fake.addCommit('big', fake.addTree({ 'big.txt': fake.addBlob(big) }), []));
    const response = await call({ resource: 'file', operation: 'get', path: 'big.txt' });
    expect(jsonOf(response)[0].content).toBe(big);
    expect(summary()).toEqual(['GET /contents/big.txt', expect.stringMatching(/^GET \/git\/blobs\/[0-9a-f]+$/)]);
  });

  it('refuses a directory as a file and a file as a directory', async () => {
    expect((await call({ resource: 'file', operation: 'get', path: 'docs' })).error?.message).toBe('"docs" is a directory, not a file');
    expect((await call({ resource: 'file', operation: 'list', path: 'README.md' })).error?.message).toBe('"README.md" is a file, not a directory');
  });

  it('lists a directory and the root', async () => {
    const docs = jsonOf(await call({ resource: 'file', operation: 'list', path: 'docs/' }));
    expect(docs.map((e) => [e.name, e.type])).toEqual([
      ['guide.md', 'file'],
      ['notes.txt', 'file'],
    ]);
    const root = jsonOf(await call({ resource: 'file', operation: 'list', path: '' }));
    expect(root.map((e) => [e.path, e.type])).toEqual([
      ['README.md', 'file'],
      ['docs', 'dir'],
    ]);
  });

  it('creates a file on a branch', async () => {
    const response = await call({ resource: 'file', operation: 'createOrUpdate', path: 'docs/new.md', content: 'héllo', message: 'Add new', branch: 'main' });
    expect(response.error).toBeUndefined();
    expect(jsonOf(response)[0]).toMatchObject({ created: true, path: 'docs/new.md', commit: { message: 'Add new' } });
    expect(fake.read('main', 'docs/new.md')).toBe('héllo');
    expect(summary()).toEqual(['GET /contents/docs/new.md', 'PUT /contents/docs/new.md']);
    expect(api.requests[1].body).toMatchObject({ branch: 'main', message: 'Add new' });
    expect(api.requests[1].body.sha).toBeUndefined();
  });

  it('updates a file, looking up its sha, or using the one given', async () => {
    const updated = await call({ resource: 'file', operation: 'createOrUpdate', path: 'docs/guide.md', content: 'Guide v2\n', message: 'Update guide' });
    expect(jsonOf(updated)[0]).toMatchObject({ created: false });
    expect(fake.read('main', 'docs/guide.md')).toBe('Guide v2\n');
    expect(api.requests[1].body.sha).toBeTruthy();
    expect(api.requests[1].body.branch).toBeUndefined();

    const stale = await call({ resource: 'file', operation: 'createOrUpdate', path: 'docs/guide.md', content: 'v3', message: 'Stale', sha: 'deadbeef' });
    expect(stale.error?.message).toMatch(/^GitHub API error 409: docs\/guide\.md does not match/);
    expect(stale.error?.description).toMatch(/Run the node again/);
  });

  it('needs a path and a message', async () => {
    expect((await call({ resource: 'file', operation: 'get', path: '' })).error?.message).toBe('Path is required');
    expect((await call({ resource: 'file', operation: 'createOrUpdate', path: 'a.md', content: 'x', message: '' })).error?.message).toBe('Commit Message is required');
  });
});

describe('Files: Commit', () => {
  const files = [
    { path: 'docs/guide.md', content: 'Guide v2\n' },
    { path: 'src/new/file.ts', content: 'export {};\n' },
  ];

  it('commits several files in ONE commit on an existing branch', async () => {
    const before = fake.refs.get('main')!;
    const response = await call({ resource: 'files', operation: 'commit', branch: 'main', message: 'Update docs and add code', files: JSON.stringify(files) });
    expect(response.error).toBeUndefined();
    const out = jsonOf(response)[0];
    expect(out).toMatchObject({ branch: 'main', createdBranch: false, parentSha: before });
    expect(fake.refs.get('main')).toBe(out.commitSha);
    expect(fake.commits.get(out.commitSha as string)).toMatchObject({ message: 'Update docs and add code', parents: [before] });
    expect(fake.read('main', 'docs/guide.md')).toBe('Guide v2\n');
    expect(fake.read('main', 'src/new/file.ts')).toBe('export {};\n');
    // The untouched files are still there: the tree is built on the tip's tree.
    expect(fake.read('main', 'README.md')).toBe('# Widgets\n');
    expect(out.files).toEqual([
      { path: 'docs/guide.md', sha: expect.any(String) },
      { path: 'src/new/file.ts', sha: expect.any(String) },
    ]);
    expect(summary()).toEqual([
      'GET /git/ref/heads/main',
      `GET /git/commits/${before}`,
      'POST /git/blobs',
      'POST /git/blobs',
      'POST /git/trees',
      'POST /git/commits',
      'PATCH /git/refs/heads/main',
    ]);
    const [, , , , tree, commit, ref] = api.requests;
    expect(tree.body.base_tree).toBe(fake.commits.get(before)!.tree);
    expect(tree.body.tree).toEqual([
      { path: 'docs/guide.md', mode: '100644', type: 'blob', sha: expect.any(String) },
      { path: 'src/new/file.ts', mode: '100644', type: 'blob', sha: expect.any(String) },
    ]);
    expect(commit.body).toEqual({ message: 'Update docs and add code', tree: out.treeSha, parents: [before] });
    expect(ref.body).toEqual({ sha: out.commitSha, force: false });
  });

  it('creates the branch from the base branch when it is missing and asked to', async () => {
    const main = fake.refs.get('main')!;
    const response = await call({ resource: 'files', operation: 'commit', branch: 'feature/docs-update', message: 'Docs', files, createBranch: true, baseBranch: 'main' });
    expect(response.error).toBeUndefined();
    const out = jsonOf(response)[0];
    expect(out).toMatchObject({ branch: 'feature/docs-update', createdBranch: true, parentSha: main });
    expect(fake.refs.get('feature/docs-update')).toBe(out.commitSha);
    expect(fake.refs.get('main')).toBe(main);
    expect(fake.read('feature/docs-update', 'README.md')).toBe('# Widgets\n');
    expect(summary()).toEqual([
      'GET /git/ref/heads/feature/docs-update',
      'GET /git/ref/heads/main',
      `GET /git/commits/${main}`,
      'POST /git/blobs',
      'POST /git/blobs',
      'POST /git/trees',
      'POST /git/commits',
      'POST /git/refs',
    ]);
    expect(api.requests.at(-1)!.body).toEqual({ ref: 'refs/heads/feature/docs-update', sha: out.commitSha });
  });

  it('starts a new branch from the default branch when no base is given', async () => {
    const response = await call({ resource: 'files', operation: 'commit', branch: 'bot/x', message: 'X', files, createBranch: true });
    expect(response.error).toBeUndefined();
    expect(summary().slice(0, 4)).toEqual(['GET /git/ref/heads/bot/x', 'GET ', 'GET /git/ref/heads/main', `GET /git/commits/${fake.commits.get(fake.refs.get('bot/x')!)!.parents[0]}`]);
  });

  it('fails on a missing branch unless asked to create it, and creates nothing', async () => {
    const response = await call({ resource: 'files', operation: 'commit', branch: 'nope', message: 'X', files });
    expect(response.error?.message).toBe('The branch "nope" does not exist');
    expect(response.error?.description).toMatch(/Create Branch If Missing/);
    expect(summary()).toEqual(['GET /git/ref/heads/nope']);
    const noBase = await call({ resource: 'files', operation: 'commit', branch: 'nope', message: 'X', files, createBranch: true, baseBranch: 'ghost' });
    expect(noBase.error?.message).toBe('The base branch "ghost" does not exist');
    expect(fake.refs.has('nope')).toBe(false);
  });

  it('accepts files from an expression (an array) and base64 content', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    const response = await call({ resource: 'files', operation: 'commit', branch: 'main', message: 'Binary', files: [{ path: 'img/a.png', content: png.toString('base64'), encoding: 'base64' }] });
    expect(response.error).toBeUndefined();
    expect(api.requests[2].body).toEqual({ content: png.toString('base64'), encoding: 'base64' });
    const blob = fake.trees.get(fake.commits.get(fake.refs.get('main')!)!.tree)!.files['img/a.png'];
    expect(fake.blobs.get(blob)).toEqual(png);
  });

  it('keeps the other commit when the branch moved: GitHub refuses a non-fast-forward', async () => {
    fake.refConflictOnce = true;
    const before = fake.refs.get('main');
    const response = await call({ resource: 'files', operation: 'commit', branch: 'main', message: 'Race', files });
    expect(response.error?.message).toBe('GitHub API error 422: Update is not a fast forward');
    expect(fake.refs.get('main')).toBe(before);
  });

  it('validates the files before calling GitHub', async () => {
    const bad = async (value: unknown) => (await call({ resource: 'files', operation: 'commit', branch: 'main', message: 'X', files: value as string })).error?.message;
    expect(await bad('')).toMatch(/Files is required/);
    expect(await bad('{oops')).toMatch(/Files is not valid JSON/);
    expect(await bad('[]')).toMatch(/non-empty JSON array/);
    expect(await bad('[{"content":"x"}]')).toBe('Files[0] has no "path"');
    expect(await bad('[{"path":"/abs.md","content":"x"}]')).toBe('Files[0] has an invalid path "/abs.md"');
    expect(await bad('[{"path":"a/../b.md","content":"x"}]')).toBe('Files[0] has an invalid path "a/../b.md"');
    expect(await bad('[{"path":"a.md"}]')).toBe('Files[0] ("a.md") needs a string "content"');
    expect(await bad('[{"path":"a.md","content":"1"},{"path":"a.md","content":"2"}]')).toBe('Files[1]: "a.md" is listed twice');
    expect(await bad('[{"path":"a.md","content":"x","encoding":"latin1"}]')).toMatch(/use "utf-8" or "base64"/);
    expect(api.requests).toHaveLength(0);
    expect(parseFiles([{ path: 'ok.md', content: '' }])).toEqual([{ path: 'ok.md', content: '', encoding: 'utf-8' }]);
  });
});

describe('Branch', () => {
  it('creates a branch from the default branch, a base branch or a commit', async () => {
    const main = fake.refs.get('main')!;
    const fromDefault = await call({ resource: 'branch', operation: 'create', branch: 'b1' });
    expect(jsonOf(fromDefault)[0]).toEqual({ branch: 'b1', ref: 'refs/heads/b1', sha: main });
    expect(summary()).toEqual(['GET ', 'GET /git/ref/heads/main', 'POST /git/refs']);
    expect(api.requests[2].body).toEqual({ ref: 'refs/heads/b1', sha: main });

    fake.refs.set('develop', fake.addCommit('dev', fake.commits.get(main)!.tree, [main]));
    const fromBase = await call({ resource: 'branch', operation: 'create', branch: 'b2', baseBranch: 'develop' });
    expect(jsonOf(fromBase)[0].sha).toBe(fake.refs.get('develop'));

    const fromSha = await call({ resource: 'branch', operation: 'create', branch: 'b3', baseSha: main });
    expect(jsonOf(fromSha)[0].sha).toBe(main);
    expect(fake.refs.get('b3')).toBe(main);
  });

  it('gets a branch with the commit it points at and the files that commit changed', async () => {
    const response = await call({ resource: 'branch', operation: 'get', branch: 'main' });
    expect(jsonOf(response)[0]).toMatchObject({ branch: 'main', ref: 'refs/heads/main', sha: fake.refs.get('main'), author: 'Octo Bot', date: '2026-10-31T10:00:00Z' });

    const committed = await call({ resource: 'files', operation: 'commit', branch: 'agents/x', baseBranch: 'main', message: 'plan: x plugin', files: [{ path: 'plugins/x/PLAN.md', content: '# Plan\n\nOne node.' }], createBranch: true });
    expect(committed.error).toBeUndefined();
    const branch = jsonOf(await call({ resource: 'branch', operation: 'get', branch: 'agents/x' }))[0];
    expect(branch).toMatchObject({
      sha: fake.refs.get('agents/x'),
      message: 'plan: x plugin',
      url: `https://github.test/${OWNER}/${REPO}/commit/${fake.refs.get('agents/x')}`,
      stats: { additions: 3, deletions: 0, files: 1 },
      files: [{ path: 'plugins/x/PLAN.md', status: 'added', additions: 3, deletions: 0 }],
    });
    expect(summary().slice(-2)).toEqual(['GET /git/ref/heads/agents/x', `GET /commits/${fake.refs.get('agents/x')}`]);
  });

  it('maps an existing branch to 422 and a missing one to 404', async () => {
    const exists = await call({ resource: 'branch', operation: 'create', branch: 'main' });
    expect(exists.error?.message).toBe('GitHub API error 422: Reference already exists');
    expect(exists.error?.description).toMatch(/branch already exists/);
    const missing = await call({ resource: 'branch', operation: 'get', branch: 'nope' });
    expect(missing.error?.message).toBe('GitHub API error 404: Not Found');
  });
});

describe('Pull Request', () => {
  const open = () => call({ resource: 'pullRequest', operation: 'create', title: 'Docs', head: 'feature', base: 'main', body: 'Why' });
  beforeEach(() => {
    fake.refs.set('feature', fake.refs.get('main')!);
  });

  it('creates a draft by default', async () => {
    const response = await open();
    expect(response.error).toBeUndefined();
    expect(jsonOf(response)[0]).toMatchObject({ number: 1, title: 'Docs', draft: true, head: 'feature', base: 'main', state: 'open', url: expect.stringContaining('/pull/1') });
    expect(api.requests[0].body).toEqual({ title: 'Docs', head: 'feature', base: 'main', draft: true, body: 'Why' });
  });

  it('can open a ready pull request', async () => {
    const response = await call({ resource: 'pullRequest', operation: 'create', title: 'Docs', head: 'feature', base: 'main', draft: false });
    expect(jsonOf(response)[0].draft).toBe(false);
    expect(api.requests[0].body.body).toBeUndefined();
  });

  it('reports a 422 with GitHub’s field detail', async () => {
    const response = await call({ resource: 'pullRequest', operation: 'create', title: 'Docs', head: 'ghost', base: 'main' });
    expect(response.error?.message).toBe('GitHub API error 422: Validation Failed: PullRequest head invalid');
    expect(response.error?.description).toMatch(/refused its content/);
  });

  it('gets a pull request', async () => {
    await open();
    const response = await call({ resource: 'pullRequest', operation: 'get', pullNumber: 1 });
    expect(jsonOf(response)[0]).toMatchObject({ number: 1, author: 'octo-bot', headSha: fake.refs.get('main'), changedFiles: 2 });
    expect((await call({ resource: 'pullRequest', operation: 'get', pullNumber: 9 })).error?.message).toBe('GitHub API error 404: Not Found');
    expect((await call({ resource: 'pullRequest', operation: 'get', pullNumber: 0 })).error?.message).toBe('Pull Request Number is required');
  });

  it('lists files with a limit, and all of them across pages', async () => {
    await open();
    api.requests.length = 0;
    const some = jsonOf(await call({ resource: 'pullRequest', operation: 'listFiles', pullNumber: 1, limit: 3 }));
    expect(some.map((f) => f.path)).toEqual(['src/file-000.ts', 'src/file-001.ts', 'src/file-002.ts']);
    expect(some[0]).toMatchObject({ status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@' });
    expect(api.requests).toHaveLength(1);
    api.requests.length = 0;
    const all = jsonOf(await call({ resource: 'pullRequest', operation: 'listFiles', pullNumber: 1, returnAll: true }));
    expect(all).toHaveLength(130);
    expect(api.requests.map((r) => r.query.get('page'))).toEqual(['1', '2']);
  });

  it('comments on a pull request', async () => {
    await open();
    const response = await call({ resource: 'pullRequest', operation: 'comment', pullNumber: 1, commentBody: 'Looks good' });
    expect(jsonOf(response)[0]).toMatchObject({ body: 'Looks good', author: 'octo-bot' });
    expect(api.requests.at(-1)).toMatchObject({ method: 'POST', path: `${repoUrl}/issues/1/comments` });
    expect(fake.comments).toEqual([{ number: 1, body: 'Looks good' }]);
  });

  it('merges a ready pull request, squashed by default, only if its head is still the checked commit', async () => {
    await call({ resource: 'pullRequest', operation: 'create', title: 'Docs', head: 'feature', base: 'main', draft: false });
    const head = fake.refs.get('feature')!;
    const moved = await call({ resource: 'pullRequest', operation: 'merge', pullNumber: 1, expectedHeadSha: 'not-the-head' });
    expect(moved.error?.message).toBe('GitHub API error 409: Head branch was modified. Review and try the merge again.');
    expect(moved.error?.description).toMatch(/something new was pushed/);
    const response = await call({ resource: 'pullRequest', operation: 'merge', pullNumber: 1, expectedHeadSha: head, commitTitle: 'Docs (#1)' });
    expect(jsonOf(response)[0]).toMatchObject({ number: 1, merged: true, sha: 'merged-sha', method: 'squash', url: expect.stringContaining('/pull/1') });
    expect(api.requests.at(-1)).toMatchObject({ method: 'PUT', path: `${repoUrl}/pulls/1/merge`, body: { merge_method: 'squash', sha: head, commit_title: 'Docs (#1)' } });
    expect(fake.pulls[0]).toMatchObject({ merged: true, state: 'closed' });
  });

  it('says why GitHub refuses to merge a draft', async () => {
    await open();
    const response = await call({ resource: 'pullRequest', operation: 'merge', pullNumber: 1, mergeMethod: 'merge' });
    expect(response.error?.message).toBe('GitHub API error 405: Pull Request is still a draft');
    expect(response.error?.description).toMatch(/a draft, a conflict/);
  });
});

describe('artifacts', () => {
  const web = () => api.url;

  it('reports a created pull request, a created issue and a created branch', async () => {
    fake.refs.set('feature', fake.refs.get('main')!);
    const pull = await call({ resource: 'pullRequest', operation: 'create', title: 'Docs', head: 'feature', base: 'main' });
    expect(pull.records).toMatchObject([{ type: 'artifact', kind: 'pull_request', name: 'PR #1: Docs', url: expect.stringContaining('/pull/1'), data: { number: 1, head: 'feature', base: 'main' } }]);

    const issue = await call({ resource: 'issue', operation: 'create', title: 'Broken' });
    expect(issue.records).toMatchObject([{ type: 'artifact', kind: 'ticket', name: 'Issue #1: Broken', url: expect.stringContaining('/issues/1') }]);

    const branch = await call({ resource: 'branch', operation: 'create', branch: 'bot/x' });
    expect(branch.records).toMatchObject([{ type: 'artifact', kind: 'branch', name: 'Branch bot/x', url: `${web()}/${OWNER}/${REPO}/tree/bot/x` }]);
  });

  it('reports the branch a commit creates, and nothing for reads or a commit onto an existing branch', async () => {
    const created = await call({ resource: 'files', operation: 'commit', branch: 'feature/new', message: 'M', files: JSON.stringify([{ path: 'a.md', content: 'a' }]), createBranch: true });
    expect(created.records).toMatchObject([{ kind: 'branch', name: 'Branch feature/new' }]);
    const existing = await call({ resource: 'files', operation: 'commit', branch: 'main', message: 'M', files: JSON.stringify([{ path: 'a.md', content: 'b' }]) });
    expect(existing.records).toBeUndefined();
    expect((await call({ resource: 'repository', operation: 'get' })).records).toBeUndefined();
  });

  it('reports nothing when the call fails', async () => {
    const response = await call({ resource: 'pullRequest', operation: 'create', title: 'Docs', head: 'ghost', base: 'main' });
    expect(response.error).toBeDefined();
    expect(response.records).toBeUndefined();
  });
});

describe('Issue', () => {
  it('creates an issue with labels and assignees', async () => {
    const response = await call({ resource: 'issue', operation: 'create', title: 'Broken', body: 'Steps', options: { labels: 'bug, triage', assignees: 'octocat' } });
    expect(jsonOf(response)[0]).toMatchObject({ number: 1, title: 'Broken', state: 'open', labels: ['bug', 'triage'] });
    expect(api.requests[0].body).toEqual({ title: 'Broken', body: 'Steps', labels: ['bug', 'triage'], assignees: ['octocat'] });
  });

  it('creates a bare issue', async () => {
    await call({ resource: 'issue', operation: 'create', title: 'Bare' });
    expect(api.requests[0].body).toEqual({ title: 'Bare' });
  });

  it('comments on an issue', async () => {
    await call({ resource: 'issue', operation: 'create', title: 'Broken' });
    const response = await call({ resource: 'issue', operation: 'comment', issueNumber: 1, commentBody: 'On it' });
    expect(jsonOf(response)[0]).toMatchObject({ body: 'On it' });
    expect((await call({ resource: 'issue', operation: 'comment', issueNumber: 1, commentBody: '' })).error?.message).toBe('Comment is required');
    expect((await call({ resource: 'issue', operation: 'comment', issueNumber: 7, commentBody: 'x' })).error?.message).toBe('GitHub API error 404: Not Found');
  });
});

describe('Errors', () => {
  it('maps 401, 403, 404 and 422 with GitHub’s message and a hint', async () => {
    const bad = await call({ resource: 'repository', operation: 'get' }, { githubApi: { accessToken: 'ghp_wrong', baseUrl: `${api.url}/api/v3` } });
    expect(bad.error).toMatchObject({ message: 'GitHub API error 401: Bad credentials', itemIndex: 0 });
    expect(bad.error?.description).toMatch(/rejected the token/);

    fake.failNext = { status: 403, body: { message: 'Resource not accessible by personal access token' } };
    const forbidden = await call({ resource: 'repository', operation: 'get' });
    expect(forbidden.error?.message).toBe('GitHub API error 403: Resource not accessible by personal access token');
    expect(forbidden.error?.description).toMatch(/not allowed to do this.*scopes/);

    fake.failNext = { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793440000' }, body: { message: 'API rate limit exceeded' } };
    expect((await call({ resource: 'repository', operation: 'get' })).error?.description).toMatch(/rate limit is used up; it resets at 2026-/);

    expect((await call({ resource: 'repository', operation: 'get', repository: 'ghost' })).error?.message).toBe('GitHub API error 404: Not Found');
    const missing = await call({ resource: 'repository', operation: 'get', repository: 'ghost' });
    expect(missing.error?.description).toMatch(/private repository the token cannot see/);

    fake.failNext = { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'No commits between main and feature' }, 'second problem'] } };
    const invalid = await call({ resource: 'pullRequest', operation: 'create', title: 'T', head: 'feature', base: 'main' });
    expect(invalid.error?.message).toBe('GitHub API error 422: Validation Failed: No commits between main and feature; second problem');
  });

  it('says so when GitHub cannot be reached or answers without JSON', async () => {
    const down = await call({ resource: 'repository', operation: 'get' }, { githubApi: { accessToken: TOKEN, baseUrl: 'http://127.0.0.1:1' } });
    expect(down.error?.message).toMatch(/^GitHub API request failed: fetch failed/);
    fake.failNext = { status: 502, body: '<html>Bad gateway</html>' };
    expect((await call({ resource: 'repository', operation: 'get' })).error?.message).toBe('GitHub API error 502: <html>Bad gateway</html>');
  });

  it('continues on fail per item and pairs the results', async () => {
    const response = await run(GitHub, { resource: 'branch', operation: 'get', owner: OWNER, repository: REPO }, {
      credentials: creds(),
      items: [{}, {}],
      perItem: [{ branch: 'main' }, { branch: 'nope' }],
      continueOnFail: true,
    });
    expect(response.error).toBeUndefined();
    expect(jsonOf(response)[0]).toMatchObject({ branch: 'main' });
    expect(jsonOf(response)[1]).toMatchObject({ error: 'GitHub API error 404: Not Found' });
    expect(response.outputs[0].map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('refuses an unknown operation, and offers no delete', async () => {
    expect((await call({ resource: 'issue', operation: 'merge', issueNumber: 1 })).error?.message).toBe('Operation "merge" is not available for resource "issue"');
    expect((await call({ resource: 'repository', operation: 'delete' })).error?.message).toBe('Operation "delete" is not available for resource "repository"');
    const operations = GitHub.description.properties.filter((p) => p.name === 'operation').flatMap((p) => (p.options as Array<{ value: string }>).map((o) => o.value));
    expect(operations.sort()).toEqual(['comment', 'comment', 'commit', 'compare', 'create', 'create', 'create', 'createOrUpdate', 'get', 'get', 'get', 'get', 'list', 'listFiles', 'merge']);
    expect(api.requests).toHaveLength(0);
  });
});
