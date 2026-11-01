/**
 * A small in-memory GitHub REST API: one repository with a git object store (blobs, trees, commits, refs), contents,
 * pulls and issues, enough for the node's calls. `requests` of the FakeApi record every call. Fake token only.
 */
import { createHash } from 'node:crypto';
import type { FakeReply, FakeRequest } from './helpers';

export const TOKEN = 'ghp_test-token-123';
export const OWNER = 'acme';
export const REPO = 'widgets';

const sha = (...parts: string[]) => createHash('sha1').update(parts.join('\0')).digest('hex');

interface Tree {
  /** path → blob sha, flattened. */
  files: Record<string, string>;
}

export class FakeGitHub {
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Tree>();
  commits = new Map<string, { message: string; tree: string; parents: string[] }>();
  refs = new Map<string, string>();
  pulls: Array<Record<string, any>> = [];
  issues: Array<Record<string, any>> = [];
  comments: Array<{ number: number; body: string }> = [];
  /** Per-test switches. */
  failNext: { status: number; body: unknown; headers?: Record<string, string> } | undefined;
  /** Make the next ref update fail the way GitHub does when the branch moved. */
  refConflictOnce = false;

  constructor() {
    this.reset();
  }

  reset() {
    this.blobs.clear();
    this.trees.clear();
    this.commits.clear();
    this.refs.clear();
    this.pulls = [];
    this.issues = [];
    this.comments = [];
    this.failNext = undefined;
    this.refConflictOnce = false;
    const readme = this.addBlob('# Widgets\n');
    const tree = this.addTree({ 'README.md': readme, 'docs/guide.md': this.addBlob('Guide v1\n'), 'docs/notes.txt': this.addBlob('notes\n') });
    const commit = this.addCommit('Initial commit', tree, []);
    this.refs.set('main', commit);
  }

  addBlob(content: string | Buffer): string {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const id = sha('blob', buffer.toString('base64'));
    this.blobs.set(id, buffer);
    return id;
  }

  addTree(files: Record<string, string>): string {
    const id = sha('tree', JSON.stringify(Object.entries(files).sort()));
    this.trees.set(id, { files });
    return id;
  }

  addCommit(message: string, tree: string, parents: string[]): string {
    const id = sha('commit', message, tree, ...parents, String(this.commits.size));
    this.commits.set(id, { message, tree, parents });
    return id;
  }

  /** The text of a file on a branch. */
  read(branch: string, path: string): string | undefined {
    const commit = this.commits.get(this.refs.get(branch) ?? '');
    const blob = commit && this.trees.get(commit.tree)?.files[path];
    return blob ? this.blobs.get(blob)?.toString('utf8') : undefined;
  }

