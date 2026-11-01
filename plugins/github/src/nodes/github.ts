import { defineCredentialType, defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type PropertyDescriptor } from '@landflow/sdk';
import { baseUrl, DEFAULT_BASE_URL, encodePath, githubCall, githubCallOrMissing, repoPath, type ApiContext, type GitHubCredentials } from '../api';
import { mapItems, optionalString, requireString, unsupported } from '../shared';

export const githubApi = defineCredentialType<GitHubCredentials>({
  name: 'githubApi',
  displayName: 'GitHub API',
  icon: 'file:github.svg',
  documentationUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
  description:
    'A personal access token (classic with the repo scope, or fine-grained with Contents, Pull requests and Issues read and write on the repositories). For GitHub Enterprise Server use https://<host>/api/v3 as the API base URL.',
  properties: [
    {
      name: 'accessToken',
      displayName: 'Access Token',
      type: 'string',
      required: true,
      typeOptions: { password: true },
      placeholder: 'ghp_… / github_pat_…',
      description: 'A personal access token, or an installation token of a GitHub App',
    },
    {
      name: 'baseUrl',
      displayName: 'API Base URL',
      type: 'string',
      default: DEFAULT_BASE_URL,
      description: 'GitHub Enterprise Server: https://<host>/api/v3. Change it otherwise only for a proxy or a test double',
    },
  ],
  async test(data, ctx) {
    try {
      const me = await githubCall<{ login?: string }>({ http: ctx.http }, data, 'GET', '/user');
      return { ok: true, message: `Authenticated as ${me.login ?? 'unknown'} at ${baseUrl(data.baseUrl)}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

/** Files per commit and bytes per file the node accepts before calling GitHub (a blob is limited to 100 MB; the request body is JSON). */
const MAX_COMMIT_FILES = 500;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PAGE_SIZE = 100;
/** GitHub lists at most this many files of a pull request. */
const MAX_PR_FILES = 3000;

const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));
const fromBase64 = (value: string) => Buffer.from(value.replace(/\s/g, ''), 'base64').toString('utf8');

interface FileInput {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
}

/** The `files` parameter: a JSON array of `{ path, content }` (optionally `encoding: "base64"`). The editor stores text, expressions may produce an array. */
export function parseFiles(value: unknown): FileInput[] {
  let parsed = value;
  if (typeof value === 'string') {
    if (!value.trim()) throw new NodeOperationError('Files is required: a JSON array of { "path", "content" }');
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new NodeOperationError(`Files is not valid JSON: ${(error as Error).message}`);
    }
  }
  if (!Array.isArray(parsed) || !parsed.length) throw new NodeOperationError('Files must be a non-empty JSON array of { "path", "content" }');
  if (parsed.length > MAX_COMMIT_FILES) throw new NodeOperationError(`A commit takes up to ${MAX_COMMIT_FILES} files, got ${parsed.length}`);
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    const file = entry as JsonObject | null;
    const where = `Files[${index}]`;
    if (typeof file !== 'object' || file === null || Array.isArray(file)) throw new NodeOperationError(`${where} must be an object with "path" and "content"`);
    const path = typeof file.path === 'string' ? file.path.trim() : '';
    if (!path) throw new NodeOperationError(`${where} has no "path"`);
    if (path.startsWith('/') || path.endsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..' || part === '.git')) {
      throw new NodeOperationError(`${where} has an invalid path "${path}"`, { description: 'Use a path relative to the repository root, such as docs/readme.md: no leading slash, "." or ".." segments.' });
    }
    if (seen.has(path)) throw new NodeOperationError(`${where}: "${path}" is listed twice`);
    seen.add(path);
    if (typeof file.content !== 'string') throw new NodeOperationError(`${where} ("${path}") needs a string "content"`);
    const encoding = file.encoding === undefined ? 'utf-8' : file.encoding;
    if (encoding !== 'utf-8' && encoding !== 'base64') throw new NodeOperationError(`${where} ("${path}") has encoding "${text(encoding)}": use "utf-8" or "base64"`);
    if (Buffer.byteLength(file.content) > MAX_FILE_BYTES) throw new NodeOperationError(`${where} ("${path}") is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    return { path, content: file.content, encoding };
  });
}

interface Target {
  api: ApiContext;
  credentials: GitHubCredentials;
  repo: string;
}

/** The site behind the credential's API base URL: github.com, or a GitHub Enterprise Server host (`https://<host>/api/v3`). */
function webBase(credentials: GitHubCredentials): string {
  return baseUrl(credentials.baseUrl).replace(/\/api\/v3$/, '').replace('//api.github.com', '//github.com');
}

/** Reports a branch this call created (`ctx.artifact`), linked to its page. */
function reportBranch(ctx: IExecuteContext, t: Target, branch: string) {
  ctx.artifact({ name: `Branch ${branch}`, kind: 'branch', url: `${webBase(t.credentials)}${t.repo.replace('/repos', '')}/tree/${encodePath(branch)}` });
}

/** The repository's default branch, for "from the default branch" choices. */
async function defaultBranch(t: Target): Promise<string> {
  const repository = await githubCall<{ default_branch: string }>(t.api, t.credentials, 'GET', t.repo);
  return repository.default_branch;
}

/** The commit a branch points at, or undefined when the branch does not exist. */
async function branchSha(t: Target, branch: string): Promise<string | undefined> {
  const ref = await githubCallOrMissing<{ object: { sha: string } }>(t.api, t.credentials, 'GET', `${t.repo}/git/ref/heads/${encodePath(branch)}`);
  return ref?.object.sha;
}

/** The commit to start a new branch from: an explicit sha, else a base branch, else the default branch. */
async function baseSha(t: Target, baseBranch: string, sha: string): Promise<string> {
  if (sha) return sha;
  const name = baseBranch || (await defaultBranch(t));
  const found = await branchSha(t, name);
  if (!found) throw new NodeOperationError(`The base branch "${name}" does not exist`, { description: 'Check the base branch name, or give a commit SHA instead.' });
  return found;
}

const commitSummary = (commit: JsonObject | undefined): JsonObject | undefined =>
  commit && { sha: commit.sha ?? null, message: commit.message ?? null, url: commit.html_url ?? null };

function simplifyPull(pull: JsonObject): JsonObject {
  const head = (pull.head ?? {}) as JsonObject;
  const base = (pull.base ?? {}) as JsonObject;
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft ?? false,
    merged: pull.merged ?? false,
    mergeable: pull.mergeable ?? null,
    body: pull.body ?? null,
    author: ((pull.user ?? {}) as JsonObject).login ?? null,
    head: head.ref ?? null,
    headSha: head.sha ?? null,
    base: base.ref ?? null,
    url: pull.html_url,
    commits: pull.commits ?? null,
    changedFiles: pull.changed_files ?? null,
    additions: pull.additions ?? null,
    deletions: pull.deletions ?? null,
  };
}

const simplifyComment = (comment: JsonObject): JsonObject => ({
  id: comment.id,
  body: comment.body,
  author: ((comment.user ?? {}) as JsonObject).login ?? null,
  url: comment.html_url,
  createdAt: comment.created_at,
});

const names = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const show = (resource: string[], operation?: string[], extra: Record<string, unknown[]> = {}) => ({
  show: { resource, ...(operation && { operation }), ...extra },
});

const branchField = (description: string, required = false): PropertyDescriptor => ({
  name: 'branch',
  displayName: 'Branch',
  type: 'string',
  required,
  default: '',
  placeholder: 'main',
  description,
});

export const GitHub = defineNode({
  description: {
    name: 'github',
    displayName: 'GitHub',
    description: 'Fixed GitHub steps: read and write files, commit several files at once, create branches, open pull requests, comment',
    version: 1,
    kind: 'action',
    categories: ['Development'],
    icon: 'file:github.svg',
    color: '#24292f',
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: 'https://docs.github.com/en/rest',
    keywords: ['github', 'git', 'repository', 'commit', 'branch', 'pull request', 'pr', 'merge', 'issue', 'file'],
    usableAsTool: true,
    // Writes are at most once over a broker; the read operations opt back in with `idempotent: true`.
    idempotent: false,
    toolDescription:
      'Do a GitHub step over the REST API: get a repository or compare two branches, read or list files, create or update one file, commit several files in one commit (optionally on a new branch), create or get a branch, open a draft pull request, list its files, comment on a pull request or issue, merge a pull request, create an issue. It cannot delete.',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'githubApi', required: true }],
    properties: [
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'files',
        options: [
          { name: 'Branch', value: 'branch' },
          { name: 'File', value: 'file' },
          { name: 'Files (One Commit)', value: 'files' },
          { name: 'Issue', value: 'issue' },
          { name: 'Pull Request', value: 'pullRequest' },
          { name: 'Repository', value: 'repository' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'get',
        displayOptions: show(['repository']),
        options: [
          {
            name: 'Compare',
            value: 'compare',
            description: 'What a branch holds beyond another: commits ahead and behind, and the files changed with their patches',
            action: 'Compare two branches',
            idempotent: true,
          },
          { name: 'Get', value: 'get', description: 'Get a repository: default branch, visibility, URLs', action: 'Get a repository', idempotent: true },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'get',
        displayOptions: show(['file']),
        options: [
          { name: 'Create or Update', value: 'createOrUpdate', description: 'Write one file in one commit', action: 'Create or update a file' },
          { name: 'Get', value: 'get', description: 'Read a file: decoded content and sha', action: 'Get a file', idempotent: true },
          { name: 'List', value: 'list', description: 'List a directory', action: 'List a directory', idempotent: true },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'get',
        displayOptions: show(['branch']),
        options: [
          { name: 'Create', value: 'create', description: 'Create a branch from a base branch or a commit', action: 'Create a branch' },
          { name: 'Get', value: 'get', description: 'Get the commit a branch points at: its message, author and the files it changed', action: 'Get a branch', idempotent: true },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'create',
        displayOptions: show(['pullRequest']),
        options: [
          { name: 'Comment', value: 'comment', description: 'Add a comment to the conversation', action: 'Comment on a pull request' },
          { name: 'Create', value: 'create', description: 'Open a pull request (a draft by default)', action: 'Create a pull request' },
          { name: 'Get', value: 'get', action: 'Get a pull request', idempotent: true },
          { name: 'List Files', value: 'listFiles', description: 'The files a pull request changes', action: 'List the files of a pull request', idempotent: true },
          { name: 'Merge', value: 'merge', description: 'Merge a ready (not draft) pull request into its base branch', action: 'Merge a pull request' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'create',
        displayOptions: show(['issue']),
        options: [
          { name: 'Comment', value: 'comment', description: 'Add a comment to an issue', action: 'Comment on an issue' },
          { name: 'Create', value: 'create', action: 'Create an issue' },
        ],
      },
      // The default resource's operation comes last: parameter defaults are keyed by name, last one wins.
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'commit',
        displayOptions: show(['files']),
        options: [
          {
            name: 'Commit',
            value: 'commit',
            description: 'Commit several files in one commit on a branch, creating the branch if asked to',
            action: 'Commit several files',
          },
        ],
      },
      {
        name: 'owner',
        displayName: 'Owner',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'landfalls',
        description: 'The user or organization that owns the repository',
      },
      { name: 'repository', displayName: 'Repository', type: 'string', required: true, default: '', placeholder: 'landflow', description: 'The repository name, without the owner' },
      // Repository: compare
      {
        name: 'compareBase',
        displayName: 'Base',
        type: 'string',
        default: '',
        placeholder: 'main',
        displayOptions: show(['repository'], ['compare']),
        description: 'The branch, tag or commit to compare against; empty means the repository’s default branch',
      },
      {
        name: 'compareHead',
        displayName: 'Head',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'feature or fork-owner:feature',
        displayOptions: show(['repository'], ['compare']),
        description: 'The branch, tag or commit with the changes',
      },
      // File
      {
        name: 'path',
        displayName: 'Path',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'docs/readme.md',
        displayOptions: show(['file'], ['get', 'createOrUpdate']),
        description: 'The file’s path from the repository root',
      },
      {
        name: 'path',
        displayName: 'Path',
        type: 'string',
        default: '',
        placeholder: 'docs',
        displayOptions: show(['file'], ['list']),
        description: 'The directory’s path from the repository root; empty lists the root',
      },
      {
        ...branchField('The branch to read from; empty means the repository’s default branch. A tag or commit SHA also works'),
        displayOptions: show(['file'], ['get', 'list']),
      },
      {
        ...branchField('The branch to commit to; empty means the repository’s default branch'),
        displayOptions: show(['file'], ['createOrUpdate']),
      },
      {
        name: 'content',
        displayName: 'Content',
        type: 'string',
        default: '',
        typeOptions: { rows: 8 },
        displayOptions: show(['file'], ['createOrUpdate']),
        description: 'The new text of the file (UTF-8)',
      },
      {
        name: 'message',
        displayName: 'Commit Message',
        type: 'string',
        required: true,
        default: '',
        displayOptions: show(['file', 'files'], ['createOrUpdate', 'commit']),
      },
      {
        name: 'sha',
        displayName: 'File SHA',
        type: 'string',
        default: '',
        displayOptions: show(['file'], ['createOrUpdate']),
        description: 'The blob SHA of the file being replaced. Leave empty to look it up on the branch (a missing file is created)',
      },
      // Files (one commit)
      {
        ...branchField('The branch to commit to', true),
        displayOptions: show(['files', 'branch'], ['commit', 'create', 'get']),
      },
      {
        name: 'files',
        displayName: 'Files',
        type: 'json',
        required: true,
        default: '[\n  { "path": "docs/example.md", "content": "Hello" }\n]',
        typeOptions: { rows: 8 },
        displayOptions: show(['files'], ['commit']),
        description: 'A JSON array of { "path", "content" }, or an expression producing one. All of them go into one commit. Add "encoding": "base64" to an entry for binary content',
      },
      {
        name: 'createBranch',
        displayName: 'Create Branch If Missing',
        type: 'boolean',
        default: false,
        displayOptions: show(['files'], ['commit']),
        description: 'Whether to create the branch (from the base below) when it does not exist. Off: a missing branch fails the node',
      },
      {
        name: 'baseBranch',
        displayName: 'Base Branch',
        type: 'string',
        default: '',
        placeholder: 'main',
        displayOptions: { show: { resource: ['files'], operation: ['commit'], createBranch: [true] } },
        description: 'The branch a new branch starts from; empty means the repository’s default branch',
      },
      {
        name: 'baseBranch',
        displayName: 'Base Branch',
        type: 'string',
        default: '',
        placeholder: 'main',
        displayOptions: show(['branch'], ['create']),
        description: 'The branch the new branch starts from; empty means the repository’s default branch',
      },
      {
        name: 'baseSha',
        displayName: 'Base Commit SHA',
        type: 'string',
        default: '',
        displayOptions: show(['branch'], ['create']),
        description: 'Start from this commit instead of a base branch’s tip',
      },
      // Pull request and issue
      {
        name: 'pullNumber',
        displayName: 'Pull Request Number',
        type: 'number',
        required: true,
        default: 0,
        displayOptions: show(['pullRequest'], ['get', 'listFiles', 'comment', 'merge']),
      },
      {
        name: 'issueNumber',
        displayName: 'Issue Number',
        type: 'number',
        required: true,
        default: 0,
        displayOptions: show(['issue'], ['comment']),
      },
      { name: 'title', displayName: 'Title', type: 'string', required: true, default: '', displayOptions: show(['pullRequest', 'issue'], ['create']) },
      {
        name: 'body',
        displayName: 'Body',
        type: 'string',
        default: '',
        typeOptions: { rows: 6 },
        displayOptions: show(['pullRequest', 'issue'], ['create']),
        description: 'Markdown',
      },
      {
        name: 'head',
        displayName: 'Head Branch',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'feature or fork-owner:feature',
        displayOptions: show(['pullRequest'], ['create']),
        description: 'The branch with the changes. From a fork use owner:branch',
      },
      {
        name: 'base',
        displayName: 'Base Branch',
        type: 'string',
        required: true,
        default: 'main',
        displayOptions: show(['pullRequest'], ['create']),
        description: 'The branch the changes should be merged into',
      },
      {
        name: 'draft',
        displayName: 'Draft',
        type: 'boolean',
        default: true,
        displayOptions: show(['pullRequest'], ['create']),
        description: 'Whether to open the pull request as a draft',
      },
      {
        name: 'commentBody',
        displayName: 'Comment',
        type: 'string',
        required: true,
        default: '',
        typeOptions: { rows: 4 },
        displayOptions: show(['pullRequest', 'issue'], ['comment']),
        description: 'Markdown',
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: show(['issue'], ['create']),
        values: [
          { name: 'labels', displayName: 'Labels', type: 'string', default: '', placeholder: 'bug, triage', description: 'Comma-separated label names' },
          { name: 'assignees', displayName: 'Assignees', type: 'string', default: '', placeholder: 'octocat', description: 'Comma-separated user logins' },
        ],
      },
      {
        name: 'mergeMethod',
        displayName: 'Merge Method',
        type: 'options',
        default: 'squash',
        options: [
          { name: 'Squash', value: 'squash', description: 'One commit on the base branch' },
          { name: 'Merge Commit', value: 'merge', description: 'Keep the commits and add a merge commit' },
          { name: 'Rebase', value: 'rebase', description: 'Replay the commits on the base branch' },
        ],
        displayOptions: show(['pullRequest'], ['merge']),
        description: 'The repository must allow this method',
      },
      {
        name: 'expectedHeadSha',
        displayName: 'Only If the Head Is',
        type: 'string',
        default: '',
        placeholder: '{{ $json.headSha }}',
        displayOptions: show(['pullRequest'], ['merge']),
        description: 'A commit SHA: merge only if the pull request still points at it, so what was checked is what is merged. Empty: whatever it points at now',
      },
      {
        name: 'commitTitle',
        displayName: 'Commit Title',
        type: 'string',
        default: '',
        displayOptions: show(['pullRequest'], ['merge']),
        description: 'Empty: GitHub’s default ("Title (#12)" for a squash)',
      },
      {
        name: 'returnAll',
        displayName: 'Return All',
        type: 'boolean',
        default: false,
        displayOptions: show(['pullRequest'], ['listFiles']),
        description: 'Whether to return all files (GitHub lists up to 3000) or only up to a limit',
      },
      {
        name: 'limit',
        displayName: 'Limit',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1 },
        displayOptions: { show: { resource: ['pullRequest'], operation: ['listFiles'], returnAll: [false] } },
        description: 'Max number of files to return',
      },
    ],
  },

  async execute(ctx) {
    const credentials = ctx.getCredentials<GitHubCredentials>('githubApi');
    const api: ApiContext = { http: ctx.http, metrics: ctx.metrics };
    return mapItems(ctx, async (i) => {
      const resource = ctx.getNodeParameter<string>('resource', i);
      const operation = ctx.getNodeParameter<string>('operation', i);
      const owner = requireString(ctx, 'owner', 'Owner', i);
      const repository = requireString(ctx, 'repository', 'Repository', i);
      const target: Target = { api, credentials, repo: repoPath(owner, repository) };
      switch (resource) {
        case 'repository':
          if (operation === 'get') return getRepository(target);
          if (operation === 'compare') return compareBranches(ctx, target, i);
          break;
        case 'file':
          return fileOperation(ctx, target, operation, i);
        case 'files':
          if (operation === 'commit') return commitFiles(ctx, target, i);
          break;
        case 'branch':
          return branchOperation(ctx, target, operation, i);
        case 'pullRequest':
          return pullRequestOperation(ctx, target, operation, i);
        case 'issue':
          return issueOperation(ctx, target, operation, i);
      }
      throw unsupported(resource, operation);
    });
  },
});

async function getRepository(t: Target): Promise<JsonObject> {
  const r = await githubCall<JsonObject>(t.api, t.credentials, 'GET', t.repo);
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    description: r.description ?? null,
    defaultBranch: r.default_branch,
    archived: r.archived ?? false,
    fork: r.fork ?? false,
    permissions: r.permissions ?? null,
    url: r.html_url,
    cloneUrl: r.clone_url,
  };
}

/** GitHub's compare lists at most this many files, 100 to a page. */
const MAX_COMPARE_FILES = 300;

/**
 * `GET /compare/{base}...{head}`: what the head holds beyond the base. The files come in pages of 100 up to 300 (GitHub's
 * limit), each with its patch unless the file is large or binary; a longer list is cut and says so.
 */
async function compareBranches(ctx: IExecuteContext, t: Target, i: number): Promise<JsonObject> {
  const head = requireString(ctx, 'compareHead', 'Head', i);
  const base = optionalString(ctx, 'compareBase', i) || (await defaultBranch(t));
  const range = `${t.repo}/compare/${encodePath(base)}...${encodePath(head)}`;
  const files: JsonObject[] = [];
  let first: JsonObject = {};
  let more = false;
  for (let page = 1; files.length < MAX_COMPARE_FILES; page++) {
    const result = await githubCall<JsonObject>(t.api, t.credentials, 'GET', `${range}?per_page=${PAGE_SIZE}&page=${page}`);
    if (page === 1) first = result;
    const batch = (result.files ?? []) as JsonObject[];
    files.push(...batch);
    more = batch.length === PAGE_SIZE;
    if (!more) break;
  }
  // A full last page at the limit may hide more files: GitHub does not say how many there are.
  const truncated = more && files.length >= MAX_COMPARE_FILES;
  return {
    base,
    head,
    status: first.status ?? null,
    aheadBy: first.ahead_by ?? 0,
    behindBy: first.behind_by ?? 0,
    totalCommits: first.total_commits ?? 0,
    url: first.html_url ?? null,
    files: files.slice(0, MAX_COMPARE_FILES).map((f) => ({
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      previousPath: f.previous_filename ?? null,
      patch: f.patch ?? null,
    })),
    truncated,
    ...(truncated && { note: `GitHub lists at most ${MAX_COMPARE_FILES} files of a comparison: the rest are not shown here. Open the comparison on GitHub for all of them.` }),
  };
}

async function fileOperation(ctx: IExecuteContext, t: Target, operation: string, i: number): Promise<JsonObject | JsonObject[]> {
  const branch = optionalString(ctx, 'branch', i);
  const query = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  switch (operation) {
    case 'get': {
      const path = requireString(ctx, 'path', 'Path', i);
      const file = await githubCall<JsonObject>(t.api, t.credentials, 'GET', `${t.repo}/contents/${encodePath(path)}${query}`);
      if (Array.isArray(file) || file.type !== 'file') {
        throw new NodeOperationError(`"${path}" is ${Array.isArray(file) ? 'a directory' : `a ${text(file.type)}`}, not a file`, { description: 'Use File → List for a directory.' });
      }
      let content = file.encoding === 'base64' ? fromBase64(text(file.content)) : null;
      if (content === null || (!content && Number(file.size) > 0)) {
        // Files over 1 MB come back without content: the blob API serves them (up to 100 MB).
        const blob = await githubCall<JsonObject>(t.api, t.credentials, 'GET', `${t.repo}/git/blobs/${encodeURIComponent(text(file.sha))}`);
        content = blob.encoding === 'base64' ? fromBase64(text(blob.content)) : text(blob.content);
      }
      return { path: file.path, name: file.name, sha: file.sha, size: file.size, content, url: file.html_url };
    }
    case 'list': {
      const path = optionalString(ctx, 'path', i).replace(/^\/+|\/+$/g, '');
      const listing = await githubCall<JsonObject[] | JsonObject>(t.api, t.credentials, 'GET', `${t.repo}/contents${path ? `/${encodePath(path)}` : ''}${query}`);
      if (!Array.isArray(listing)) throw new NodeOperationError(`"${path}" is a file, not a directory`, { description: 'Use File → Get to read a file.' });
      return listing.map((e) => ({ name: e.name, path: e.path, type: e.type, sha: e.sha, size: e.size, url: e.html_url }));
    }
    case 'createOrUpdate': {
      const path = requireString(ctx, 'path', 'Path', i);
      const message = requireString(ctx, 'message', 'Commit Message', i);
      const content = text(ctx.getNodeParameter<unknown>('content', i, ''));
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new NodeOperationError(`Content is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`, { itemIndex: i });
      let sha = optionalString(ctx, 'sha', i);
      let created = !sha;
      if (!sha) {
        const existing = await githubCallOrMissing<JsonObject>(t.api, t.credentials, 'GET', `${t.repo}/contents/${encodePath(path)}${query}`);
        if (existing && Array.isArray(existing)) throw new NodeOperationError(`"${path}" is a directory, not a file`, { itemIndex: i });
        sha = text(existing?.sha);
        created = !existing;
      }
      const result = await githubCall<JsonObject>(t.api, t.credentials, 'PUT', `${t.repo}/contents/${encodePath(path)}`, {
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        ...(branch && { branch }),
        ...(sha && { sha }),
      });
      const file = (result.content ?? {}) as JsonObject;
      return { created, path: file.path ?? path, sha: file.sha ?? null, url: file.html_url ?? null, commit: commitSummary(result.commit as JsonObject) ?? null };
    }
  }
  throw unsupported('file', operation);
}

/**
 * Several files in ONE commit through the Git Data API: read the branch's tip, upload a blob per file, build a tree on
 * the tip's tree, create the commit and move the ref to it. A branch that does not exist (and may be created) starts
 * from the base branch's tip and gets its ref only at the end, so a failure halfway leaves no empty branch behind.
 */
async function commitFiles(ctx: IExecuteContext, t: Target, i: number): Promise<JsonObject> {
  const branch = requireString(ctx, 'branch', 'Branch', i);
  const message = requireString(ctx, 'message', 'Commit Message', i);
  const files = parseFiles(ctx.getNodeParameter<unknown>('files', i, ''));
  const createBranch = ctx.getNodeParameter<boolean>('createBranch', i, false);

  let parent = await branchSha(t, branch);
  const newBranch = parent === undefined;
  if (newBranch) {
    if (!createBranch) {
      throw new NodeOperationError(`The branch "${branch}" does not exist`, { itemIndex: i, description: 'Turn on Create Branch If Missing to create it from a base branch, or use Branch → Create first.' });
    }
    parent = await baseSha(t, optionalString(ctx, 'baseBranch', i), '');
  }

  const parentCommit = await githubCall<{ tree: { sha: string } }>(t.api, t.credentials, 'GET', `${t.repo}/git/commits/${parent}`);
  const tree: JsonObject[] = [];
  for (const file of files) {
    const blob = await githubCall<{ sha: string }>(t.api, t.credentials, 'POST', `${t.repo}/git/blobs`, { content: file.content, encoding: file.encoding });
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await githubCall<{ sha: string }>(t.api, t.credentials, 'POST', `${t.repo}/git/trees`, { base_tree: parentCommit.tree.sha, tree });
  const commit = await githubCall<JsonObject>(t.api, t.credentials, 'POST', `${t.repo}/git/commits`, { message, tree: newTree.sha, parents: [parent!] });
  if (newBranch) {
    await githubCall(t.api, t.credentials, 'POST', `${t.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: text(commit.sha) });
    reportBranch(ctx, t, branch);
  } else {
    // Not forced: if the branch moved meanwhile GitHub refuses (422 "not a fast forward") rather than dropping the other commit.
    await githubCall(t.api, t.credentials, 'PATCH', `${t.repo}/git/refs/heads/${encodePath(branch)}`, { sha: text(commit.sha), force: false });
  }
  return {
    branch,
    createdBranch: newBranch,
    commitSha: commit.sha,
    treeSha: newTree.sha,
    parentSha: parent!,
    url: commit.html_url ?? null,
    files: files.map((f, n) => ({ path: f.path, sha: tree[n].sha })),
  };
}

/** `GET /repos/:owner/:repo/commits/:sha`, the parts Branch Get returns. */
interface RestCommit {
  html_url?: string;
  commit?: { message?: string; author?: { name?: string; email?: string; date?: string } };
  stats?: { additions?: number; deletions?: number };
  files?: Array<{ filename: string; status: string; additions: number; deletions: number }>;
}

/** How many of a commit's files Branch Get lists. */
const COMMIT_FILES = 100;

async function branchOperation(ctx: IExecuteContext, t: Target, operation: string, i: number): Promise<JsonObject> {
  const branch = requireString(ctx, 'branch', 'Branch', i);
  switch (operation) {
    case 'create': {
      const sha = await baseSha(t, optionalString(ctx, 'baseBranch', i), optionalString(ctx, 'baseSha', i));
      const ref = await githubCall<{ ref: string; object: { sha: string } }>(t.api, t.credentials, 'POST', `${t.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
      reportBranch(ctx, t, branch);
      return { branch, ref: ref.ref, sha: ref.object.sha };
    }
    case 'get': {
      const ref = await githubCall<{ ref: string; object: { sha: string } }>(t.api, t.credentials, 'GET', `${t.repo}/git/ref/heads/${encodePath(branch)}`);
      // The commit too: what landed on the branch, who wrote it and the files it changed.
      const commit = await githubCall<RestCommit>(t.api, t.credentials, 'GET', `${t.repo}/commits/${ref.object.sha}`);
      const files = commit.files ?? [];
      return {
        branch,
        ref: ref.ref,
        sha: ref.object.sha,
        message: commit.commit?.message ?? '',
        author: commit.commit?.author?.name ?? null,
        authorEmail: commit.commit?.author?.email ?? null,
        date: commit.commit?.author?.date ?? null,
        url: commit.html_url ?? null,
        stats: { additions: commit.stats?.additions ?? 0, deletions: commit.stats?.deletions ?? 0, files: files.length },
        files: files.slice(0, COMMIT_FILES).map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
      };
    }
  }
  throw unsupported('branch', operation);
}

async function pullRequestOperation(ctx: IExecuteContext, t: Target, operation: string, i: number): Promise<JsonObject | JsonObject[]> {
  const number = () => {
    const n = Number(ctx.getNodeParameter<unknown>('pullNumber', i, 0));
    if (!Number.isInteger(n) || n < 1) throw new NodeOperationError('Pull Request Number is required', { itemIndex: i });
    return n;
  };
  switch (operation) {
    case 'create': {
      const body = text(ctx.getNodeParameter<unknown>('body', i, ''));
      const pull = await githubCall<JsonObject>(t.api, t.credentials, 'POST', `${t.repo}/pulls`, {
        title: requireString(ctx, 'title', 'Title', i),
        head: requireString(ctx, 'head', 'Head Branch', i),
        base: requireString(ctx, 'base', 'Base Branch', i),
        draft: ctx.getNodeParameter<boolean>('draft', i, true),
        ...(body && { body }),
      });
      const created = simplifyPull(pull);
      ctx.artifact({ name: `PR #${created.number}: ${created.title}`, kind: 'pull_request', ...(typeof created.url === 'string' && { url: created.url }), data: { number: created.number, head: created.head, base: created.base, draft: created.draft } });
      return created;
    }
    case 'get':
      return simplifyPull(await githubCall<JsonObject>(t.api, t.credentials, 'GET', `${t.repo}/pulls/${number()}`));
    case 'listFiles': {
      const n = number();
      const returnAll = ctx.getNodeParameter<boolean>('returnAll', i, false);
      const limit = returnAll ? MAX_PR_FILES : Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)) || 50);
      const files: JsonObject[] = [];
      for (let page = 1; files.length < limit; page++) {
        const size = Math.min(PAGE_SIZE, limit - files.length);
        const batch = await githubCall<JsonObject[]>(t.api, t.credentials, 'GET', `${t.repo}/pulls/${n}/files?per_page=${PAGE_SIZE}&page=${page}`);
        files.push(...batch);
        if (batch.length < PAGE_SIZE || size <= 0) break;
      }
      return files.slice(0, limit).map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        previousPath: f.previous_filename ?? null,
        sha: f.sha,
        patch: f.patch ?? null,
      }));
    }
    case 'comment': {
      const comment = await githubCall<JsonObject>(t.api, t.credentials, 'POST', `${t.repo}/issues/${number()}/comments`, {
        body: requireString(ctx, 'commentBody', 'Comment', i),
      });
      return simplifyComment(comment);
    }
    case 'merge': {
      const n = number();
      const sha = optionalString(ctx, 'expectedHeadSha', i);
      const title = optionalString(ctx, 'commitTitle', i);
      const method = ctx.getNodeParameter<string>('mergeMethod', i, 'squash');
      const result = await githubCall<JsonObject>(t.api, t.credentials, 'PUT', `${t.repo}/pulls/${n}/merge`, {
        merge_method: method,
        ...(sha && { sha }),
        ...(title && { commit_title: title }),
      });
      const url = `${webBase(t.credentials)}${t.repo.replace('/repos', '')}/pull/${n}`;
      ctx.artifact({ name: `Merged PR #${n}`, kind: 'merge', url, data: { number: n, sha: result.sha ?? null, method } });
      return { number: n, merged: result.merged ?? false, sha: result.sha ?? null, method, message: result.message ?? null, url };
    }
  }
  throw unsupported('pullRequest', operation);
}

