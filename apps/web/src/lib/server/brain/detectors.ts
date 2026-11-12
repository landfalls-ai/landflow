/**
 * The detectors (docs/second-brain.md#4-detectors-and-suggestions): queries over the usage ledger and the workflows'
 * definitions, with thresholds. Each finding comes out as a suggestion with deterministic text, evidence and, where the
 * change is mechanical (retries, a schedule, an error workflow, a smaller model), its edit operations. Findings that
 * need judgment carry an `enrich` hint the writer (./writer.ts) hands to the model: a fix for a failing node, tips for a
 * slow one, a persona rule from comments, a draft workflow for an unmet request.
 *
 * Thresholds are multiplied by the detector's `quiet` factor (proposals.detectorStats): a detector people mostly dismiss
 * as wrong needs more evidence before it speaks again.
 */
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { missingSystem } from '../../shared/agent-architect';
import type { AssistantOp } from '../../shared/assistant-ops';
import type { BuiltinDetectorId, DetectorId, ProposalEvidence, ProposalRisk } from '../../shared/brain';
import { agentStore } from '../agents/store';
import { DEFAULT_PRICES, priceOverrides } from '../ai-usage/prices';
import { credentials } from '../credentials/vault';
import { database, type Database, type SqlValue } from '../db';
import { homeProjectId } from '../projects/store';
import { searchTerms } from '../rag/search';
import { instanceTimezone } from '../settings';
import { store } from '../store';
import { percentile } from '../usage/query';
import type { NewProposal } from './proposals';
import { fingerprintOf } from './proposals';

const DAY_MS = 86_400_000;
const PRODUCTION = "COALESCE(json_extract(attrs, '$.mode'), '') <> 'manual'";
const FLAKY = /time(d)? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|\b429\b|rate.?limit|too many requests|\b50[234]\b|temporar|unavailable|network error|fetch failed/i;

export const SCHEDULE = 'core.schedule';
export const MANUAL_TRIGGER = 'core.manualTrigger';
export const ERROR_TRIGGER = 'core.errorTrigger';
export const EXECUTE_WORKFLOW = 'core.executeWorkflow';
export const WORKFLOW_TRIGGER = 'core.workflowTrigger';
export const STOP_AND_ERROR = 'core.stopAndError';

/** What the writer may add with the model. */
export type Enrichment =
  | { kind: 'fix'; workflowId: string; nodeId: string; executionId?: string; message: string }
  | { kind: 'slow'; workflowId: string; nodeId: string }
  | { kind: 'persona'; agentId: string; comments: string[] }
  | { kind: 'draft'; prompt: string }
  | { kind: 'tool'; system: string; capabilities: string[] };

export interface Finding {
  proposal: NewProposal;
  enrich?: Enrichment;
}

export interface DetectContext {
  db: Database;
  now: number;
  /** Threshold multiplier per detector (1 = normal). */
  quiet: (id: DetectorId) => number;
  workflows: Workflow[];
}

const execHref = (workflowId: string, executionId?: string) => (executionId ? `/workflows/${workflowId}/executions/${executionId}` : `/workflows/${workflowId}`);
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));

