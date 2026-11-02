/**
 * Reviews and comments an agent left on GitHub through its MCP tools (lib/server/mcp/github.ts), as Run Trace artifacts
 * of kind `review_comment` (docs/run-trace.md, "Review comments"): read from the tool call (a Landflow agent's, or a Claude
 * Code member's `mcp__<server>__<tool>` step the landflow-harness mod reported), and told in the member's words by the card.
 */
import type { RunArtifact } from './run-trace';

export const REVIEW_COMMENT_KIND = 'review_comment';

export type ReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/** What the artifact's `data` holds. */
export interface ReviewCommentData {
  /** `line`: a comment on a line of a file; `review`: a submitted review; `reply`: a reply to a review comment; `comment`: a comment on the pull request or issue. */
  action: 'line' | 'review' | 'reply' | 'comment';
  /** `owner/repo`. */
  repository: string;
  /** The pull request's (or issue's) number. */
  number?: number;
  path?: string;
  line?: number;
  verdict?: ReviewVerdict;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const whole = (value: unknown) => {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
};

/** The tool's own name from the one the model or the mod reported: `mcp__github__add_issue_comment` is `add_issue_comment`. */
export function bareToolName(name: string): string {
  const at = name.lastIndexOf('__');
  return at < 0 ? name : name.slice(at + 2);
}

const VERDICTS: Record<string, ReviewVerdict> = { APPROVE: 'APPROVE', REQUEST_CHANGES: 'REQUEST_CHANGES', COMMENT: 'COMMENT' };
const verdictWords = (verdict: ReviewVerdict) => verdict.toLowerCase().replace(/_/g, ' ');

/** The first GitHub link in what a tool returned: JSON or text, an MCP result's text parts included. */
function urlIn(output: unknown, depth = 0): string | undefined {
  if (depth > 4 || output === undefined || output === null) return undefined;
  if (typeof output === 'string') {
    const trimmed = output.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return urlIn(JSON.parse(trimmed), depth + 1);
      } catch {
        // Not JSON: look for a link in the text.
      }
    }
    return /https:\/\/github\.com\/[^\s"')>]+/.exec(trimmed)?.[0];
  }
  if (Array.isArray(output)) {
    for (const part of output) {
      const found = urlIn(part, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const o = record(output);
  for (const key of ['html_url', 'url']) {
    const value = text(o[key]);
    if (value && /^https?:\/\//i.test(value) && !/\/\/api\.github\.com/i.test(value)) return value;
  }
  for (const key of ['content', 'text', 'result', 'data']) {
    const found = urlIn(o[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * The review comment a successful call of one of the GitHub MCP tools made, or none: for a call to another tool, to a
 * server whose arguments are not GitHub's (`owner`, `repo`), or to review tools that leave nothing visible yet (a pending
 * review, deleting one, resolving a thread).
 */
export function reviewCommentOf(tool: string, args: unknown, output?: unknown): RunArtifact | undefined {
  const name = bareToolName(tool);
  const a = record(args);
  const owner = text(a.owner);
  const repo = text(a.repo);
  if (!owner || !repo) return undefined;
  const body = text(a.body);
  const repository = `${owner}/${repo}`;
  const url = urlIn(output);
  const make = (label: string, data: ReviewCommentData): RunArtifact => ({
    name: label,
    kind: REVIEW_COMMENT_KIND,
    ...(url && { url }),
    ...(body && { text: body }),
    data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as NonNullable<RunArtifact['data']>,
  });
  const number = whole(a.pullNumber) ?? whole(a.pull_number);
  const of = number === undefined ? repository : `${repository}#${number}`;
  switch (name) {
    case 'add_comment_to_pending_review': {
      const path = text(a.path);
      if (!path || !body) return undefined;
      const line = whole(a.line);
      return make(`Comment on ${path}${line ? ` line ${line}` : ''} (${of})`, { action: 'line', repository, number, path, line });
    }
    case 'pull_request_review_write': {
      // A pending review is not seen until it is submitted: `create` with an event, or `submit_pending`.
      const method = text(a.method);
      const verdict = VERDICTS[String(a.event ?? '').toUpperCase()];
      if (!verdict || (method !== 'submit_pending' && method !== 'create')) return undefined;
      return make(`Review of ${of}: ${verdictWords(verdict)}`, { action: 'review', repository, number, verdict });
    }
    case 'add_reply_to_pull_request_comment':
      return body ? make(`Reply on ${of}`, { action: 'reply', repository, number }) : undefined;
    case 'add_issue_comment': {
      const n = whole(a.issue_number) ?? whole(a.issueNumber) ?? number;
      return body ? make(`Comment on ${n === undefined ? repository : `${repository}#${n}`}`, { action: 'comment', repository, number: n }) : undefined;
    }
    default:
      return undefined;
  }
}

/** How the story tells it: what the member did, and what they wrote. */
export interface ReviewCommentCard {
  /** After the member's name: "commented on src/a.ts line 42". */
  verb: string;
  /** What they wrote, when they wrote anything. */
  quote?: string;
  verdict?: ReviewVerdict;
  url?: string;
}

export const isReviewComment = (artifact: Pick<RunArtifact, 'kind'>) => artifact.kind === REVIEW_COMMENT_KIND;

/** The card for a review comment artifact, from its data (a foreign one falls back to its name). */
export function reviewCommentCard(artifact: RunArtifact): ReviewCommentCard {
  const d = record(artifact.data);
  const number = whole(d.number);
  const target = number === undefined ? text(d.repository) ?? 'the repository' : `pull request #${number}`;
  const path = text(d.path);
  const line = whole(d.line);
  const verdict = VERDICTS[String(d.verdict ?? '')];
  const action = d.action;
  const verb =
    action === 'line' && path
      ? `commented on ${path}${line ? ` line ${line}` : ''}`
      : action === 'review'
        ? `reviewed ${target}${verdict ? `: ${verdictWords(verdict)}` : ''}`
        : action === 'reply'
          ? `replied to a review comment on ${target}`
          : action === 'comment'
            ? `commented on ${number === undefined ? target : `#${number}`}`
            : artifact.name;
  const quote = text(artifact.text);
  const url = text(artifact.url);
  return { verb, ...(quote && { quote }), ...(verdict && { verdict }), ...(url && { url }) };
}
