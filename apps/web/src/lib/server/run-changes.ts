/**
 * The branch of a run as GitHub sees it (docs/run-trace.md#artifacts-and-code-changes): finds the repository and branch
 * the run's GitHub steps worked on, asks the GitHub plugin's Repository → Compare through the registry — with the flow's
 * own GitHub credential, the way a node of the flow would, never directly and never reading the token — and keeps the
 * answer per run for a little while. The route is `GET /api/executions/:id/changes`.
 */
import { PROTOCOL_VERSION, type ExecuteRequest, type JsonObject } from '@landflow/protocol';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { BranchChanges, BranchFile, BranchReply } from '../shared/run-changes';
import { branchOf, repoOf, type RunRepo } from '../shared/run-repo';
import { journalStore, rebuildJournal } from './journal';
import { registry } from './plugins/registry';
import { resolveWorkflowCredentials } from './projects/credentials';
import { liveExecution } from './runner';
import { singleton } from './singleton';
import { store } from './store';

export const GITHUB_NODE = 'github.github';

/** How long an answer is reused: a finished run's branch hardly moves; a live run's does. */
const FINISHED_TTL_MS = 10 * 60_000;
const LIVE_TTL_MS = 15_000;
const MAX_CACHED = 200;

interface Cached {
  /** The journal's last seq when asked: new events may name another branch. */
  seq: number;
  at: number;
  reply: BranchReply;
}
const cache = singleton('run-branch-changes', () => new Map<string, Cached>());

const literal = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() && !/^=|\{\{/.test(value) ? value.trim() : undefined);

/** The journal in full (a run's events are few thousand at most). */
function journalOf(executionId: string) {
  const events = [];
  for (let after = 0; ; ) {
    const page = journalStore.read(executionId, after, 2000);
    events.push(...page);
    if (page.length < 2000) return events;
    after = page.at(-1)!.seq;
  }
}

/** The GitHub step to borrow the credential of: one on the run's repository if several, else the first with a credential. */
function githubNode(workflow: Workflow, repo?: RunRepo): WorkflowNode | undefined {
  const nodes = workflow.nodes.filter((n) => n.type === GITHUB_NODE && !n.disabled && n.credentials?.githubApi?.id);
  const named = (n: WorkflowNode) => literal(n.parameters.owner)?.toLowerCase() === repo?.owner.toLowerCase() && literal(n.parameters.repository)?.toLowerCase() === repo?.repo.toLowerCase();
  return nodes.find(named) ?? nodes[0];
}

const unavailable = (reason: string): BranchReply => ({ available: false, reason });

/** Compares the run's branch with its base on GitHub. `undefined` when there is no such run. */
export async function runBranchChanges(executionId: string): Promise<BranchReply | undefined> {
  const running = liveExecution(executionId);
  const record = running ?? store.getExecution(executionId);
  if (!record) return undefined;
  const workflow = record.workflow ?? store.getWorkflow(record.workflowId);
  if (!running) rebuildJournal(record, workflow);
  const events = journalOf(executionId);
  const seq = events.at(-1)?.seq ?? 0;
  const cached = cache.get(executionId);
  const live = Boolean(running) || record.status === 'running' || record.status === 'waiting';
  if (cached && cached.seq === seq && Date.now() - cached.at < (live ? LIVE_TTL_MS : FINISHED_TTL_MS)) return cached.reply;

  const reply = await ask(workflow, events, executionId);
  if (reply.available) {
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    cache.set(executionId, { seq, at: Date.now(), reply });
  }
  return reply;
}

async function ask(workflow: Workflow | undefined, events: ReturnType<typeof journalOf>, executionId: string): Promise<BranchReply> {
  if (!workflow) return unavailable('The flow of this run no longer exists.');
  const nodes = workflow.nodes.filter((n) => n.type === GITHUB_NODE);
  if (!nodes.length) return unavailable('This run has no GitHub step.');
  // The repository the GitHub steps name (their parameters), else the one the journal shows.
  const named = nodes.map((n) => ({ owner: literal(n.parameters.owner), repo: literal(n.parameters.repository) })).find((n) => n.owner && n.repo);
  const repository = repoOf(events, named?.owner && named.repo ? { owner: named.owner, repo: named.repo } : undefined);
  if (!repository) return unavailable('The run does not say which repository it worked on.');
  const { branch, base } = branchOf(events);
  if (!branch) return unavailable('The run does not say which branch it worked on.');
  const node = githubNode(workflow, repository);
  if (!node) return unavailable('The GitHub steps of this flow have no credential to read the branch with.');

  const resolved = registry.resolve(node.type);
  if ('error' in resolved) return unavailable(resolved.error);
  try {
    const parameters: JsonObject = { resource: 'repository', operation: 'compare', owner: repository.owner, repository: repository.repo, compareBase: base ?? '', compareHead: branch };
    const request: ExecuteRequest = {
      protocol: PROTOCOL_VERSION,
      executionId: `${executionId}:changes`,
      workflowId: workflow.id,
      mode: 'manual',
      node: { id: node.id, name: node.name, type: node.type, typeVersion: node.typeVersion },
      parameters,
      itemParameters: [parameters],
      inputs: [[{ json: {} }]],
      // Only a credential the flow's project may use; expired OAuth tokens are renewed by the registry.
      credentials: resolveWorkflowCredentials(workflow.id, node, resolved.descriptor),
    };
    const response = await resolved.execute(request);
    if (response.error) return unavailable(response.error.description ? `${response.error.message} ${response.error.description}` : response.error.message);
    const out = response.outputs[0]?.[0]?.json;
    if (!out) return unavailable('GitHub gave no answer.');
    return { available: true, repository, branch: shape(out), fetchedAt: new Date().toISOString() };
  } catch (error) {
    return unavailable((error as Error).message);
  }
}

/** The plugin's Compare output as the screens read it. */
function shape(out: JsonObject): BranchChanges {
  const files = Array.isArray(out.files) ? (out.files as JsonObject[]) : [];
  return {
    base: String(out.base ?? ''),
    head: String(out.head ?? ''),
    status: typeof out.status === 'string' ? out.status : null,
    aheadBy: Number(out.aheadBy) || 0,
    behindBy: Number(out.behindBy) || 0,
    totalCommits: Number(out.totalCommits) || 0,
    url: typeof out.url === 'string' ? out.url : null,
    files: files.map(
      (f): BranchFile => ({
        path: String(f.path),
        status: String(f.status),
        additions: Number(f.additions) || 0,
        deletions: Number(f.deletions) || 0,
        previousPath: typeof f.previousPath === 'string' ? f.previousPath : null,
        patch: typeof f.patch === 'string' ? f.patch : null,
      }),
    ),
    truncated: out.truncated === true,
    ...(typeof out.note === 'string' && { note: out.note }),
  };
}