  handle = (req: FakeRequest): FakeReply => {
    if (this.failNext) {
      const failure = this.failNext;
      this.failNext = undefined;
      return failure;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' } };
    if (!req.headers['user-agent'] || req.headers.accept !== 'application/vnd.github+json') return { status: 403, body: { message: 'Request forbidden by administrative rules.' } };
    const path = req.path.replace(/^\/api\/v3/, '');
    if (path === '/user') return { body: { login: 'octo-bot' } };
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return notFound();
    if (match[1] !== OWNER || match[2] !== REPO) return notFound();
    return this.route(req, decodeURIComponent(match[3] ?? ''));
  };

  private route(req: FakeRequest, rest: string): FakeReply {
    const body = req.body ?? {};
    const { method } = req;
    if (rest === '') return { body: { id: 1, name: REPO, full_name: `${OWNER}/${REPO}`, private: true, description: 'Gadgets', default_branch: 'main', html_url: `https://github.test/${OWNER}/${REPO}`, clone_url: `https://github.test/${OWNER}/${REPO}.git`, permissions: { push: true } } };

    // Git data
    let m = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (m && method === 'GET') {
      const id = this.refs.get(m[1]);
      return id ? { body: { ref: `refs/heads/${m[1]}`, object: { sha: id, type: 'commit' } } } : notFound();
    }
    if (rest === '/git/refs' && method === 'POST') {
      const name = String(body.ref).replace(/^refs\/heads\//, '');
      if (this.refs.has(name)) return { status: 422, body: { message: 'Reference already exists', documentation_url: 'https://docs.github.com/rest' } };
      if (!this.commits.has(body.sha)) return { status: 422, body: { message: 'Object does not exist' } };
      this.refs.set(name, body.sha);
      return { status: 201, body: { ref: body.ref, object: { sha: body.sha, type: 'commit' } } };
    }
    m = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (m && method === 'PATCH') {
      if (this.refConflictOnce) {
        this.refConflictOnce = false;
        return { status: 422, body: { message: 'Update is not a fast forward' } };
      }
      if (!this.refs.has(m[1])) return notFound();
      this.refs.set(m[1], body.sha);
      return { body: { ref: `refs/heads/${m[1]}`, object: { sha: body.sha } } };
    }
    m = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest);
    if (m && method === 'GET') {
      const commit = this.commits.get(m[1]);
      return commit ? { body: { sha: m[1], tree: { sha: commit.tree }, message: commit.message } } : notFound();
    }
    m = /^\/commits\/([0-9a-f]+)$/.exec(rest);
    if (m && method === 'GET') return this.restCommit(m[1]);
    if (rest === '/git/commits' && method === 'POST') {
      if (!this.trees.has(body.tree)) return { status: 422, body: { message: 'Tree SHA does not exist' } };
      const id = this.addCommit(body.message, body.tree, body.parents);
      return { status: 201, body: { sha: id, html_url: `https://github.test/${OWNER}/${REPO}/commit/${id}`, message: body.message } };
    }
    if (rest === '/git/blobs' && method === 'POST') {
      const id = this.addBlob(body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : Buffer.from(body.content));
      return { status: 201, body: { sha: id } };
    }
    m = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest);
    if (m && method === 'GET') {
      const blob = this.blobs.get(m[1]);
      return blob ? { body: { sha: m[1], encoding: 'base64', content: blob.toString('base64'), size: blob.length } } : notFound();
    }
    if (rest === '/git/trees' && method === 'POST') {
      const base = this.trees.get(body.base_tree);
      if (!base) return { status: 422, body: { message: 'Base tree does not exist' } };
      const files = { ...base.files };
      for (const entry of body.tree) {
        if (!this.blobs.has(entry.sha)) return { status: 422, body: { message: `GitRPC::BadObjectState: ${entry.path}` } };
        files[entry.path] = entry.sha;
      }
      return { status: 201, body: { sha: this.addTree(files) } };
    }

    // Compare: the files differ by whole-file hunks, in pages of 100 up to 300 like GitHub's
    m = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest);
    if (m && method === 'GET') return this.compare(req, m[1], m[2]);

    // Contents
    m = /^\/contents(?:\/(.*))?$/.exec(rest);
    if (m) return this.contents(req, m[1] ?? '');

