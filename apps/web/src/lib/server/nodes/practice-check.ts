/**
 * Check Practices (`core.practiceCheck`, docs/practices.md#the-check-practices-step): the practices that apply to a change,
 * checked by the machine checks `@landflow/protocol` shares with `landflow practices check`, plus any reviewer verdicts a
 * model or a person gave. A required practice that failed makes this step throw, so the run fails here and nothing after it
 * runs, until the change is fixed (run the flow again) or a person who may approve the practice waives it for the run
 * (/practices/waive, then retry the run). Recommended failures only warn. This is the only place a practice blocks: an agent's
 * tool call is never denied. "On error: continue" on the step defeats the block, as it does for any step.
 *
 * Which practices: the approved ones of the workflow's home project and the organization's, read through the practices port
 * (never a project a parameter names), selected for the repository and the changed paths like delivery does.
 */
import { createHash } from 'node:crypto';
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';
import { practiceCheckLabel, runPracticeChecks, type PracticeChange, type PracticeCheckResult } from '@landflow/protocol';
import { homeProjectId } from '../projects/store';
import { practicesPort } from '../practices/port';
import { selectPractices } from '../practices/select';
import { findWaiver } from '../practices/store';
import { store } from '../store';
import { publicUrl } from '../config/urls';
import { PRACTICE_REPO, type ApprovedPractice } from '../../shared/practices';

const main = [{ type: 'main' as const }];
const MAX_FILES = 5000;
const MAX_LINES = 20_000;
/** How many runs back a retry chain is followed to find a waiver. */
const MAX_CHAIN = 25;

export interface ChangedFile {
  path: string;
  status: 'A' | 'M' | 'D';
  added?: string[];
}
export interface Verdict {
  handle: string;
  pass: boolean;
  note?: string;
}

/** A parameter that is JSON text or already a value (an expression's result). Undefined when empty. */
function jsonOf(value: unknown, what: string): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

/** The changed files, checked: `{ path, status: 'A' | 'M' | 'D', added?: string[] }` each. */
export function changeOf(value: unknown): { files: ChangedFile[]; change: PracticeChange } {
  const parsed = jsonOf(value, 'Changed files');
  if (parsed === undefined) return { files: [], change: { files: [], added: new Map() } };
  if (!Array.isArray(parsed)) throw new Error('Changed files must be a list of { path, status, added }');
  if (parsed.length > MAX_FILES) throw new Error(`Changed files holds ${parsed.length} files; at most ${MAX_FILES} are checked`);
  const files: ChangedFile[] = [];
  let lines = 0;
  parsed.forEach((raw, i) => {
    const f = raw as Record<string, unknown> | null;
    if (!f || typeof f !== 'object' || typeof f.path !== 'string' || !f.path) throw new Error(`Changed files item ${i + 1} has no path`);
    if (f.status !== 'A' && f.status !== 'M' && f.status !== 'D') throw new Error(`Changed files item ${i + 1} (${f.path}) needs a status of A, M or D`);
    const added = Array.isArray(f.added) ? f.added.map(String) : undefined;
    lines += added?.length ?? 0;
    if (lines > MAX_LINES) throw new Error(`Changed files holds more than ${MAX_LINES} added lines; check a smaller change`);
    files.push({ path: f.path, status: f.status, ...(added && { added }) });
  });
  return {
    files,
    change: { files: files.map((f) => ({ path: f.path, status: f.status })), added: new Map(files.filter((f) => f.added).map((f) => [f.path, f.added as string[]])) },
  };
}

/** Reviewer verdicts, checked: `{ handle, pass, note? }` each. */
export function verdictsOf(value: unknown): Verdict[] {
  const parsed = jsonOf(value, 'Reviewer verdicts');
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) throw new Error('Reviewer verdicts must be a list of { handle, pass, note }');
  return parsed.map((raw, i) => {
    const v = raw as Record<string, unknown> | null;
    if (!v || typeof v !== 'object' || typeof v.handle !== 'string' || typeof v.pass !== 'boolean') throw new Error(`Reviewer verdicts item ${i + 1} needs a handle and pass (true or false)`);
    return { handle: v.handle, pass: v.pass, ...(typeof v.note === 'string' && v.note && { note: v.note.slice(0, 500) }) };
  });
}

