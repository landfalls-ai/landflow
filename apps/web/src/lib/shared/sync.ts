/**
 * Git sync and source control: what /api/sync/* and /api/source-control/* answer. Types only (the
 * Settings page imports them); the format itself is lib/server/sync/format.ts.
 */

/** `credential`: one created from a promoted definition; `tableRows`: a table's rows replaced by a promoted rows file. */
export type SyncEntityKind = 'workflow' | 'folder' | 'variable' | 'dataTable' | 'credential' | 'tableRows';
export type SyncAction = 'create' | 'update' | 'delete';

/** One difference between the files and the instance, as push would apply it. */
export interface SyncChange {
  kind: SyncEntityKind;
  action: SyncAction;
  /** Workflow, folder or table id; the key of a variable. */
  id: string;
  name: string;
  /** The file it comes from (absent for deletes). */
  path?: string;
  /** Update: what differs (`nodes`, `name`, `folder`, `+column email`, …). */
  fields?: string[];
  /** Held back: the instance changed since the last sync (applied anyway with `force`). */
  conflict?: string;
  /** Not applied: deletes need `prune`. */
  skipped?: 'prune';
}

/** POST /api/sync/apply (and a source-control pull): the plan, and whether it was applied. */
export interface SyncApplyResult {
  dryRun: boolean;
  /** True when the changes were written (false for a dry run, errors, or conflicts without `force`). */
  applied: boolean;
  /** How many changes were written. */
  appliedCount: number;
  changes: SyncChange[];
  /** Changes with a `conflict`. */
  conflicts: number;
  warnings: string[];
  /** Files that couldn't be read or validated (nothing is applied), or changes that failed while applying. */
  errors: string[];
  /** Entity hashes of the instance after the call: the base for the next one. */
  hashes: Record<string, string>;
}

/** GET /api/sync/export */
export interface SyncExport {
  format: string;
  files: Array<{ path: string; content: string; hash: string }>;
  hashes: Record<string, string>;
  summary: { workflows: number; folders: number; variables: number; dataTables: number; credentials: number };
}

/** Settings → Source control, as stored (secrets stay in the credential or the environment). */
export interface SourceControlConfig {
  /** A local path (absolute, or file://) or a remote URL (https://, http://, ssh://, user@host:path). */
  repository: string;
  branch: string;
  /** Sub-directory of the repository that holds the files ('' = the root). */
  directory: string;
  /** A saved credential whose token (or password, API key, value) authenticates HTTPS; else LANDFLOW_GIT_TOKEN. */
  credentialId?: string;
  /** HTTPS user name sent with the token (GitHub accepts any; GitLab wants `oauth2`). */
  username: string;
  /**
   * SSH remotes: a saved credential holding the private key (an "SSH private key" credential, or any one with a PEM key
   * in `privateKey`; optional `passphrase`). Without one, ssh uses the host account's keys.
   */
  sshCredentialId?: string;
  /** SSH remotes with a credential: the pinned host keys (`known_hosts` lines). The connection is refused for any other key. */
  knownHosts?: string;
  authorName: string;
  authorEmail: string;
  /** Write variable values into variables.json (default: names only). */
  includeVariableValues: boolean;
}

export interface SourceControlRun {
  at: string;
  commit?: string;
  message?: string;
  /** Changes written (pull) or files committed (push). */
  count: number;
}

export interface SourceControlView {
  configured: boolean;
  config?: SourceControlConfig;
  /** Where the token comes from: the credential, LANDFLOW_GIT_TOKEN, or nowhere (public or local repositories). */
  tokenSource: 'credential' | 'env' | 'none';
  credentialName?: string;
  /** The SSH key credential's name (SSH remotes). */
  sshCredentialName?: string;
  /** How the repository is reached. */
  transport?: 'local' | 'https' | 'ssh';
  /** The working copy under the data directory. */
  workingCopy: string;
  lastPush?: SourceControlRun;
  lastPull?: SourceControlRun;
}

/** POST /api/source-control/push */
export interface SourceControlPushResult {
  dryRun: boolean;
  committed: boolean;
  /** The new commit, or the branch head when nothing changed (absent on an empty branch). */
  commit?: string;
  branch: string;
  /** What the commit changes: `A`dded, `M`odified, `D`eleted, relative to the repository root. */
  files: Array<{ status: string; path: string }>;
}

/** POST /api/source-control/pull */
export interface SourceControlPullResult extends SyncApplyResult {
  commit: string;
  branch: string;
}

/** POST /api/source-control/host-keys: the host keys an SSH server presents, to pin after checking their fingerprints. */
export interface HostKeyScan {
  host: string;
  port: number;
  keys: Array<{ type: string; fingerprint: string; line: string }>;
  /** The `known_hosts` text to save as the pinned host keys. */
  knownHosts: string;
}

/** One commit that touched a workflow's file (GET /api/workflows/:id/git-history). */
export interface GitHistoryEntry {
  commit: string;
  shortCommit: string;
  author: string;
  email: string;
  at: string;
  subject: string;
  /** The file's path in the repository at that commit (relative to the repository root). */
  path: string;
}

export interface GitHistory {
  branch: string;
  /** The workflow's file on the branch now (absent when it was never pushed). */
  path?: string;
  commits: GitHistoryEntry[];
  /** The branch isn't in the repository yet. */
  branchMissing?: boolean;
}

/** GET /api/workflows/:id/git-history/:commit?path= */
export interface GitCommitDetail extends GitHistoryEntry {
  body: string;
  /** Unified diff of the workflow's file in that commit. */
  diff: string;
  /** The workflow as that commit has it (absent when the commit deleted the file). */
  workflow?: { name: string; nodes: number; active: boolean };
}