    // Pull requests
    if (rest === '/pulls' && method === 'POST') {
      if (!this.refs.has(String(body.head).replace(/^.*:/, ''))) return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] } };
      if (!body.title) return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'title' }] } };
      const pull = { number: this.pulls.length + 1, state: 'open', merged: false, mergeable: null, commits: 1, changed_files: 2, additions: 3, deletions: 1, user: { login: 'octo-bot' }, head: { ref: body.head, sha: this.refs.get(body.head) }, base: { ref: body.base }, html_url: `https://github.test/${OWNER}/${REPO}/pull/${this.pulls.length + 1}`, title: body.title, body: body.body ?? null, draft: body.draft ?? false };
      this.pulls.push(pull);
      return { status: 201, body: pull };
    }
    m = /^\/pulls\/(\d+)\/merge$/.exec(rest);
    if (m && method === 'PUT') {
      const pull = this.pulls[Number(m[1]) - 1];
      if (!pull) return notFound();
      if (pull.draft) return { status: 405, body: { message: 'Pull Request is still a draft' } };
      if (pull.merged) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
      if (body.sha && body.sha !== pull.head.sha) return { status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } };
      Object.assign(pull, { merged: true, state: 'closed' });
      return { body: { sha: 'merged-sha', merged: true, message: 'Pull Request successfully merged' } };
    }
    m = /^\/pulls\/(\d+)(?:\/(files))?$/.exec(rest);
    if (m && method === 'GET') {
      const pull = this.pulls[Number(m[1]) - 1];
      if (!pull) return notFound();
      if (m[2]) {
        const page = Number(req.query.get('page') ?? 1);
        const per = Number(req.query.get('per_page') ?? 30);
        const all = Array.from({ length: 130 }, (_, n) => ({ filename: `src/file-${String(n).padStart(3, '0')}.ts`, status: 'modified', additions: 2, deletions: 1, changes: 3, sha: `s${n}`, patch: '@@ -1 +1 @@' }));
        return { body: all.slice((page - 1) * per, page * per) };
      }
      return { body: pull };
    }

    // Issues and comments
    if (rest === '/issues' && method === 'POST') {
      const issue = { number: this.issues.length + 1, title: body.title, state: 'open', html_url: `https://github.test/${OWNER}/${REPO}/issues/${this.issues.length + 1}`, labels: (body.labels ?? []).map((name: string) => ({ name })), body: body.body, assignees: body.assignees };
      this.issues.push(issue);
      return { status: 201, body: issue };
    }
    m = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (m && method === 'POST') {
      const number = Number(m[1]);
      if (number > Math.max(this.issues.length, this.pulls.length)) return notFound();
      if (!body.body) return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }] } };
      this.comments.push({ number, body: body.body });
      return { status: 201, body: { id: 900 + this.comments.length, body: body.body, user: { login: 'octo-bot' }, html_url: `https://github.test/${OWNER}/${REPO}/issues/${number}#issuecomment-${900 + this.comments.length}`, created_at: '2026-10-31T10:00:00Z' } };
    }
    return notFound();
  }

  /** The REST commit: message, a fixed author, and the files changed against its first parent. */
  private restCommit(id: string): FakeReply {
    const commit = this.commits.get(id);
    if (!commit) return notFound();
    const now = this.trees.get(commit.tree)?.files ?? {};
    const before = this.trees.get(this.commits.get(commit.parents[0] ?? '')?.tree ?? '')?.files ?? {};
    const lines = (blob?: string) => (blob ? this.blobs.get(blob)?.toString('utf8').split('\n').length ?? 0 : 0);
    const files = [...new Set([...Object.keys(before), ...Object.keys(now)])]
      .filter((path) => before[path] !== now[path])
      .sort()
      .map((path) => {
        const status = !before[path] ? 'added' : !now[path] ? 'removed' : 'modified';
        return { filename: path, status, additions: status === 'removed' ? 0 : lines(now[path]), deletions: status === 'added' ? 0 : lines(before[path]) };
      });
    const sum = (key: 'additions' | 'deletions') => files.reduce((total, f) => total + f[key], 0);
    return {
      body: {
        sha: id,
        html_url: `https://github.test/${OWNER}/${REPO}/commit/${id}`,
        commit: { message: commit.message, author: { name: 'Octo Bot', email: 'octo-bot@github.test', date: '2026-10-31T10:00:00Z' } },
        stats: { additions: sum('additions'), deletions: sum('deletions'), total: sum('additions') + sum('deletions') },
        files,
      },
    };
  }

  /** Branches that differ: ahead by the commits the head has since the base's tip, files from the trees. */
  private compare(req: FakeRequest, baseRef: string, headRef: string): FakeReply {
    const base = this.commits.get(this.refs.get(baseRef) ?? baseRef);
    const head = this.commits.get(this.refs.get(headRef) ?? headRef);
    if (!base || !head) return notFound();
    const before = this.trees.get(base.tree)?.files ?? {};
    const now = this.trees.get(head.tree)?.files ?? {};
    const text = (blob?: string) => (blob ? (this.blobs.get(blob)?.toString('utf8') ?? '').replace(/\n$/, '').split('\n') : []);
    const all = [...new Set([...Object.keys(before), ...Object.keys(now)])]
      .filter((path) => before[path] !== now[path])
      .sort()
      .map((path) => {
        const status = !before[path] ? 'added' : !now[path] ? 'removed' : 'modified';
        const old = text(before[path]);
        const next = text(now[path]);
        const patch = `@@ -${old.length ? 1 : 0},${old.length} +${next.length ? 1 : 0},${next.length} @@\n${[...old.map((l) => `-${l}`), ...next.map((l) => `+${l}`)].join('\n')}`;
        return { filename: path, status, additions: next.length, deletions: old.length, changes: old.length + next.length, patch };
      });
    // Extra files for the paging test: a head branch named `many` lists 350.
    const files = headRef === 'many' ? Array.from({ length: 350 }, (_, n) => ({ filename: `gen/file-${String(n).padStart(3, '0')}.ts`, status: 'added', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+x' })) : all;
    const page = Number(req.query.get('page') ?? 1);
    const per = Number(req.query.get('per_page') ?? 30);
    const baseId = this.refs.get(baseRef) ?? baseRef;
    const known = new Set([baseId, ...this.ancestors(base)]);
    const ahead = [this.refs.get(headRef) ?? headRef, ...this.ancestors(head)].filter((id) => !known.has(id)).length;
    return {
      body: {
        status: ahead > 0 ? 'ahead' : 'identical',
        ahead_by: Math.max(0, ahead),
        behind_by: 0,
        total_commits: Math.max(0, ahead),
        html_url: `https://github.test/${OWNER}/${REPO}/compare/${baseRef}...${headRef}`,
        files: files.slice((page - 1) * per, page * per),
      },
    };
  }

  /** A commit and everything behind it. */
  private ancestors(commit: { parents: string[] }, seen = new Set<string>()): Set<string> {
    for (const id of commit.parents) {
      if (seen.has(id)) continue;
      seen.add(id);
      const parent = this.commits.get(id);
      if (parent) this.ancestors(parent, seen);
    }
    return seen;
  }

  private contents(req: FakeRequest, path: string): FakeReply {
    const ref = req.query.get('ref') ?? 'main';
    const commit = this.commits.get(this.refs.get(ref) ?? ref);
    if (!commit) return { status: 404, body: { message: 'No commit found for the ref ' + ref } };
    const files = this.trees.get(commit.tree)!.files;
    if (req.method === 'PUT') {
      const branch = req.body.branch ?? 'main';
      const tip = this.commits.get(this.refs.get(branch) ?? '');
      if (!tip) return { status: 404, body: { message: 'Branch not found' } };
      const current = this.trees.get(tip.tree)!.files[path];
      if (current && req.body.sha !== current) return { status: 409, body: { message: `${path} does not match ${current}` } };
      if (!current && req.body.sha) return { status: 422, body: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' } };
      const blob = this.addBlob(Buffer.from(req.body.content, 'base64'));
      const tree = this.addTree({ ...this.trees.get(tip.tree)!.files, [path]: blob });
      const id = this.addCommit(req.body.message, tree, [this.refs.get(branch)!]);
      this.refs.set(branch, id);
      return { status: current ? 200 : 201, body: { content: { path, sha: blob, html_url: `https://github.test/${OWNER}/${REPO}/blob/${branch}/${path}` }, commit: { sha: id, message: req.body.message, html_url: `https://github.test/${OWNER}/${REPO}/commit/${id}` } } };
    }
    if (path in files) {
      const blob = this.blobs.get(files[path])!;
      const big = blob.length > 1000;
      return { body: { type: 'file', name: path.split('/').pop(), path, sha: files[path], size: blob.length, encoding: big ? 'none' : 'base64', content: big ? '' : blob.toString('base64').replace(/(.{60})/g, '$1\n'), html_url: `https://github.test/${OWNER}/${REPO}/blob/${ref}/${path}` } };
    }
    const prefix = path ? `${path}/` : '';
    const entries = new Map<string, { type: string; sha: string; size: number }>();
    for (const [file, blob] of Object.entries(files)) {
      if (!file.startsWith(prefix)) continue;
      const [first, ...tail] = file.slice(prefix.length).split('/');
      entries.set(first, tail.length ? { type: 'dir', sha: 'tree-' + first, size: 0 } : { type: 'file', sha: blob, size: this.blobs.get(blob)!.length });
    }
    if (!entries.size) return notFound();
    return { body: [...entries].map(([name, e]) => ({ name, path: prefix + name, ...e, html_url: `https://github.test/${OWNER}/${REPO}/tree/${ref}/${prefix}${name}` })) };
  }
}

const notFound = (): FakeReply => ({ status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' } });
