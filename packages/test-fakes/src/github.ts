/**
 * A stateful GitHub REST API: repositories with a git object store (blobs, trees, commits), branches, the files each
 * branch holds, pull requests and comments, so a test of a node that commits or opens a PR asserts on
 * `github.state().repos['acme/widgets'].files.feature['docs/a.md']`, not on the request.
 *
 * Endpoints (also under an Enterprise `/api/v3` prefix): GET /user; per repository GET repo, GET /git/ref/heads/:b,
 * POST /git/refs, PATCH /git/refs/heads/:b, GET /git/commits/:sha, POST /git/commits, /git/trees, /git/blobs,
 * GET /git/blobs/:sha, GET|PUT /contents/:path (PUT needs the current `sha` to update an existing file: 409 when stale, 422 when missing),
 * GET|POST /pulls, GET /pulls/:n, POST|GET /issues, POST|GET /issues/:n/comments (pulls and issues share numbers).
 * Everything else is 404. A repository the fake does not hold is 404. Text files only (content is kept as UTF-8).
 * Point the credential's base URL at `github.url` and its token at `github.token`.
 */
import { createHash } from 'node:crypto';
import { defineFake, type Fake, type FakeReply, type FakeRequest } from './harness';

export const GITHUB_TOKEN = 'ghp_fake-test-token-000000';

export interface GitHubPull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  head: string;
  headSha: string;
  base: string;
}

export interface GitHubRepo {
  defaultBranch: string;
  /** Branch name → the commit it points at. */
  branches: Record<string, string>;
  /** Branch name → path → text: what each branch holds now (kept in step with `branches`). */
  files: Record<string, Record<string, string>>;
  commits: Record<string, { message: string; tree: string; parents: string[] }>;
  /** Tree sha → path → blob sha (flattened). */
  trees: Record<string, Record<string, string>>;
  /** Blob sha → base64 content. */
  blobs: Record<string, string>;
  pulls: GitHubPull[];
  issues: Array<{ number: number; title: string; body: string | null; state: 'open' }>;
  comments: Array<{ id: number; number: number; body: string }>;
  /** The next issue or pull request number. */
  next: number;
}

export interface GitHubState {
  /** By `owner/repo`. */
  repos: Record<string, GitHubRepo>;
}

export interface GitHubSeed {
  token: string;
  /** `owner/repo` → the files on `main` (default: acme/widgets with a README and a guide). */
  repos: Record<string, Record<string, string>>;
}