export type PracticeResult = 'pass' | 'fail' | 'waived' | 'no-checks';

export interface PracticeOutcome {
  id: string;
  handle: string;
  version: number;
  title: string;
  strength: ApprovedPractice['strength'];
  result: PracticeResult;
  /** Failed, required, and not waived: this is what stops the run. */
  blocks: boolean;
  files: string[];
  messages: string[];
  checks: Array<{ check: string; pass: boolean; files: string[]; message?: string }>;
  reviewer?: { pass: boolean; note?: string };
  waiver?: { reason?: string; at: string };
  waiveUrl: string;
}

/** The runs whose waivers count for this one: this run, then the runs it retried. */
export function waiverChain(executionId: string): string[] {
  const chain = [executionId];
  let current = store.getExecution(executionId);
  while (current?.retryOf && chain.length < MAX_CHAIN && !chain.includes(current.retryOf)) {
    chain.push(current.retryOf);
    current = store.getExecution(current.retryOf);
  }
  return chain;
}

/** Whether a run's failed step shows this very failure line: the waiver was for what the approver saw, not for other files. */
export function failedWith(executionId: string, line: string): boolean {
  const runData = store.getExecution(executionId)?.runData ?? {};
  return Object.values(runData).some((runs) =>
    (runs ?? []).some((r) => {
      const error = (r as { error?: { message?: string; description?: string } }).error;
      return Boolean(error?.message?.startsWith('Required practices failed')) && String(error?.description ?? '').split('\n').includes(line);
    }),
  );
}

/**
 * What a blocked practice failed, in one line, as the waive page shows it from the failed step. The display lists at most
 * ten files; the trailing key is a hash of the whole failure (every file and message), so a waiver matched on this line
 * holds only for the same files, however many there are.
 */
export const failureLine = (o: Pick<PracticeOutcome, 'handle' | 'version' | 'files' | 'messages'>): string => {
  const key = createHash('sha256').update(JSON.stringify([o.handle, o.version, o.messages, [...o.files].sort()])).digest('hex').slice(0, 12);
  return `${o.handle}@${o.version}: ${o.messages.join('; ') || 'failed'}${o.files.length ? ` (${o.files.slice(0, 10).join(', ')}${o.files.length > 10 ? `, and ${o.files.length - 10} more` : ''})` : ''} [${key}]`;
};

export const waiveUrlOf = (practiceId: string, executionId: string): string => `/practices/waive?practice=${encodeURIComponent(practiceId)}&execution=${encodeURIComponent(executionId)}`;

/** One practice against a change. Pure but for `waiverOf`. */
export function judge(
  practice: ApprovedPractice,
  change: PracticeChange,
  verdict: Verdict | undefined,
  options: { reviewerFailsBlock: boolean; executionId: string; waiverOf: (practiceId: string, line: string) => { reason?: string; at: string } | undefined },
): PracticeOutcome {
  const results: PracticeCheckResult[] = practice.checks.length ? runPracticeChecks(practice.checks, change) : [];
  const machineFail = results.some((r) => !r.pass);
  const reviewerFail = verdict ? !verdict.pass : false;
  const judged = results.length > 0 || verdict !== undefined;
  const failed = machineFail || reviewerFail;
  const blocking = practice.strength === 'required' && (machineFail || (reviewerFail && options.reviewerFailsBlock));
  const messages = [
    ...results.filter((r) => !r.pass).map((r) => `${practiceCheckLabel(r.check)}: ${r.message ?? 'failed'}`),
    ...(reviewerFail ? [`Reviewer: ${verdict?.note ?? 'failed'}`] : []),
  ];
  const failedFiles = [...new Set(results.flatMap((r) => (r.pass ? [] : r.files)))];
  // A waiver holds for the failure the approver saw (the line the waive page shows), not for any failure of the practice.
  const waiver = failed && blocking ? options.waiverOf(practice.id, failureLine({ handle: practice.handle, version: practice.version, files: failedFiles, messages })) : undefined;
  const result: PracticeResult = !judged ? 'no-checks' : waiver ? 'waived' : failed ? 'fail' : 'pass';
  return {
    id: practice.id,
    handle: practice.handle,
    version: practice.version,
    title: practice.title,
    strength: practice.strength,
    result,
    blocks: blocking && !waiver,
    files: failedFiles,
    messages,
    checks: results.map((r) => ({ check: practiceCheckLabel(r.check), pass: r.pass, files: r.files, ...(r.message && { message: r.message }) })),
    ...(verdict && { reviewer: { pass: verdict.pass, ...(verdict.note && { note: verdict.note }) } }),
    ...(waiver && { waiver }),
    waiveUrl: waiveUrlOf(practice.id, options.executionId),
  };
}

