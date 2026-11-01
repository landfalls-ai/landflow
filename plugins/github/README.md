# GitHub plugin (`github`)

Deterministic GitHub steps for flows, written with the TypeScript SDK: read and write files, **commit several files in one
commit**, create branches, open draft pull requests, comment. It talks to the GitHub REST API (v3, `X-GitHub-Api-Version: 2022-11-28`)
with `fetch` through the SDK's traced `ctx.http`. Agents get GitHub through GitHub's own MCP server; this node is for the fixed
steps a flow does itself (and an agent may still call it as a tool). Like every plugin it answers over HTTP, gRPC, any installed
broker and MCP.

```sh
pnpm --filter @landflow/plugin-github start       # HTTP :7111, gRPC :7211, announces to LANDFLOW_REGISTRY_URL
pnpm --filter @landflow/plugin-github test        # vitest against an in-memory fake GitHub (test/fake-github.ts)
pnpm --filter @landflow/plugin-github typecheck
```

`LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` override the ports. The tests never reach github.com.

The Productivity plugin also has a **GitHub** node (issues, repositories, releases, triggers). This one is the narrow, write-oriented
set a flow needs to land a change: the type is `github.github`, the other `productivity.github`.

## Credential: GitHub API (`githubApi`)

| Field | |
|---|---|
| **Access Token** (secret) | A personal access token (classic: `repo`; fine-grained: Contents, Pull requests and Issues read and write on the repositories) or a GitHub App installation token |
| **API Base URL** | Default `https://api.github.com`. GitHub Enterprise Server: `https://<host>/api/v3` |

**Test** calls `GET /user`. (An installation token has no user, so test it by running a node.)

## Node: GitHub (`github.github`)