const sha1 = (...parts: string[]) => createHash('sha1').update(parts.join('\0')).digest('hex');
const blobSha = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const notFound = (): FakeReply => ({ status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' } });
const invalid = (message: string, errors?: unknown[]): FakeReply => ({ status: 422, body: { message, ...(errors && { errors }) } });
const WEB = 'https://github.test';

function seedRepo(files: Record<string, string>): GitHubRepo {
  const repo: GitHubRepo = { defaultBranch: 'main', branches: {}, files: {}, commits: {}, trees: {}, blobs: {}, pulls: [], issues: [], comments: [], next: 1 };
  const tree: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) tree[path] = addBlob(repo, Buffer.from(text).toString('base64'));
  const commit = addCommit(repo, 'Initial commit', addTree(repo, tree), []);
  repo.branches.main = commit;
  refresh(repo);
  return repo;
}

function addBlob(repo: GitHubRepo, base64: string): string {
  const id = blobSha(Buffer.from(base64, 'base64').toString('utf8'));
  repo.blobs[id] = base64;
  return id;
}
function addTree(repo: GitHubRepo, files: Record<string, string>): string {
  const id = sha1('tree', JSON.stringify(Object.entries(files).sort()));
  repo.trees[id] = files;
  return id;
}
function addCommit(repo: GitHubRepo, message: string, tree: string, parents: string[]): string {
  const id = sha1('commit', message, tree, ...parents, String(Object.keys(repo.commits).length));
  repo.commits[id] = { message, tree, parents };
  return id;
}
/** Recompute `files` from the branches, so state() shows what each branch holds. */
function refresh(repo: GitHubRepo): void {
  repo.files = {};
  for (const [branch, commit] of Object.entries(repo.branches)) {
    const tree = repo.trees[repo.commits[commit]?.tree ?? ''] ?? {};
    repo.files[branch] = Object.fromEntries(Object.entries(tree).map(([path, blob]) => [path, Buffer.from(repo.blobs[blob] ?? '', 'base64').toString('utf8')]));
  }
}
const treeAt = (repo: GitHubRepo, branch: string): Record<string, string> | undefined => {
  const commit = repo.commits[repo.branches[branch] ?? branch];
  return commit ? repo.trees[commit.tree] : undefined;
};

const pullJson = (repo: GitHubRepo, pull: GitHubPull, owner: string, name: string) => ({
  number: pull.number,
  title: pull.title,
  body: pull.body,
  state: pull.state,
  draft: pull.draft,
  merged: false,
  user: { login: 'octo-bot' },
  head: { ref: pull.head, sha: pull.headSha },
  base: { ref: pull.base },
  html_url: `${WEB}/${owner}/${name}/pull/${pull.number}`,
});

function repoRoute(repo: GitHubRepo, owner: string, name: string, rest: string, request: FakeRequest): FakeReply {
  const body = (request.body ?? {}) as Record<string, any>;
  const { method } = request;
  if (rest === '' && method === 'GET') {
    return { body: { id: 1, name, full_name: `${owner}/${name}`, private: true, default_branch: repo.defaultBranch, html_url: `${WEB}/${owner}/${name}`, permissions: { push: true } } };
  }

  let m = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
  if (m && method === 'GET') {
    const id = repo.branches[m[1]];
    return id ? { body: { ref: `refs/heads/${m[1]}`, object: { sha: id, type: 'commit' } } } : notFound();
  }
  if (rest === '/git/refs' && method === 'POST') {
    const branch = String(body.ref).replace(/^refs\/heads\//, '');
    if (repo.branches[branch]) return invalid('Reference already exists');
    if (!repo.commits[body.sha]) return invalid('Object does not exist');
    repo.branches[branch] = body.sha;
    refresh(repo);
    return { status: 201, body: { ref: body.ref, object: { sha: body.sha, type: 'commit' } } };
  }
  m = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
  if (m && method === 'PATCH') {
    if (!repo.branches[m[1]]) return notFound();
    if (!repo.commits[body.sha]) return invalid('Object does not exist');
    repo.branches[m[1]] = body.sha;
    refresh(repo);
    return { body: { ref: `refs/heads/${m[1]}`, object: { sha: body.sha } } };
  }
  m = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest);
  if (m && method === 'GET') {
    const commit = repo.commits[m[1]];
    return commit ? { body: { sha: m[1], tree: { sha: commit.tree }, message: commit.message } } : notFound();
  }
  if (rest === '/git/commits' && method === 'POST') {
    if (!repo.trees[body.tree]) return invalid('Tree SHA does not exist');
    const id = addCommit(repo, body.message, body.tree, body.parents ?? []);
    return { status: 201, body: { sha: id, html_url: `${WEB}/${owner}/${name}/commit/${id}`, message: body.message } };
  }
  if (rest === '/git/blobs' && method === 'POST') {
    const base64 = body.encoding === 'base64' ? String(body.content) : Buffer.from(String(body.content)).toString('base64');
    return { status: 201, body: { sha: addBlob(repo, base64) } };
  }
  m = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest);
  if (m && method === 'GET') {
    const content = repo.blobs[m[1]];
    return content === undefined ? notFound() : { body: { sha: m[1], encoding: 'base64', content, size: Buffer.from(content, 'base64').length } };
  }
  if (rest === '/git/trees' && method === 'POST') {
    const base = repo.trees[body.base_tree];
    if (body.base_tree && !base) return invalid('Base tree does not exist');
    const files = { ...base };
    for (const entry of body.tree ?? []) {
      if (!repo.blobs[entry.sha]) return invalid(`GitRPC::BadObjectState: ${entry.path}`);
      files[entry.path] = entry.sha;
    }
    return { status: 201, body: { sha: addTree(repo, files) } };
  }

  m = /^\/contents(?:\/(.*))?$/.exec(rest);
  if (m) return contents(repo, owner, name, request, m[1] ?? '');

  if (rest === '/pulls' && method === 'POST') {
    const head = String(body.head).replace(/^.*:/, '');
    if (!repo.branches[head]) return invalid('Validation Failed', [{ resource: 'PullRequest', field: 'head', code: 'invalid' }]);
    if (!repo.branches[String(body.base)]) return invalid('Validation Failed', [{ resource: 'PullRequest', field: 'base', code: 'invalid' }]);
    if (!body.title) return invalid('Validation Failed', [{ resource: 'PullRequest', field: 'title', code: 'missing_field' }]);
    const pull: GitHubPull = { number: repo.next++, title: body.title, body: body.body ?? null, state: 'open', draft: body.draft ?? false, head, headSha: repo.branches[head], base: String(body.base) };
    repo.pulls.push(pull);
    return { status: 201, body: pullJson(repo, pull, owner, name) };
  }
  if (rest === '/pulls' && method === 'GET') return { body: repo.pulls.map((p) => pullJson(repo, p, owner, name)) };
  m = /^\/pulls\/(\d+)$/.exec(rest);
  if (m && method === 'GET') {
    const pull = repo.pulls.find((p) => p.number === Number(m![1]));
    return pull ? { body: pullJson(repo, pull, owner, name) } : notFound();
  }

  if (rest === '/issues' && method === 'POST') {
    if (!body.title) return invalid('Validation Failed', [{ resource: 'Issue', field: 'title', code: 'missing_field' }]);
    const issue = { number: repo.next++, title: String(body.title), body: body.body ?? null, state: 'open' as const };
    repo.issues.push(issue);
    return { status: 201, body: { ...issue, html_url: `${WEB}/${owner}/${name}/issues/${issue.number}` } };
  }
  m = /^\/issues\/(\d+)\/comments$/.exec(rest);
  if (m) {
    const number = Number(m[1]);
    if (!repo.issues.some((i) => i.number === number) && !repo.pulls.some((p) => p.number === number)) return notFound();
    if (method === 'GET') return { body: repo.comments.filter((c) => c.number === number).map((c) => ({ id: c.id, body: c.body, user: { login: 'octo-bot' } })) };
    if (method === 'POST') {
      if (!body.body) return invalid('Validation Failed', [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }]);
      const comment = { id: 900 + repo.comments.length + 1, number, body: String(body.body) };
      repo.comments.push(comment);
      return { status: 201, body: { id: comment.id, body: comment.body, user: { login: 'octo-bot' }, html_url: `${WEB}/${owner}/${name}/issues/${number}#issuecomment-${comment.id}` } };
    }
  }
  return notFound();
}