const listOf = (value: unknown): string[] =>
  String(value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

function workflowProject(workflowId: string | undefined): string | undefined {
  if (!workflowId) return undefined;
  if (workflowId.startsWith('agent:')) return homeProjectId('agent', workflowId.slice('agent:'.length));
  return store.getWorkflow(workflowId) ? homeProjectId('workflow', workflowId) : undefined;
}

export const practiceCheckNode = defineNode({
  description: {
    name: 'practiceCheck',
    displayName: 'Check Practices',
    description: 'Check a change against the practices that apply. A required practice that fails stops the run until it is fixed or a person waives it.',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:shield-check',
    color: '#0ea5e9',
    subtitle: '{{repository}}',
    keywords: ['practice', 'rule', 'standard', 'check', 'policy', 'pull request', 'review', 'waive', 'brain'],
    inputs: main,
    outputs: main,
    properties: [
      { name: 'repository', displayName: 'Repository', type: 'string', default: '', placeholder: 'your-org/your-repo', description: 'owner/name. Narrows to practices that list it or list none. Empty: practices that list no repository.' },
      { name: 'changedFiles', displayName: 'Changed Files', type: 'json', default: '[]', required: true, description: 'An expression giving a list of { path, status: "A" | "M" | "D", added?: ["added line", …] }' },
      { name: 'verdicts', displayName: 'Reviewer Verdicts', type: 'json', default: '', description: 'Optional. An expression giving a list of { handle, pass, note? }, from a model or a person. A practice with no machine check is judged only by this.' },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'reviewerFailsBlock', displayName: 'Reviewer fails block', type: 'boolean', default: false, description: 'A reviewer’s fail of a required practice stops the run. Off: it only warns. A machine check that fails always stops the run.' },
          { name: 'changeUrl', displayName: 'Link to the change', type: 'string', default: '', placeholder: 'https://github.com/your-org/your-repo/pull/12', description: 'Where the change is (a pull request). Shown in the failure, so the person who sees it can open the change to fix it.' },
          { name: 'practices', displayName: 'Practices', type: 'string', default: '', placeholder: 'helm/chart-location, docs/readme', description: 'Handles to check, comma-separated. Empty: every practice that applies.' },
        ],
      },
    ],
  },
  async execute(ctx: IExecuteContext) {
    const fail = (message: string, description?: string) => new NodeOperationError(message, { itemIndex: 0, ...(description && { description }) });
    const repo = String(ctx.getNodeParameter('repository', 0, '') ?? '').trim();
    if (repo && !PRACTICE_REPO.test(repo)) throw fail(`Repository must look like owner/name, got “${repo}”`);
    let changed: ReturnType<typeof changeOf>;
    let verdicts: Verdict[];
    try {
      changed = changeOf(ctx.getNodeParameter('changedFiles', 0, '[]'));
      verdicts = verdictsOf(ctx.getNodeParameter('verdicts', 0, ''));
    } catch (caught) {
      throw fail((caught as Error).message);
    }
    const opts = (ctx.getNodeParameter('options', 0, {}) ?? {}) as { reviewerFailsBlock?: boolean; practices?: string; changeUrl?: string };
    const only = listOf(opts.practices);
    const executionId = ctx.getExecutionId() ?? '';
    const workflowId = ctx.getWorkflowId();
    const port = practicesPort();
    const projectId = workflowProject(workflowId);
    const enabled = Boolean(port?.enabled());
    const approved = enabled && port ? port.approved({ projectIds: projectId ? [projectId] : [] }) : [];
    const chosen = selectPractices(approved, { ...(repo && { repo }), paths: changed.files.map((f) => f.path) }).filter((p) => !only.length || only.includes(p.handle));
    // A practice with a path scope that no changed path matches was left out by the selector; one with none applies to any change.
    const chain = executionId ? waiverChain(executionId) : [];
    const waiverOf = (practiceId: string, line: string) => {
      for (const id of chain) {
        const found = findWaiver(practiceId, id);
        if (found && failedWith(id, line)) return { ...(found.reason && { reason: found.reason }), at: found.at };
      }
      return undefined;
    };
    if (!enabled) ctx.check({ name: 'practices:off', status: 'warn', message: 'Practices are switched off, so nothing was checked' });
    else if (!port) ctx.check({ name: 'practices:unavailable', status: 'warn', message: 'No practices source is connected, so nothing was checked' });
    for (const h of only) if (!approved.some((p) => p.handle === h)) ctx.check({ name: `practice:${h}`, status: 'warn', message: `No approved practice “${h}” applies here (check the handle), so it was not checked`, subject: h });
    const outcomes = chosen.map((p) =>
      judge(p, changed.change, verdicts.find((v) => v.handle === p.handle), { reviewerFailsBlock: opts.reviewerFailsBlock === true, executionId, waiverOf }),
    );
    for (const o of outcomes) {
      const subject = `${o.handle}@${o.version}`;
      const evidence = { strength: o.strength, files: o.files, checks: o.checks, ...(o.reviewer && { reviewer: o.reviewer }) } as unknown as JsonObject;
      if (o.result === 'no-checks') ctx.check({ name: `practice:${subject}`, status: 'skip', message: 'No machine check and no verdict: a person judges it', subject, evidence });
      else if (o.result === 'pass') ctx.check({ name: `practice:${subject}`, status: 'pass', subject, evidence });
      else if (o.result === 'waived') ctx.check({ name: `practice:${subject}`, status: 'warn', message: `Waived for this run${o.waiver?.reason ? `: ${o.waiver.reason}` : ''}`, subject, evidence });
      else ctx.check({ name: `practice:${subject}`, status: o.blocks ? 'fail' : 'warn', message: o.messages.join('; ') || 'Failed', subject, evidence });
      if (o.result === 'pass' || o.result === 'fail' || o.result === 'waived') {
        port?.record({
          practiceId: o.id,
          version: o.version,
          kind: o.result === 'pass' ? 'check-pass' : 'check-fail',
          ...(executionId && { executionId }),
          ...(repo && { repo }),
          ...(o.result === 'waived' && { reason: 'waived for this run' }),
        });
      }
    }
    const blocked = outcomes.filter((o) => o.blocks);
    const summary: JsonObject = {
      ok: !blocked.length,
      ...(repo && { repository: repo }),
      changed: changed.files.length,
      practicesOn: enabled,
      checked: outcomes.length,
      ...(String(opts.changeUrl ?? '').trim() && { changeUrl: String(opts.changeUrl).trim() }),
      failed: blocked.map((o) => o.handle),
      warned: outcomes.filter((o) => o.result === 'fail' && !o.blocks).map((o) => o.handle),
      waived: outcomes.filter((o) => o.result === 'waived').map((o) => o.handle),
      practices: outcomes as unknown as JsonObject[],
    };
    if (blocked.length) {
      const names = blocked.map((o) => o.handle).join(', ');
      const change = String(opts.changeUrl ?? '').trim();
      throw fail(`Required practices failed: ${names}. Fix the change and run the flow again, or waive ${blocked.length === 1 ? 'it' : 'them'} for this run.${change ? ` Change: ${change}` : ''} Waive: ${blocked.map((o) => `${publicUrl()}${o.waiveUrl}`).join(' ')}`, blocked.map(failureLine).join('\n'));
    }
    return [[{ json: summary, pairedItem: { item: 0 } } as NodeItem]];
  },
});