async function issueOperation(ctx: IExecuteContext, t: Target, operation: string, i: number): Promise<JsonObject> {
  switch (operation) {
    case 'create': {
      const options = ctx.getNodeParameter<JsonObject>('options', i, {}) ?? {};
      const body = text(ctx.getNodeParameter<unknown>('body', i, ''));
      const labels = names(text(options.labels));
      const assignees = names(text(options.assignees));
      const issue = await githubCall<JsonObject>(t.api, t.credentials, 'POST', `${t.repo}/issues`, {
        title: requireString(ctx, 'title', 'Title', i),
        ...(body && { body }),
        ...(labels.length && { labels }),
        ...(assignees.length && { assignees }),
      });
      ctx.artifact({ name: `Issue #${issue.number}: ${issue.title}`, kind: 'ticket', ...(typeof issue.html_url === 'string' && { url: issue.html_url }), data: { number: issue.number, state: issue.state } });
      return { number: issue.number, title: issue.title, state: issue.state, url: issue.html_url, labels: ((issue.labels ?? []) as JsonObject[]).map((l) => l.name ?? null) };
    }
    case 'comment': {
      const n = Number(ctx.getNodeParameter<unknown>('issueNumber', i, 0));
      if (!Number.isInteger(n) || n < 1) throw new NodeOperationError('Issue Number is required', { itemIndex: i });
      return simplifyComment(
        await githubCall<JsonObject>(t.api, t.credentials, 'POST', `${t.repo}/issues/${n}/comments`, { body: requireString(ctx, 'commentBody', 'Comment', i) }),
      );
    }
  }
  throw unsupported('issue', operation);
}