function contents(repo: GitHubRepo, owner: string, name: string, request: FakeRequest, path: string): FakeReply {
  if (request.method === 'PUT') {
    const body = (request.body ?? {}) as Record<string, any>;
    const branch = String(body.branch ?? repo.defaultBranch);
    const tip = repo.branches[branch];
    if (!tip) return { status: 404, body: { message: 'Branch not found' } };
    const tree = repo.trees[repo.commits[tip].tree];
    const current = tree[path];
    if (current && !body.sha) return invalid('Invalid request.\n\n"sha" wasn\'t supplied.');
    if (current && body.sha !== current) return { status: 409, body: { message: `${path} does not match ${current}` } };
    if (typeof body.content !== 'string' || !body.message) return invalid('Invalid request: "message" and "content" are required.');
    const blob = addBlob(repo, body.content);
    const commit = addCommit(repo, body.message, addTree(repo, { ...tree, [path]: blob }), [tip]);
    repo.branches[branch] = commit;
    refresh(repo);
    return {
      status: current ? 200 : 201,
      body: { content: { path, sha: blob, html_url: `${WEB}/${owner}/${name}/blob/${branch}/${path}` }, commit: { sha: commit, message: body.message, html_url: `${WEB}/${owner}/${name}/commit/${commit}` } },
    };
  }
  if (request.method !== 'GET') return notFound();
  const ref = request.query.get('ref') ?? repo.defaultBranch;
  const tree = treeAt(repo, ref);
  if (!tree) return { status: 404, body: { message: `No commit found for the ref ${ref}` } };
  if (path in tree) {
    const content = repo.blobs[tree[path]];
    return { body: { type: 'file', name: path.split('/').pop(), path, sha: tree[path], size: Buffer.from(content, 'base64').length, encoding: 'base64', content, html_url: `${WEB}/${owner}/${name}/blob/${ref}/${path}` } };
  }
  const prefix = path ? `${path}/` : '';
  const entries = new Map<string, { type: string; sha: string }>();
  for (const [file, blob] of Object.entries(tree)) {
    if (!file.startsWith(prefix)) continue;
    const [first, ...tail] = file.slice(prefix.length).split('/');
    entries.set(first, tail.length ? { type: 'dir', sha: `tree-${first}` } : { type: 'file', sha: blob });
  }
  if (!entries.size) return notFound();
  return { body: [...entries].map(([entry, e]) => ({ name: entry, path: prefix + entry, ...e })) };
}

function route(state: GitHubState, request: FakeRequest): FakeReply {
  const path = decodeURIComponent(request.path).replace(/^\/api\/v3(?=\/)/, '');
  if (path === '/user') return { body: { login: 'octo-bot' } };
  const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  const repo = match && state.repos[`${match[1]}/${match[2]}`];
  if (!match || !repo) return notFound();
  return repoRoute(repo, match[1], match[2], match[3] ?? '', request);
}

/** A GitHub fake. `seed.repos` names the repositories and the files on `main`; `seed.token` replaces the default token. */
export function fakeGitHub(seed: Partial<GitHubSeed> = {}): Fake<GitHubState> {
  const repos = seed.repos ?? { 'acme/widgets': { 'README.md': '# Widgets\n', 'docs/guide.md': 'Guide v1\n' } };
  return defineFake<GitHubState>({
    name: 'github',
    token: seed.token ?? GITHUB_TOKEN,
    refusal: () => ({ status: 401, body: { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' } }),
    initial: () => ({ repos: Object.fromEntries(Object.entries(repos).map(([name, files]) => [name, seedRepo(files)])) }),
    routes: route,
  });
}
