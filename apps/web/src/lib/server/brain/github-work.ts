/**
 * GitHub deliveries as work events (docs/features/integrations.md#github-into-the-brain). A pure mapper: one webhook
 * delivery (pull_request, pull_request_review, workflow_run or status) becomes zero or one flat work.* item, with a
 * sourceId that is stable per fact so a redelivery has the same id (Record Event does not upsert, so readers that count
 * facts de-duplicate on it). It copies no diff, code, commit contents or review text: a review's state only, and the
 * first 300 characters of a pull request's description, redacted.
 */
import { redact } from '../usage/ledger';

export type GithubWorkKind = 'work.pr_opened' | 'work.pr_merged' | 'work.pr_closed' | 'work.pr_reviewed' | 'work.review_requested' | 'work.ci_failed' | 'work.ci_passed';

/** Every kind the mapper can emit (deploy/brain/work-kinds.json declares each). */
export const GITHUB_WORK_KINDS: GithubWorkKind[] = ['work.pr_opened', 'work.pr_merged', 'work.pr_closed', 'work.pr_reviewed', 'work.review_requested', 'work.ci_failed', 'work.ci_passed'];

export interface GithubWorkItem {
  kind: GithubWorkKind;
  source: 'github';
  sourceId: string;
  occurredAt: string;
  title: string;
  summary?: string;
  url: string;
  repo: string;
  actor: string;
  actorEmail?: string;
  prNumber?: number;
  state?: string;
  reviewState?: string;
  ci?: { conclusion: string; durationMs: number; attempt: number };
  waitedMs?: number;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const ms = (value: unknown): number | undefined => {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

/** The login → email table, as an object or JSON text; lowercase logins, anything malformed is no table. */
export function parsePeople(value: unknown): Record<string, string> {
  let table: unknown = value;
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      table = JSON.parse(value);
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const [login, email] of Object.entries(obj(table))) if (typeof email === 'string' && email.includes('@')) out[login.toLowerCase()] = email.trim();
  return out;
}

const clip = (text: string, max = 120) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Map one delivery; null for any event or action that is not a work fact. */
export function githubToWork(event: string, body: unknown, people: Record<string, string> = {}): GithubWorkItem | null {
  const b = obj(body);
  const repo = str(obj(b.repository).full_name);
  if (!repo) return null;
  const login = str(obj(b.sender).login);
  const identify = (who: string) => ({ actor: who || 'unknown', ...(Object.hasOwn(people, who.toLowerCase()) && { actorEmail: people[who.toLowerCase()] }) });
  const base = { source: 'github' as const, repo };

  if (event === 'pull_request') {
    const pr = obj(b.pull_request);
    const number = num(pr.number) ?? num(b.number);
    if (number === undefined) return null;
    const action = str(b.action);
    const id = `${repo}#${number}`;
    const title = redact(str(pr.title)) ?? `Pull request ${number}`;
    const common = { ...base, title, url: str(pr.html_url), prNumber: number };
    const summary = redact(str(pr.body));
    const author = str(obj(pr.user).login);
    if (action === 'opened') {
      return { kind: 'work.pr_opened', sourceId: `${id}:opened`, occurredAt: str(pr.created_at), ...common, ...(summary && { summary }), state: 'open', ...identify(author || login) };
    }
    if (action === 'closed') {
      const merged = pr.merged === true;
      const by = merged ? str(obj(pr.merged_by).login) || login : login;
      return {
        kind: merged ? 'work.pr_merged' : 'work.pr_closed',
        sourceId: `${id}:${merged ? 'merged' : 'closed'}`,
        occurredAt: str(merged ? pr.merged_at : pr.closed_at) || str(pr.updated_at),
        ...common,
        state: merged ? 'merged' : 'closed',
        ...identify(by),
      };
    }
    if (action === 'review_requested') {
      const reviewer = str(obj(b.requested_reviewer).login) || str(obj(b.requested_team).slug);
      return { kind: 'work.review_requested', sourceId: `${id}:review_requested:${reviewer || 'any'}`, occurredAt: str(pr.updated_at), ...common, ...(reviewer && { summary: `Review requested from ${redact(reviewer)}` }), state: 'open', ...identify(login) };
    }
    return null;
  }

  if (event === 'pull_request_review') {
    if (str(b.action) !== 'submitted') return null;
    const pr = obj(b.pull_request);
    const review = obj(b.review);
    const number = num(pr.number);
    const reviewState = str(review.state).toLowerCase();
    if (number === undefined || !['approved', 'changes_requested', 'commented'].includes(reviewState)) return null;
    const submitted = ms(review.submitted_at);
    const created = ms(pr.created_at);
    // The body of a review is never copied: its state is the fact.
    return {
      kind: 'work.pr_reviewed',
      sourceId: `${repo}#${number}:reviewed:${str(review.id)}`,
      occurredAt: str(review.submitted_at),
      ...base,
      title: redact(`Review of ${str(pr.title)}`) ?? `Review of pull request ${number}`,
      url: str(review.html_url) || str(pr.html_url),
      prNumber: number,
      reviewState,
      ...(submitted !== undefined && created !== undefined && submitted >= created && { waitedMs: submitted - created }),
      ...identify(str(obj(review.user).login) || login),
    };
  }

  if (event === 'workflow_run') {
    if (str(b.action) !== 'completed') return null;
    const run = obj(b.workflow_run);
    const conclusion = str(run.conclusion);
    const kind = conclusion === 'success' ? 'work.ci_passed' : ['failure', 'timed_out', 'startup_failure'].includes(conclusion) ? 'work.ci_failed' : undefined;
    if (!kind) return null;
    const attempt = num(run.run_attempt) ?? 1;
    const started = ms(run.run_started_at);
    const ended = ms(run.updated_at);
    const pr = num(obj(Array.isArray(run.pull_requests) ? run.pull_requests[0] : undefined).number);
    const subject = pr !== undefined ? `${repo}#${pr}` : `${repo}@${str(run.head_sha).slice(0, 7)}`;
    return {
      kind,
      sourceId: `${subject}:${kind === 'work.ci_passed' ? 'ci_passed' : 'ci_failed'}:${str(run.id)}:${attempt}`,
      occurredAt: str(run.updated_at) || str(run.run_started_at),
      ...base,
      title: redact(`${str(run.name) || 'Workflow'} ${kind === 'work.ci_passed' ? 'passed' : 'failed'}${str(run.head_branch) ? ` on ${str(run.head_branch)}` : ''}`) ?? 'Workflow run',
      url: str(run.html_url),
      ...(pr !== undefined && { prNumber: pr }),
      ci: { conclusion, durationMs: started !== undefined && ended !== undefined && ended >= started ? ended - started : 0, attempt },
      ...identify(str(obj(run.actor).login) || login),
    };
  }

  if (event === 'status') {
    const state = str(b.state);
    const kind = state === 'success' ? 'work.ci_passed' : state === 'failure' || state === 'error' ? 'work.ci_failed' : undefined;
    if (!kind) return null;
    const sha = str(b.sha).slice(0, 7);
    const started = ms(b.created_at);
    const ended = ms(b.updated_at);
    return {
      kind,
      sourceId: `${repo}@${sha}:${kind === 'work.ci_passed' ? 'ci_passed' : 'ci_failed'}:${str(b.id)}:1`,
      occurredAt: str(b.updated_at) || str(b.created_at),
      ...base,
      title: redact(`${clip(str(b.context) || 'Commit status')} ${kind === 'work.ci_passed' ? 'passed' : 'failed'}`) ?? 'Commit status',
      url: str(b.target_url),
      ci: { conclusion: state, durationMs: started !== undefined && ended !== undefined && ended >= started ? ended - started : 0, attempt: 1 },
      ...identify(login),
    };
  }

  return null;
}