Category Development, `usableAsTool: true`, not idempotent (the read operations are). Every operation takes **Owner** and **Repository**;
parameters are read per item and every output item is paired with its input. Results are compact objects (not GitHub's full payloads).

| Resource | Operation | Parameters | Result |
|---|---|---|---|
| Repository | Get | | `fullName`, `private`, `defaultBranch`, `permissions`, `url`, `cloneUrl` |
| Repository | Compare | Base (empty: default branch), Head | `base`, `head`, `status`, `aheadBy`, `behindBy`, `totalCommits`, `url`, `files[{ path, status, additions, deletions, previousPath, patch }]`, `truncated` |
| File | Get | Path, Branch (empty: default; a tag or SHA works) | `path`, `sha`, `size`, decoded UTF-8 `content`. Files over 1 MB are read through the blob API |
| File | List | Path (a directory; empty: root), Branch | one item per entry: `name`, `path`, `type` (`file`, `dir`…), `sha`, `size` |
| File | Create or Update | Path, Content, Commit Message, Branch (empty: default), File SHA | `created`, `path`, `sha`, `commit`. Without a File SHA the node looks the file up on the branch (missing: created) |
| Files (One Commit) | Commit | Branch, Commit Message, **Files** (JSON array of `{ "path", "content" }`), Create Branch If Missing, Base Branch | `commitSha`, `treeSha`, `parentSha`, `branch`, `createdBranch`, `files[{ path, sha }]` |
| Branch | Create | Branch, Base Branch (empty: default branch) or Base Commit SHA | `branch`, `ref`, `sha` |
| Branch | Get | Branch | `branch`, `ref`, `sha` |
| Pull Request | Create | Title, Body, Head Branch (`owner:branch` from a fork), Base Branch, **Draft** (on by default) | `number`, `title`, `draft`, `head`, `base`, `url`… |
| Pull Request | Get | Pull Request Number | the same shape, plus `mergeable`, `commits`, `changedFiles`, `additions`, `deletions` |
| Pull Request | List Files | Pull Request Number, Return All (up to GitHub's 3000) / Limit | one item per file: `path`, `status`, `additions`, `deletions`, `previousPath`, `patch` |
| Pull Request | Comment | Pull Request Number, Comment | `id`, `body`, `author`, `url` |
| Pull Request | Merge | Pull Request Number, Merge Method (Squash by default, Merge Commit, Rebase), Only If the Head Is (a commit SHA), Commit Title | `number`, `merged`, `sha`, `method`, `message`, `url` |
| Issue | Create | Title, Body, Options: Labels, Assignees (comma-separated) | `number`, `title`, `state`, `url`, `labels` |
| Issue | Comment | Issue Number, Comment | as above |

**Compare** is `GET /compare/{base}...{head}`: what the head holds beyond the base. Files come 100 to a page up to 300,
GitHub's limit; a longer list is cut, `truncated` is true and `note` says so. A file's `patch` is null when GitHub leaves
it out (a large or binary file). Run Trace's Artifacts tab uses it to show a branch as GitHub sees it.

There is no delete (of repositories, branches or files) on purpose. **Merge** needs a ready pull request (GitHub refuses
a draft) and fails with a hint when GitHub won't merge it: a conflict, a required check or review, a method the
repository doesn't allow (405), or a head that moved after the SHA given in **Only If the Head Is** (409). Put a check
before it, such as a Run Report node that must pass, or a person's approval: the node merges whatever it is given.

### Files: Commit

Several files land in **one** commit through the Git Data API, so the branch never holds a half-applied change:

1. `GET /git/ref/heads/{branch}` for the tip (and `GET /git/commits/{tip}` for its tree);
2. `POST /git/blobs` per file;
3. `POST /git/trees` with the files on top of the tip's tree (other files stay as they are);
4. `POST /git/commits` with the tip as parent;
5. `PATCH /git/refs/heads/{branch}` (not forced: if the branch moved meanwhile GitHub answers 422 "not a fast forward" and nothing is lost).

If the branch does not exist, **Create Branch If Missing** starts it from **Base Branch** (empty: the repository's default branch) and creates
the ref *after* the commit (`POST /git/refs`), so a failure leaves no stray branch; without the switch a missing branch fails the node.

**Files** is JSON, typically an expression such as `{{ $json.files }}`. Content is UTF-8 text; add `"encoding": "base64"` to an entry for binary
content. Paths are relative to the repository root, unique, and without `.` / `..` segments; up to 500 files, 25 MB each. The input is
checked before any call is made. Files are written as regular files (mode `100644`); the node does not delete files.

```json
[
  { "path": "docs/changelog.md", "content": "# Changelog\n…" },
  { "path": "src/version.ts", "content": "export const VERSION = '1.4.0';\n" }
]
```

A typical flow: **Files → Commit** (Create Branch If Missing, base `main`) → **Pull Request → Create** (draft) → **Pull Request → Comment**.
One that merges by itself: ... → **Run Report** (Passed) → **Pull Request → Create** (Draft off) → **Pull Request → Merge**
(Only If the Head Is `{{ $json.headSha }}`).

## Errors

A failure stops the node with the item index and GitHub's own message (`GitHub API error 422: Validation Failed: PullRequest head invalid`),
with the per-field detail of a 422, and a hint for the statuses people hit: **401** the token is wrong or expired, **403** missing scope or
permission, SSO not authorized, or the rate limit (with the reset time), **404** GitHub also answers this for a private repository the token cannot see,
**409** the repository state moved on, **422** the content was refused (branch already exists, no commits between head and base…). The token is
never in an error. The host's **On Error: Continue** keeps the flow going with `{ error }` for the failed item.

Metric: `landflow.github.api_errors` (by `status_class`, or `network` / `timeout`).

## Tests

`test/fake-github.ts` is an in-memory GitHub (one repository with a git object store, contents, pulls, issues) behind a local HTTP server;
`test/github.test.ts` covers every operation, the Files: Commit calls (blobs, tree, commit, ref; branch creation; the fast-forward refusal;
validation) and the error mapping; `test/plugin.test.ts` checks the manifest and an Execute over HTTP.
