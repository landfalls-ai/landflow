/**
 * GitHub's MCP server as an agent's tool (docs/a2a.md, "GitHub's MCP tools for agents"). It is an ordinary MCP server tool
 * (lib/shared/agents.ts, McpServerToolConfig) with `preset: 'github'`: the tools the agent gets are cut down to an allow-list
 * chosen by `access`, here, on the server, whatever the server lists and whatever the agent's settings say.
 *
 * - `read`: look at pull requests, files, diffs, issues, commits, releases, searches and Actions runs.
 * - `review`: read, and also review (pending review, line comments, submit) and comment on pull requests and issues.
 * - Never offered, at either access: merging, anything that writes branches, files, repositories or settings, opening or
 *   editing pull requests and issues. Merging belongs to the flow. The names are those of github-mcp-server v2.0.2 (the version
 *   deploy/k8s/components/github-mcp pins), which also drops them itself with `--exclude-tools`.
 */
import type { McpServerToolConfig } from '../../shared/agents';

export type GithubAccess = 'read' | 'review';

export const GITHUB_READ_TOOLS: readonly string[] = [
  'get_commit', 'get_file_contents', 'get_repository_tree', 'issue_read', 'list_branches', 'list_commits', 'list_issues', 'list_pull_requests',
  'list_releases', 'list_tags', 'get_tag', 'get_latest_release', 'get_release_by_tag', 'pull_request_read', 'search_code', 'search_commits',
  'search_issues', 'search_pull_requests', 'search_repositories', 'actions_get', 'actions_list', 'get_job_logs', 'get_label', 'list_label',
];

/** Reviews (`pull_request_review_write`: create, submit or delete a pending review, resolve a thread), line comments, replies and comments. */
export const GITHUB_REVIEW_TOOLS: readonly string[] = ['pull_request_review_write', 'add_comment_to_pending_review', 'add_reply_to_pull_request_comment', 'add_issue_comment'];

/** Refused even if a list above (or a later edit of it) held them; the MCP server's own `--exclude-tools` repeats it. */
export const GITHUB_NEVER_TOOLS: readonly string[] = [
  'merge_pull_request', 'create_pull_request', 'update_pull_request', 'update_pull_request_branch', 'create_branch', 'create_or_update_file', 'push_files',
  'delete_file', 'create_repository', 'fork_repository', 'delete_repository', 'create_repository_ruleset', 'custom_properties_write', 'issue_write',
  'sub_issue_write', 'update_issue_comment', 'label_write', 'projects_write', 'actions_run_trigger', 'assign_copilot_to_issue',
  'assign_copilot_to_issue_with_intent', 'request_copilot_review', 'create_gist', 'update_gist',
];

/** The tool names an access level may call. Anything that is not `review` is `read`. */
export function githubAllowedTools(access: unknown): Set<string> {
  const names = access === 'review' ? [...GITHUB_READ_TOOLS, ...GITHUB_REVIEW_TOOLS] : [...GITHUB_READ_TOOLS];
  const never = new Set(GITHUB_NEVER_TOOLS);
  return new Set(names.filter((name) => !never.has(name)));
}

export const isGithubPreset = (tool: { preset?: string }): boolean => tool.preset === 'github';

/** What the agent may be given of the tools a GitHub MCP server listed. */
export function githubToolsOf<T extends { name: string }>(config: Pick<McpServerToolConfig, 'preset' | 'access'>, listed: T[]): T[] {
  const allowed = githubAllowedTools(config.access);
  return listed.filter((tool) => allowed.has(tool.name));
}

/** Where the bundled server answers inside the cluster (deploy/k8s/components/github-mcp); `LANDFLOW_GITHUB_MCP_URL` overrides. */
export const githubMcpUrl = (): string => (process.env.LANDFLOW_GITHUB_MCP_URL ?? '').trim() || 'http://landflow-github-mcp:8082/';