function base(detector: DetectorId, fingerprint: string, target: NewProposal['target'], fields: { title: string; why: string; evidence: ProposalEvidence[]; effect?: string; ops?: AssistantOp[]; risk: ProposalRisk; confidence: number; impact: number; draft?: Workflow }): NewProposal {
  const projectId = target.type === 'workflow' && target.id ? homeProjectId('workflow', target.id) : target.type === 'agent' && target.id ? homeProjectId('agent', target.id) : undefined;
  return {
    source: 'detector',
    detector,
    fingerprint: fingerprintOf(detector, fingerprint),
    ...(projectId && { projectId }),
    target,
    title: fields.title,
    why: fields.why,
    evidence: fields.evidence,
    ...(fields.effect && { effect: fields.effect }),
    ops: fields.ops ?? [],
    ...(fields.draft && { draft: fields.draft }),
    risk: fields.risk,
    confidence: clamp(fields.confidence),
    score: Math.round(fields.impact * clamp(fields.confidence) * 100) / 100,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

function count(db: Database, where: string, ...params: SqlValue[]): number {
  return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM usage_events WHERE ${where}`, ...params)?.n ?? 0);
}

function productionRuns(ctx: DetectContext, workflowId: string, days = 7): { runs: number; failed: number } {
  const since = iso(ctx.now - days * DAY_MS);
  return {
    runs: count(ctx.db, `kind = 'run.finished' AND workflow_id = ? AND at >= ? AND ${PRODUCTION}`, workflowId, since),
    failed: count(ctx.db, `kind = 'run.finished' AND workflow_id = ? AND at >= ? AND ${PRODUCTION} AND json_extract(attrs, '$.status') = 'error'`, workflowId, since),
  };
}

const target = (workflow: Workflow, node?: WorkflowNode): NewProposal['target'] => ({ type: 'workflow', id: workflow.id, name: workflow.name, ...(node && { nodeId: node.id, nodeName: node.name }) });

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

interface FailGroup {
  workflow_id: string;
  node_id: string;
  node_type: string | null;
  signature: string | null;
  n: number;
  days: number;
}

function failureGroups(ctx: DetectContext, days: number): FailGroup[] {
  return ctx.db.all<FailGroup>(
    `SELECT workflow_id, node_id, MAX(node_type) AS node_type, signature, COUNT(*) AS n, COUNT(DISTINCT day) AS days FROM usage_events
     WHERE kind = 'node.failed' AND at >= ? AND workflow_id IS NOT NULL AND node_id IS NOT NULL AND ${PRODUCTION}
     GROUP BY workflow_id, node_id, signature ORDER BY n DESC`,
    iso(ctx.now - days * DAY_MS),
  );
}

function latestFailure(ctx: DetectContext, g: FailGroup): { message?: string; executionId?: string; at?: string } {
  const row = ctx.db.get<{ message: string | null; execution_id: string | null; at: string }>(
    `SELECT message, execution_id, at FROM usage_events WHERE kind = 'node.failed' AND workflow_id = ? AND node_id = ? AND COALESCE(signature, '') = ? ORDER BY at DESC LIMIT 1`,
    g.workflow_id,
    g.node_id,
    g.signature ?? '',
  );
  return { ...(row?.message && { message: row.message }), ...(row?.execution_id && { executionId: row.execution_id }), ...(row?.at && { at: row.at }) };
}

/** One signature failing often on one node (not the flaky kind: see flakyCalls). */
export function failureHotSpots(ctx: DetectContext): Finding[] {
  const min = Math.ceil(5 * ctx.quiet('failure-hot-spot'));
  const out: Finding[] = [];
  for (const g of failureGroups(ctx, 7)) {
    if (g.n < min) continue;
    const workflow = ctx.workflows.find((w) => w.id === g.workflow_id);
    const node = workflow?.nodes.find((n) => n.id === g.node_id);
    if (!workflow || !node) continue;
    const last = latestFailure(ctx, g);
    if (last.message && FLAKY.test(last.message)) continue;
    const { runs } = productionRuns(ctx, workflow.id);
    const share = runs ? Math.min(1, g.n / runs) : 1;
    // A Stop and Error fails on purpose: nothing to fix in the node, only where the rejected items go.
    if (node.type === STOP_AND_ERROR) {
      out.push({
        proposal: base('failure-hot-spot', `${workflow.id}|${node.id}|${g.signature ?? ''}`, target(workflow, node), {
          title: `“${node.name}” stops ${g.n} runs a week in “${workflow.name}”`,
          why: `“${node.name}” is a Stop and Error: it failed ${g.n} runs in the last 7 days${runs ? ` (${pct(share)} of production runs)` : ''} on purpose, with “${last.message ?? 'an error'}”. If these rejections are expected, send the rejected items somewhere people look (a data table, a message) instead of failing the run, so they don’t count as failures; if they are, dismiss this as intended.`,
          evidence: [
            { label: 'Stopped runs this week', value: g.n },
            ...(runs ? [{ label: 'Production runs', value: runs }] : []),
            { label: 'Latest', value: last.at?.slice(0, 16).replace('T', ' ') ?? '', href: execHref(workflow.id, last.executionId) },
          ],
          effect: `${g.n} fewer failed runs a week, with the rejections still visible`,
          risk: 'low',
          confidence: 0.45,
          impact: g.n / 2,
        }),
      });
      continue;
    }
    out.push({
      proposal: base('failure-hot-spot', `${workflow.id}|${node.id}|${g.signature ?? ''}`, target(workflow, node), {
        title: `“${node.name}” in “${workflow.name}” keeps failing`,
        why: `It failed ${g.n} times in the last 7 days, on ${g.days} day${g.days === 1 ? '' : 's'}${runs ? ` (${pct(share)} of production runs)` : ''}, with: “${last.message ?? 'an error'}”.`,
        evidence: [
          { label: 'Failures this week', value: g.n },
          ...(runs ? [{ label: 'Production runs', value: runs }] : []),
          { label: 'Latest failure', value: last.at?.slice(0, 16).replace('T', ' ') ?? '', href: execHref(workflow.id, last.executionId) },
          ...(g.signature ? [{ label: 'Signature', value: g.signature }] : []),
        ],
        effect: `Up to ${g.n} fewer failed runs a week`,
        risk: 'medium',
        confidence: 0.5 + Math.min(0.45, g.n / 40),
        impact: g.n,
      }),
      enrich: { kind: 'fix', workflowId: workflow.id, nodeId: node.id, executionId: last.executionId, message: last.message ?? '' },
    });
  }
  return out;
}

/** Intermittent timeouts and 5xx on one node that otherwise works: retries with backoff. */
export function flakyCalls(ctx: DetectContext): Finding[] {
  const min = Math.ceil(3 * ctx.quiet('flaky-call'));
  const rows = ctx.db.all<{ workflow_id: string; node_id: string; message: string | null; execution_id: string | null }>(
    `SELECT workflow_id, node_id, message, execution_id FROM usage_events WHERE kind = 'node.failed' AND at >= ? AND workflow_id IS NOT NULL AND node_id IS NOT NULL AND ${PRODUCTION}`,
    iso(ctx.now - 7 * DAY_MS),
  );
  const groups = new Map<string, { workflowId: string; nodeId: string; n: number; message: string; executionId?: string }>();
  for (const r of rows) {
    if (!r.message || !FLAKY.test(r.message)) continue;
    const key = `${r.workflow_id}|${r.node_id}`;
    const g = groups.get(key) ?? { workflowId: r.workflow_id, nodeId: r.node_id, n: 0, message: r.message };
    g.n++;
    if (r.execution_id) g.executionId = r.execution_id;
    groups.set(key, g);
  }
  const out: Finding[] = [];
  for (const g of groups.values()) {
    if (g.n < min) continue;
    const workflow = ctx.workflows.find((w) => w.id === g.workflowId);
    const node = workflow?.nodes.find((n) => n.id === g.nodeId);
    if (!workflow || !node || node.retryOnFail) continue;
    const { runs, failed } = productionRuns(ctx, workflow.id);
    // Intermittent: most runs still succeed.
    if (runs && failed / runs > 0.5) continue;
    out.push({
      proposal: base('flaky-call', `${workflow.id}|${node.id}`, target(workflow, node), {
        title: `Retry “${node.name}” when it times out`,
        why: `“${node.name}” failed ${g.n} times this week with errors that usually pass on a second try (“${g.message}”), while ${runs - failed} of ${runs} production runs succeeded. It has no retries.`,
        evidence: [
          { label: 'Transient failures this week', value: g.n },
          { label: 'Successful production runs', value: runs - failed },
          { label: 'Latest', value: g.message.slice(0, 80), href: execHref(workflow.id, g.executionId) },
        ],
        effect: `Most of the ${g.n} failures a week should pass on a retry`,
        ops: [{ op: 'setNodeSettings', node: node.name, settings: { retryOnFail: true, maxTries: 3, waitBetweenTriesMs: 5_000 } }],
        risk: 'low',
        confidence: 0.75,
        impact: g.n * 1.2,
      }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Speed and cost
// ---------------------------------------------------------------------------

/** A node that is slow often, or slower than the week before. */
export function slowSteps(ctx: DetectContext): Finding[] {
  const min = Math.ceil(5 * ctx.quiet('slow-step'));
  const since = iso(ctx.now - 7 * DAY_MS);
  const rows = ctx.db.all<{ workflow_id: string; node_id: string; n: number }>(
    `SELECT workflow_id, node_id, COUNT(*) AS n FROM usage_events WHERE kind = 'node.slow' AND at >= ? AND workflow_id IS NOT NULL AND ${PRODUCTION} GROUP BY workflow_id, node_id HAVING n >= ? ORDER BY n DESC`,
    since,
    min,
  );
  const out: Finding[] = [];
  for (const r of rows) {
    const workflow = ctx.workflows.find((w) => w.id === r.workflow_id);
    const node = workflow?.nodes.find((n) => n.id === r.node_id);
    if (!workflow || !node) continue;
    const where = `kind = 'node.slow' AND workflow_id = ? AND node_id = ? AND ${PRODUCTION} AND at >= ? AND at < ?`;
    const p95 = percentile(where, [workflow.id, node.id, since, iso(ctx.now)], 0.95, ctx.db);
    const before = percentile(where, [workflow.id, node.id, iso(ctx.now - 14 * DAY_MS), since], 0.95, ctx.db);
    if (p95 < 5_000 && !(before && p95 > before * 1.5)) continue;
    const trend = before ? `, ${p95 > before ? 'up' : 'down'} from ${seconds(before)} the week before` : '';
    out.push({
      proposal: base('slow-step', `${workflow.id}|${node.id}`, target(workflow, node), {
        title: `“${node.name}” is the slow step of “${workflow.name}”`,
        why: `It took ${seconds(p95)} at p95 over ${r.n} slow runs this week${trend}. ${slowTip(node.type)}`,
        evidence: [
          { label: 'Slow runs this week', value: r.n },
          { label: 'p95', value: seconds(p95) },
          ...(before ? [{ label: 'p95 the week before', value: seconds(before) }] : []),
        ],
        effect: 'Shorter runs, and less waiting for whatever comes after',
        risk: 'low',
        confidence: 0.6,
        impact: r.n * Math.min(3, p95 / 5_000),
      }),
      enrich: { kind: 'slow', workflowId: workflow.id, nodeId: node.id },
    });
  }
  return out;
}

function slowTip(type: string): string {
  if (/http|request|api/i.test(type)) return 'Page through results, send the items in batches, or cache answers that rarely change.';
  if (/openai|anthropic|ollama|chat|agent|llm|chain/i.test(type)) return 'A shorter prompt or a smaller model often answers as well, faster.';
  if (/postgres|mysql|sql|mongo|redis|database/i.test(type)) return 'Limit the rows it reads, or add an index for its query.';
  return 'Split the items into batches (Loop Over Items), or run the slow part only when it is needed.';
}

/** Smaller models of the same provider, tried in order. */
const SMALLER: Record<string, string[]> = { anthropic: ['claude-haiku-5-5', 'claude-haiku-4-5'], openai: ['gpt-5-mini', 'gpt-5-nano', 'gpt-4.1-mini'] };

function priceOf(provider: string, model: string) {
  const all = [...priceOverrides(), ...DEFAULT_PRICES].filter((p) => p.provider === provider);
  return all.find((p) => p.model === model) ?? all.filter((p) => model.startsWith(p.model)).sort((a, b) => b.model.length - a.model.length)[0];
}

/** A large model on short, frequent answers: try a smaller one (after the workflow's evaluations). */
export function aiCost(ctx: DetectContext): Finding[] {
  const min = Math.ceil(20 * ctx.quiet('ai-cost'));
  const rows = ctx.db.all<{ workflow_id: string; provider: string; model: string; n: number; cost: number; output: number }>(
    `SELECT workflow_id, json_extract(attrs, '$.provider') AS provider, json_extract(attrs, '$.model') AS model, COUNT(*) AS n, SUM(cost) AS cost,
       COALESCE(SUM(json_extract(attrs, '$.output')), 0) AS output
     FROM usage_events WHERE kind = 'ai.call' AND at >= ? AND workflow_id IS NOT NULL AND cost > 0 AND json_extract(attrs, '$.operation') <> 'embeddings'
     GROUP BY workflow_id, provider, model HAVING n >= ? ORDER BY cost DESC`,
    iso(ctx.now - 7 * DAY_MS),
    min,
  );
  const out: Finding[] = [];
  for (const r of rows) {
    const avgOutput = r.output / r.n;
    if (avgOutput > 400) continue;
    const current = priceOf(r.provider, r.model);
    const smaller = (SMALLER[r.provider] ?? []).map((m) => ({ model: m, price: priceOf(r.provider, m) })).find((s) => s.price && current && s.model !== r.model && s.price.input + s.price.output < (current.input + current.output) * 0.5);
    if (!smaller?.price || !current) continue;
    const workflow = ctx.workflows.find((w) => w.id === r.workflow_id);
    if (!workflow) continue;
    const nodes = workflow.nodes.filter((n) => n.parameters?.model === r.model);
    const ratio = (smaller.price.input + smaller.price.output) / (current.input + current.output);
    const saving = r.cost * (1 - ratio);
    const cases = Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM evaluation_cases WHERE workflow_id = ?', workflow.id)?.n ?? 0);
    out.push({
      proposal: base('ai-cost', `${workflow.id}|${r.model}`, target(workflow, nodes[0]), {
        title: `Try ${smaller.model} instead of ${r.model} in “${workflow.name}”`,
        why: `${r.n} calls to ${r.model} this week cost $${r.cost.toFixed(2)}, and the answers are short (${Math.round(avgOutput)} output tokens on average). ${smaller.model} costs about ${Math.round(ratio * 100)}% as much. ${cases ? `Run the workflow’s ${cases} evaluation cases with ${smaller.model} before you switch.` : 'Add a few evaluation cases first, so you can check the answers stay good.'}`,
        evidence: [
          { label: 'Calls this week', value: r.n },
          { label: 'Cost this week', value: `$${r.cost.toFixed(2)}` },
          { label: 'Average output tokens', value: Math.round(avgOutput) },
          { label: 'Evaluation cases', value: cases },
        ],
        effect: `About $${saving.toFixed(2)} less a week`,
        ops: nodes.map((n) => ({ op: 'setParameters' as const, node: n.name, parameters: { model: smaller.model } })),
        risk: 'medium',
        confidence: cases ? 0.7 : 0.55,
        impact: Math.max(1, saving * 20),
      }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// How people work
// ---------------------------------------------------------------------------

function hourIn(ms: number): number {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: instanceTimezone(), hour: '2-digit', hourCycle: 'h23' }).format(ms));
  } catch {
    return new Date(ms).getUTCHours();
  }
}

/** A workflow run by hand on most days, on days nobody edited it: a schedule would do it. */
export function handRunRhythm(ctx: DetectContext): Finding[] {
  const minDays = Math.ceil(4 * ctx.quiet('hand-run-rhythm'));
  const since = iso(ctx.now - 21 * DAY_MS);
  const runs = ctx.db.all<{ workflow_id: string; day: string; at: string }>(
    `SELECT workflow_id, day, at FROM usage_events WHERE kind = 'run.finished' AND at >= ? AND workflow_id IS NOT NULL AND json_extract(attrs, '$.mode') = 'manual' AND COALESCE(json_extract(attrs, '$.sub'), 0) = 0`,
    since,
  );
  const saves = ctx.db.all<{ workflow_id: string; day: string }>("SELECT DISTINCT workflow_id, day FROM usage_events WHERE kind = 'workflow.saved' AND at >= ?", since);
  const edited = new Set(saves.map((s) => `${s.workflow_id}|${s.day}`));
  const byWorkflow = new Map<string, Map<string, number>>();
  for (const r of runs) {
    if (edited.has(`${r.workflow_id}|${r.day}`)) continue;
    const days = byWorkflow.get(r.workflow_id) ?? new Map<string, number>();
    if (!days.has(r.day)) days.set(r.day, Date.parse(r.at));
    byWorkflow.set(r.workflow_id, days);
  }
  const out: Finding[] = [];
  for (const [workflowId, days] of byWorkflow) {
    if (days.size < minDays) continue;
    const workflow = ctx.workflows.find((w) => w.id === workflowId);
    if (!workflow || workflow.nodes.some((n) => n.type === SCHEDULE)) continue;
    const manual = workflow.nodes.find((n) => n.type === MANUAL_TRIGGER);
    if (!manual) continue;
    const hours = [...days.values()].map(hourIn).sort((a, b) => a - b);
    const hour = hours[Math.floor(hours.length / 2)];
    const spread = Math.max(...hours) - Math.min(...hours);
    const targets = workflow.connections.filter((c) => c.type === 'main' && c.source === manual.id).map((c) => workflow.nodes.find((n) => n.id === c.target)?.name).filter(Boolean) as string[];
    if (!targets.length) continue;
    const name = `Every day at ${String(hour).padStart(2, '0')}:00`;
    out.push({
      proposal: base('hand-run-rhythm', workflow.id, target(workflow, manual), {
        title: `Run “${workflow.name}” on a schedule`,
        why: `Someone ran it by hand on ${days.size} of the last 21 days, on days nobody edited it${spread <= 3 ? `, usually around ${String(hour).padStart(2, '0')}:00` : ''}. A schedule would run it without anyone remembering to. Publish the workflow for the schedule to start.`,
        evidence: [
          { label: 'Days run by hand (21 days)', value: days.size },
          { label: 'Typical hour', value: `${String(hour).padStart(2, '0')}:00` },
        ],
        effect: `About ${Math.round((days.size / 3) * 10) / 10} fewer runs by hand a week`,
        ops: [
          { op: 'addNode', ref: 'schedule', type: SCHEDULE, name, parameters: { unit: 'rules', rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: hour, triggerAtMinute: 0 }] } } },
          ...targets.map((to) => ({ op: 'connect' as const, from: 'schedule', to })),
        ],
        risk: 'low',
        confidence: spread <= 3 ? 0.75 : 0.55,
        impact: days.size,
      }),
    });
  }
  return out;
}

/** Two workflows run by hand one after the other by the same person, on several days: one workflow could run both. */
export function repeatedSequences(ctx: DetectContext): Finding[] {
  const minDays = Math.ceil(3 * ctx.quiet('repeated-sequence'));
  const rows = ctx.db.all<{ workflow_id: string; actor_id: string | null; day: string; at: string }>(
    `SELECT workflow_id, actor_id, day, at FROM usage_events
     WHERE kind = 'run.finished' AND at >= ? AND workflow_id IS NOT NULL AND json_extract(attrs, '$.mode') = 'manual' AND COALESCE(json_extract(attrs, '$.sub'), 0) = 0 ORDER BY at`,
    iso(ctx.now - 21 * DAY_MS),
  );
  // Pairs by the same person when runs say who started them, else across the instance.
  const pairs = new Map<string, Set<string>>();
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const gap = Date.parse(rows[j].at) - Date.parse(rows[i].at);
      if (gap > 30 * 60_000) break;
      if (rows[j].workflow_id === rows[i].workflow_id || (rows[i].actor_id && rows[j].actor_id && rows[i].actor_id !== rows[j].actor_id)) continue;
      const key = `${rows[i].workflow_id}>${rows[j].workflow_id}`;
      const days = pairs.get(key) ?? new Set<string>();
      days.add(rows[i].day);
      pairs.set(key, days);
    }
  }
  const out: Finding[] = [];
  for (const [key, days] of pairs) {
    if (days.size < minDays) continue;
    const [firstId, secondId] = key.split('>');
    const first = ctx.workflows.find((w) => w.id === firstId);
    const second = ctx.workflows.find((w) => w.id === secondId);
    if (!first || !second) continue;
    // Already chained: one calls the other.
    if ([first, second].some((w) => w.nodes.some((n) => n.type === EXECUTE_WORKFLOW && [firstId, secondId].includes(String(n.parameters?.workflowId ?? ''))))) continue;
    const draft: Workflow = {
      id: 'draft',
      name: `${first.name}, then ${second.name}`,
      active: false,
      nodes: [
        { id: 'start', name: 'Start', type: MANUAL_TRIGGER, typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'first', name: first.name.slice(0, 60), type: EXECUTE_WORKFLOW, typeVersion: 1, position: [280, 0], parameters: { workflowId: first.id, inputSource: 'passthrough' } },
        { id: 'second', name: second.name.slice(0, 60) === first.name.slice(0, 60) ? `${second.name.slice(0, 56)} (2)` : second.name.slice(0, 60), type: EXECUTE_WORKFLOW, typeVersion: 1, position: [560, 0], parameters: { workflowId: second.id, inputSource: 'passthrough' } },
      ],
      connections: [
        { id: 'c1', type: 'main', source: 'start', sourceIndex: 0, target: 'first', targetIndex: 0 },
        { id: 'c2', type: 'main', source: 'first', sourceIndex: 0, target: 'second', targetIndex: 0 },
      ],
    };
    out.push({
      proposal: base('repeated-sequence', key, { type: 'instance', name: draft.name }, {
        title: `Run “${first.name}” and “${second.name}” as one`,
        why: `On ${days.size} days in the last three weeks, “${second.name}” was run by hand within 30 minutes after “${first.name}”. A workflow that runs one, then the other, saves the second step (and the forgetting).`,
        evidence: [
          { label: 'Days with both, in order', value: days.size },
          { label: 'First', value: first.name, href: `/workflows/${first.id}` },
          { label: 'Then', value: second.name, href: `/workflows/${second.id}` },
        ],
        effect: 'One run instead of two',
        draft,
        risk: 'low',
        confidence: 0.6,
        impact: days.size,
      }),
    });
  }
  return out;
}

/** The main chain of node types three long, per workflow (each chain once per workflow). */
function trigrams(workflow: Workflow): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const nodes = new Map(workflow.nodes.filter((n) => !n.disabled).map((n) => [n.id, n]));
  const next = (id: string) => workflow.connections.filter((c) => c.type === 'main' && c.source === id).map((c) => c.target);
  const skip = (type: string) => /trigger|noOp|stickyNote|schedule$|webhook$/i.test(type);
  for (const a of nodes.values()) {
    if (skip(a.type)) continue;
    for (const bId of next(a.id)) {
      const b = nodes.get(bId);
      if (!b || skip(b.type)) continue;
      for (const cId of next(b.id)) {
        const c = nodes.get(cId);
        if (!c || skip(c.type)) continue;
        if (a.type === b.type && b.type === c.type) continue;
        const key = `${a.type}>${b.type}>${c.type}`;
        if (!out.has(key)) out.set(key, [a.id, b.id, c.id]);
      }
    }
  }
  return out;
}

/** The same chain of three node types in three or more workflows: a sub-workflow or a composite node. */
export function copyPaste(ctx: DetectContext): Finding[] {
  const min = Math.ceil(3 * ctx.quiet('copy-paste'));
  const seen = new Map<string, Array<{ workflow: Workflow; ids: string[] }>>();
  for (const workflow of ctx.workflows) {
    if (workflow.nodes.some((n) => n.type === WORKFLOW_TRIGGER)) continue;
    for (const [key, ids] of trigrams(workflow)) seen.set(key, [...(seen.get(key) ?? []), { workflow, ids }]);
  }
  const found = [...seen].filter(([, uses]) => uses.length >= min).sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  return found.map(([key, uses]) => {
    const [first] = uses;
    const parts = first.ids.map((id) => first.workflow.nodes.find((n) => n.id === id)!);
    const draft: Workflow = {
      id: 'draft',
      name: `Shared: ${parts.map((p) => p.name).join(' → ')}`.slice(0, 120),
      active: false,
      nodes: [
        { id: 'in', name: 'When Called by a Workflow', type: WORKFLOW_TRIGGER, typeVersion: 1, position: [0, 0], parameters: { inputSource: 'passthrough' } },
        ...parts.map((p, i) => ({ ...p, id: `n${i}`, position: [280 * (i + 1), 0] as [number, number] })),
      ],
      connections: [
        { id: 'c0', type: 'main', source: 'in', sourceIndex: 0, target: 'n0', targetIndex: 0 },
        { id: 'c1', type: 'main', source: 'n0', sourceIndex: 0, target: 'n1', targetIndex: 0 },
        { id: 'c2', type: 'main', source: 'n1', sourceIndex: 0, target: 'n2', targetIndex: 0 },
      ],
    };
    const names = parts.map((p) => p.name).join(' → ');
    return {
      proposal: base('copy-paste', key, { type: 'instance', name: names }, {
        title: `The same three steps are copied into ${uses.length} workflows`,
        why: `${uses.map((u) => `“${u.workflow.name}”`).join(', ')} each have the chain ${names}. Kept in one sub-workflow (or a composite node), a fix reaches all of them at once. Applying creates the sub-workflow from “${first.workflow.name}”’s copy; call it with Execute Workflow where the copies are.`,
        evidence: uses.slice(0, 8).map((u) => ({ label: 'Used in', value: u.workflow.name, href: `/workflows/${u.workflow.id}` })),
        effect: `One place to change instead of ${uses.length}`,
        draft,
        risk: 'low',
        confidence: 0.55,
        impact: uses.length,
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Hygiene
// ---------------------------------------------------------------------------

/** Published workflows nobody ran, credentials nobody used and agents nobody talked to, for 60 days. */
export function deadWeight(ctx: DetectContext): Finding[] {
  const days = Math.ceil(60 * ctx.quiet('dead-weight'));
  const cutoff = ctx.now - days * DAY_MS;
  const oldest = ctx.db.get<{ at: string | null }>('SELECT MIN(at) AS at FROM usage_events')?.at;
  const oldestDaily = ctx.db.get<{ day: string | null }>('SELECT MIN(day) AS day FROM usage_daily')?.day;
  const covered = [oldest, oldestDaily ? `${oldestDaily}T00:00:00Z` : null].filter(Boolean).some((t) => Date.parse(t!) <= cutoff);
  // The ledger has to look back far enough to say "nobody".
  if (!covered) return [];
  const since = new Date(cutoff).toISOString().slice(0, 10);
  const used = (kind: string, column: string) => new Set(ctx.db.all<{ id: string }>(`SELECT DISTINCT ${column} AS id FROM usage_daily WHERE kind = ? AND day >= ? AND ${column} <> ''`, kind, since).map((r) => r.id));
  const ran = used('run.finished', 'workflow_id');
  const out: Finding[] = [];
  for (const workflow of ctx.workflows) {
    if (!workflow.active || ran.has(workflow.id) || Date.parse(workflow.createdAt ?? '') > cutoff) continue;
    out.push({
      proposal: base('dead-weight', `workflow|${workflow.id}`, target(workflow), {
        title: `“${workflow.name}” hasn’t run in ${days} days`,
        why: `It is published but no run started in ${days} days. Unpublish it (or delete it) if it is no longer needed, so it stops counting toward limits and reviews.`,
        evidence: [{ label: 'Runs in the period', value: 0 }],
        effect: 'A shorter list to look after',
        risk: 'low',
        confidence: 0.6,
        impact: 1,
      }),
    });
  }
  const credentialRuns = new Set(ctx.db.all<{ id: string }>("SELECT DISTINCT json_extract(attrs, '$.credentialId') AS id FROM usage_events WHERE kind = 'credential.used' AND at >= ?", new Date(cutoff).toISOString()).map((r) => r.id));
  for (const credential of credentials.list()) {
    if (credentialRuns.has(credential.id) || Date.parse(credential.createdAt ?? '') > cutoff) continue;
    out.push({
      proposal: base('dead-weight', `credential|${credential.id}`, { type: 'credential', id: credential.id, name: credential.name }, {
        title: `Credential “${credential.name}” hasn’t been used in ${days} days`,
        why: `No run used it in ${days} days. Delete it if nothing needs it: an unused secret is still a secret to rotate and to leak.`,
        evidence: [{ label: 'Runs that used it', value: 0 }],
        risk: 'low',
        confidence: 0.6,
        impact: 1,
      }),
    });
  }
  const talked = used('agent.session', 'agent_id');
  for (const agent of agentStore.list()) {
    if (!agent.published || talked.has(agent.id) || Date.parse(agent.createdAt) > cutoff) continue;
    out.push({
      proposal: base('dead-weight', `agent|${agent.id}`, { type: 'agent', id: agent.id, name: agent.name }, {
        title: `Agent “${agent.name}” hasn’t run in ${days} days`,
        why: `It is published but had no session in ${days} days. Unpublish it if it is no longer needed.`,
        evidence: [{ label: 'Sessions in the period', value: 0 }],
        risk: 'low',
        confidence: 0.55,
        impact: 1,
      }),
    });
  }
  return out;
}

/** Thumbs down (or low online scores) on an agent: a persona rule from what people said. */
export function agentQuality(ctx: DetectContext): Finding[] {
  const min = Math.ceil(3 * ctx.quiet('agent-quality'));
  const since = iso(ctx.now - 14 * DAY_MS);
  const rows = ctx.db.all<{ agent_id: string; n: number; down: number }>(
    `SELECT agent_id, COUNT(*) AS n, SUM(CASE WHEN json_extract(attrs, '$.rating') = 'down' THEN 1 ELSE 0 END) AS down FROM usage_events
     WHERE kind = 'feedback' AND at >= ? AND agent_id IS NOT NULL GROUP BY agent_id`,
    since,
  );
  const out: Finding[] = [];
  for (const r of rows) {
    if (r.down < min || r.down / r.n < 0.3) continue;
    const agent = agentStore.get(r.agent_id);
    if (!agent) continue;
    const comments = ctx.db
      .all<{ message: string }>(`SELECT message FROM usage_events WHERE kind = 'feedback' AND agent_id = ? AND at >= ? AND json_extract(attrs, '$.rating') = 'down' AND message IS NOT NULL ORDER BY at DESC LIMIT 12`, agent.id, since)
      .map((c) => c.message);
    const scores = ctx.db.get<{ n: number; avg: number | null }>('SELECT COUNT(*) AS n, AVG(score) AS avg FROM online_eval_scores WHERE target = ? AND created_at >= ?', `agent:${agent.id}`, since);
    out.push({
      proposal: base('agent-quality', agent.id, { type: 'agent', id: agent.id, name: agent.name }, {
        title: `People are unhappy with “${agent.name}”’s answers`,
        why: `${r.down} of ${r.n} ratings in the last 14 days were thumbs down${comments.length ? `. What they said: ${comments.slice(0, 4).map((c) => `“${c}”`).join('; ')}` : ''}.${scores?.n ? ` Online evaluations scored it ${Number(scores.avg ?? 0).toFixed(2)} on average over ${scores.n} runs.` : ''}`,
        evidence: [
          { label: 'Thumbs down (14 days)', value: r.down },
          { label: 'Ratings', value: r.n },
          ...(scores?.n ? [{ label: 'Online evaluation average', value: Number(scores.avg ?? 0).toFixed(2) }] : []),
        ],
        effect: 'Fewer answers people mark as bad',
        risk: 'medium',
        confidence: 0.5 + Math.min(0.3, r.down / 30),
        impact: r.down * 1.5,
      }),
      ...(comments.length && { enrich: { kind: 'persona', agentId: agent.id, comments } }),
    });
  }
  return out;
}

const GENERIC = new Set(['workflow', 'workflows', 'node', 'nodes', 'add', 'make', 'create', 'want', 'please', 'can', 'use', 'get', 'send', 'data', 'need', 'help', 'build', 'new', 'flow', 'step', 'change', 'run', 'show', 'like', 'would', 'could', 'how', 'set']);

/** Spotlight asks that produced no change, and node searches that found nothing, about the same thing. */
export function unmetDemand(ctx: DetectContext): Finding[] {
  const min = Math.ceil(3 * ctx.quiet('unmet-demand'));
  const rows = ctx.db.all<{ kind: string; message: string; actor_id: string | null; day: string }>(
    `SELECT kind, message, actor_id, day FROM usage_events WHERE at >= ? AND message IS NOT NULL AND (kind = 'search.empty' OR (kind = 'spotlight.asked' AND COALESCE(json_extract(attrs, '$.proposals'), 0) = 0))`,
    iso(ctx.now - 30 * DAY_MS),
  );
  const byTerm = new Map<string, Array<(typeof rows)[number]>>();
  for (const r of rows) {
    for (const term of new Set(searchTerms(r.message).filter((t) => t.length > 2 && !GENERIC.has(t) && !/^\d+$/.test(t)))) byTerm.set(term, [...(byTerm.get(term) ?? []), r]);
  }
  const clusters = [...byTerm]
    .filter(([, list]) => list.length >= min && (new Set(list.map((l) => l.actor_id ?? '')).size >= 2 || new Set(list.map((l) => l.day)).size >= 2))
    .sort((a, b) => b[1].length - a[1].length);
  const out: Finding[] = [];
  const used = new Set<(typeof rows)[number]>();
  for (const [term, list] of clusters) {
    const fresh = list.filter((l) => !used.has(l));
    if (fresh.length < min || out.length >= 3) continue;
    fresh.forEach((l) => used.add(l));
    const examples = [...new Set(fresh.map((l) => l.message))].slice(0, 5);
    out.push({
      proposal: base('unmet-demand', term, { type: 'instance', name: term }, {
        title: `People keep asking for “${term}”`,
        why: `${fresh.length} requests in the last 30 days (Spotlight asks that changed nothing, and node searches that found nothing) mention “${term}”: ${examples.map((e) => `“${e}”`).join('; ')}. A template, a plugin or a ready workflow would answer them.`,
        evidence: [
          { label: 'Requests (30 days)', value: fresh.length },
          { label: 'People', value: new Set(fresh.map((l) => l.actor_id ?? '')).size },
          ...examples.slice(0, 3).map((e) => ({ label: 'Asked', value: e })),
        ],
        effect: 'Fewer dead ends when people build',
        risk: 'low',
        confidence: 0.5 + Math.min(0.3, fresh.length / 20),
        impact: fresh.length,
      }),
      enrich: { kind: 'draft', prompt: `Build a workflow for this request, which several people made: ${examples.join(' / ')}` },
    });
  }
  return out;
}

/**
 * What the Agent architect needed and no node online does (`tool.missing`, docs/agents.md#agent-architect): a tool to
 * build. Grouped by the app ("Grafana"), else by the first telling word of what was needed. One need is enough: the
 * architect only notes one after searching every plugin online.
 */
export function missingTools(ctx: DetectContext): Finding[] {
  const min = Math.ceil(ctx.quiet('missing-tool'));
  const rows = ctx.db.all<{ message: string; actor_id: string | null; day: string; system: string | null; agent: string | null }>(
    `SELECT message, actor_id, day, json_extract(attrs, '$.system') AS system, json_extract(attrs, '$.agent') AS agent FROM usage_events WHERE at >= ? AND kind = 'tool.missing' AND message IS NOT NULL`,
    iso(ctx.now - 30 * DAY_MS),
  );
  const groups = new Map<string, { name: string; rows: typeof rows }>();
  for (const r of rows) {
    const name = missingSystem(r.message, r.system) ?? searchTerms(r.message).find((t) => t.length > 2 && !GENERIC.has(t));
    if (!name) continue;
    // "Text Toolkit" and "TextToolkit" are one app.
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const group = groups.get(key) ?? { name, rows: [] };
    group.rows.push(r);
    groups.set(key, group);
  }
  const out: Finding[] = [];
  for (const [key, { name, rows: list }] of [...groups].sort((a, b) => b[1].rows.length - a[1].rows.length)) {
    // The same need from the same person on the same day (a conversation that re-proposes) counts once.
    const needs = new Set(list.map((r) => `${r.actor_id ?? ''}|${r.day}|${r.message.toLowerCase()}`)).size;
    if (needs < min || out.length >= 3) continue;
    const capabilities = [...new Set(list.map((r) => r.message))].slice(0, 5);
    const agents = [...new Set(list.flatMap((r) => r.agent ?? []))].slice(0, 3);
    out.push({
      proposal: base('missing-tool', key, { type: 'instance', name }, {
        title: `Build a tool for ${name}`,
        why: `The Agent architect needed a node to ${capabilities.map((c) => `“${c}”`).join('; ')}${agents.length ? ` for ${agents.map((a) => `“${a}”`).join(', ')}` : ''}, and none of the plugins online does it, so it was left out of the agent. A node plugin (TypeScript, Python or Go) would let agents and workflows do it.`,
        evidence: [
          { label: 'Needed (30 days)', value: needs },
          { label: 'People', value: new Set(list.map((r) => r.actor_id ?? '')).size },
          ...capabilities.slice(0, 3).map((c) => ({ label: 'Needed', value: c })),
          ...(agents.length ? [{ label: 'For agents', value: agents.join(', ') }] : []),
          { label: 'How to build one', value: 'Build a plugin', href: '/developers' },
        ],
        effect: `Agents can ${capabilities[0].charAt(0).toLowerCase()}${capabilities[0].slice(1)}`,
        risk: 'low',
        confidence: 0.5 + Math.min(0.3, needs / 10),
        impact: needs + 1,
      }),
      enrich: { kind: 'tool', system: name, capabilities },
    });
  }
  return out;
}

/** Production workflows that fail with nobody told: an error workflow. */
export function noSafetyNet(ctx: DetectContext): Finding[] {
  const min = Math.ceil(3 * ctx.quiet('no-safety-net'));
  const errorWorkflows = ctx.workflows.filter((w) => w.nodes.some((n) => n.type === ERROR_TRIGGER && !n.disabled));
  const handler = errorWorkflows.find((w) => w.active) ?? errorWorkflows[0];
  const failing: Array<{ workflow: Workflow; failed: number }> = [];
  for (const workflow of ctx.workflows) {
    if (!workflow.active || workflow.settings?.errorWorkflowId || workflow.nodes.some((n) => n.type === ERROR_TRIGGER)) continue;
    const { failed } = productionRuns(ctx, workflow.id, 14);
    if (failed >= min) failing.push({ workflow, failed });
  }
  if (!failing.length) return [];
  if (handler) {
    return failing.map(({ workflow, failed }) => ({
      proposal: base('no-safety-net', `${workflow.id}|${handler.id}`, target(workflow), {
        title: `Tell someone when “${workflow.name}” fails`,
        why: `It failed ${failed} times in production in the last 14 days and has no error workflow, so nobody hears about it unless they look. “${handler.name}” already handles failures for other workflows.`,
        evidence: [
          { label: 'Failed production runs (14 days)', value: failed },
          { label: 'Error workflow to use', value: handler.name, href: `/workflows/${handler.id}` },
        ],
        effect: 'Failures reach someone the moment they happen',
        ops: [{ op: 'setWorkflowSettings', settings: { errorWorkflowId: handler.id } }],
        risk: 'low',
        confidence: 0.8,
        impact: failed,
      }),
    }));
  }
  const draft: Workflow = {
    id: 'draft',
    name: 'Failure alerts',
    active: false,
    nodes: [
      { id: 'error', name: 'Error Trigger', type: ERROR_TRIGGER, typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: 'summary',
        name: 'Summary',
        type: 'core.set',
        typeVersion: 1,
        position: [280, 0],
        parameters: {
          mode: 'manual',
          includeOtherFields: false,
          fields: {
            values: [
              { name: 'workflow', type: 'string', value: '{{ $json.workflow.name }}' },
              { name: 'error', type: 'string', value: '{{ $json.execution.error.message }}' },
              { name: 'url', type: 'string', value: '{{ $json.execution.url }}' },
            ],
          },
        },
        notes: 'Add a Slack, email or Telegram node after this to send the alert.',
      },
    ],
    connections: [{ id: 'c1', type: 'main', source: 'error', sourceIndex: 0, target: 'summary', targetIndex: 0 }],
  };
  const total = failing.reduce((n, f) => n + f.failed, 0);
  return [
    {
      proposal: base('no-safety-net', 'instance', { type: 'instance', name: 'Failure alerts' }, {
        title: `Create an error workflow for ${failing.length} failing workflow${failing.length === 1 ? '' : 's'}`,
        why: `${failing.map((f) => `“${f.workflow.name}” (${f.failed})`).join(', ')} failed in production in the last 14 days, and none has an error workflow. Applying creates “Failure alerts” (an Error Trigger and a summary of what failed); add where to send it, then set it as their error workflow (the next suggestions do that).`,
        evidence: failing.slice(0, 8).map((f) => ({ label: 'Failing', value: `${f.workflow.name}: ${f.failed}`, href: `/workflows/${f.workflow.id}` })),
        effect: 'Failures reach someone the moment they happen',
        draft,
        risk: 'low',
        confidence: 0.75,
        impact: total,
      }),
    },
  ];
}

export const DETECTOR_RUNS: Record<BuiltinDetectorId, (ctx: DetectContext) => Finding[]> = {
  'failure-hot-spot': failureHotSpots,
  'flaky-call': flakyCalls,
  'slow-step': slowSteps,
  'ai-cost': aiCost,
  'hand-run-rhythm': handRunRhythm,
  'copy-paste': copyPaste,
  'dead-weight': deadWeight,
  'agent-quality': agentQuality,
  'unmet-demand': unmetDemand,
  'no-safety-net': noSafetyNet,
  'repeated-sequence': repeatedSequences,
  'missing-tool': missingTools,
};

export function detectContext(quiet: Partial<Record<DetectorId, number>> = {}, db: Database = database(), now = Date.now()): DetectContext {
  return { db, now, quiet: (id) => quiet[id] ?? 1, workflows: store.listWorkflows() };
}
