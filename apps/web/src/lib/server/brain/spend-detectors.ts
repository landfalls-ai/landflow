/**
 * SP13: the waste detectors (docs/second-brain.md#4-detectors-and-suggestions): what the model was sent that it did not
 * need. They read `ai_usage` and the prompt splits in `ai_call_parts` (sizes, tool names and hashes: never text), count
 * distinct runs (an agent's session, a workflow's execution), target an agent or a workflow, and name no person.
 * Spotlight, the Agent architect and the brain's own calls (they carry a `workflowId` but are not the flow's spend) are left out.
 */
import type { CallParts, PromptPart } from '../../shared/ai-call-parts';
import { PROMPT_PART_LABELS } from '../../shared/ai-call-parts';
import type { BuiltinDetectorId, ProposalEvidence } from '../../shared/brain';
import type { SpendCall } from '../../shared/run-spend';
import { agentStore } from '../agents/store';
import { callOf, cacheLine, partsOf } from '../ai-usage/run-spend';
import { isLocalProvider } from '../ai-usage/prices';
import { homeProjectId } from '../projects/store';
import { store } from '../store';
import type { DetectContext, Finding } from './detectors';
import { fingerprintOf, type NewProposal } from './proposals';

const DAY_MS = 86_400_000;
const NOT_CHAT = new Set(['embed', 'cache-embed', 'rerank']);

interface Row {
  id: string;
  at: string;
  day: string;
  execution_id: string | null;
  workflow_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  user_id: string | null;
  project_id: string | null;
  provider: string;
  gateway_provider: string | null;
  model: string;
  operation: string;
  source: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: number;
  gateway_request_id: string | null;
  node_id: string | null;
  span_id: string | null;
  purpose: string | null;
  iteration: number | null;
  caller_agent_id: string | null;
  duration_ms: number | null;
  stop_reason: string | null;
}

interface Call {
  row: Row;
  parts?: CallParts;
  /** The run it belongs to: a session, else an execution, else the call itself. */
  run: string;
  local: boolean;
}

interface Subject {
  key: string;
  type: 'agent' | 'workflow';
  id: string;
  calls: Call[];
}

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);
const runsOf = (calls: Call[]) => new Set(calls.map((c) => c.run)).size;
const label = (part: PromptPart) => PROMPT_PART_LABELS[part];

/** The most rows one detector reads; the cap drops the oldest rows, never the newest. Tests lower it. */
export const LOAD_LIMIT = { rows: 50_000 };

/** The calls of the last `days` days up to ctx.now (a backtest never sees the future): chat calls of agents and workflows, with their splits when they have one. */
function load(ctx: DetectContext, days: number): Subject[] {
  const rows = ctx.db.all<Row>(
    `SELECT * FROM ai_usage WHERE at >= ? AND at <= ? AND operation <> 'embeddings' AND surface IS NULL AND (agent_id IS NOT NULL OR workflow_id IS NOT NULL)
       AND COALESCE(purpose, '') NOT IN ('embed', 'cache-embed', 'rerank') ORDER BY at DESC LIMIT ?`,
    new Date(ctx.now - days * DAY_MS).toISOString(),
    new Date(ctx.now).toISOString(),
    LOAD_LIMIT.rows,
  );
  const splits = partsOf(rows as never);
  const subjects = new Map<string, Subject>();
  for (const row of rows) {
    const type = row.agent_id ? 'agent' : 'workflow';
    const id = (row.agent_id ?? row.workflow_id) as string;
    const key = `${type}:${id}`;
    const subject = subjects.get(key) ?? { key, type, id, calls: [] };
    subject.calls.push({ row, ...(splits.get(row.id) && { parts: splits.get(row.id) }), run: row.session_id ?? row.execution_id ?? row.id, local: isLocalProvider(row.provider) || isLocalProvider(row.gateway_provider) });
    subjects.set(key, subject);
  }
  return [...subjects.values()];
}

/** The proposal target, or undefined when the agent or workflow is gone. */
function targetOf(subject: Subject, ctx: DetectContext): { target: NewProposal['target']; name: string } | undefined {
  if (subject.type === 'agent') {
    const agent = agentStore.get(subject.id);
    return agent ? { target: { type: 'agent', id: agent.id, name: agent.name }, name: agent.name } : undefined;
  }
  const workflow = ctx.workflows.find((w) => w.id === subject.id) ?? store.getWorkflow(subject.id);
  return workflow ? { target: { type: 'workflow', id: workflow.id, name: workflow.name }, name: workflow.name } : undefined;
}

const noun = (subject: Subject) => (subject.type === 'agent' ? 'agent' : 'workflow');

function proposal(detector: BuiltinDetectorId, subject: Subject, ctx: DetectContext, extra: string, fields: { title: (name: string) => string; why: string; evidence: ProposalEvidence[]; effect?: string; confidence: number; impact: number }): Finding | undefined {
  const found = targetOf(subject, ctx);
  if (!found) return undefined;
  const projectId = homeProjectId(subject.type, subject.id);
  return {
    proposal: {
      source: 'detector',
      detector,
      fingerprint: fingerprintOf(detector, `${subject.key}${extra ? `|${extra}` : ''}`),
      ...(projectId && { projectId }),
      target: found.target,
      title: fields.title(found.name),
      why: fields.why,
      evidence: fields.evidence,
      ...(fields.effect && { effect: fields.effect }),
      ops: [],
      risk: 'low',
      confidence: Math.max(0, Math.min(1, fields.confidence)),
      score: Math.round(fields.impact * Math.max(0, Math.min(1, fields.confidence)) * 100) / 100,
    },
  };
}

/** The input a call is judged on: on Ollama `formatting` is an estimate, so it is left out. */
const inputOf = (call: Call): number | undefined => (call.parts ? call.parts.inputTokens - (call.local ? (call.parts.parts.formatting ?? 0) : 0) : undefined);

// ---------------------------------------------------------------------------

/** An agent's or workflow's prompt grew: the median input per call is over 1.5x that of the week before. */
export function contextBloat(ctx: DetectContext): Finding[] {
  const min = Math.ceil(20 * ctx.quiet('context-bloat'));
  const factor = 1 + 0.5 * ctx.quiet('context-bloat');
  const cut = ctx.now - 7 * DAY_MS;
  const out: Finding[] = [];
  for (const subject of load(ctx, 14)) {
    const withParts = subject.calls.filter((c) => c.parts);
    const now = withParts.filter((c) => Date.parse(c.row.at) >= cut);
    const before = withParts.filter((c) => Date.parse(c.row.at) < cut);
    if (now.length < min || before.length < min) continue;
    const medianNow = median(now.map((c) => inputOf(c) as number));
    const medianBefore = median(before.map((c) => inputOf(c) as number));
    if (medianBefore <= 0 || medianNow <= medianBefore * factor) continue;
    // The part that grew most, in tokens per call. Knowledge is expected to vary with the question; formatting is no part of Ollama's count.
    const mean = (calls: Call[], part: PromptPart) => sum(calls.map((c) => c.parts?.parts[part] ?? 0)) / calls.length;
    const grown = (Object.keys(PROMPT_PART_LABELS) as PromptPart[])
      .filter((p) => p !== 'knowledge' && !(p === 'formatting' && now.some((c) => c.local)))
      .map((p) => ({ part: p, grew: mean(now, p) - mean(before, p) }))
      .sort((a, b) => b.grew - a.grew)[0];
    const named = grown && grown.grew > 0 ? grown.part : undefined;
    const found = proposal('context-bloat', subject, ctx, '', {
      title: (name) => `The prompt of “${name}” is growing`,
      why: `The ${noun(subject)}’s calls this week carry ${Math.round(medianNow)} input tokens at the median, ${(medianNow / medianBefore).toFixed(1)} times the ${Math.round(medianBefore)} of the week before.${named ? ` “${label(named)}” grew most (${Math.round(grown.grew)} tokens more per call).` : ''} Try trimming it: summarize or drop old turns, shorten what the tools return, or cut instructions that are no longer needed.`,
      evidence: [
        { label: 'Median input tokens this week', value: Math.round(medianNow) },
        { label: 'Median input tokens the week before', value: Math.round(medianBefore) },
        { label: 'Calls this week', value: now.length },
        { label: 'Runs this week', value: runsOf(now) },
        ...(named ? [{ label: 'Part that grew most', value: label(named) }] : []),
      ],
      effect: `Fewer input tokens per call (now ${(medianNow / medianBefore).toFixed(1)}x the week before)`,
      confidence: 0.65,
      impact: Math.max(1, (medianNow - medianBefore) / 500),
    });
    if (found) out.push(found);
  }
  return out;
}

/** Tool results are most of what an agent sends: over 40% of its input tokens. */
export function fatToolResults(ctx: DetectContext): Finding[] {
  const min = Math.ceil(20 * ctx.quiet('fat-tool-results'));
  const out: Finding[] = [];
  for (const subject of load(ctx, 14)) {
    if (subject.type !== 'agent') continue;
    const calls = subject.calls.filter((c) => c.parts);
    if (calls.length < min) continue;
    const input = sum(calls.map((c) => inputOf(c) as number));
    const results = sum(calls.map((c) => c.parts?.parts.toolResults ?? 0));
    if (input <= 0 || results / input <= 0.4) continue;
    const share = results / input;
    const found = proposal('fat-tool-results', subject, ctx, '', {
      title: (name) => `Tool results are ${Math.round(share * 100)}% of what “${name}” sends`,
      why: `Over ${calls.length} calls in ${runsOf(calls)} runs in the last 14 days, tool results were ${Math.round(share * 100)}% of the input tokens. Try asking the tools for less: fewer fields, a limit on rows, or a short summary instead of the whole answer.`,
      evidence: [
        { label: 'Share of input tokens', value: `${Math.round(share * 1000) / 10}%` },
        { label: 'Tool result tokens', value: Math.round(results) },
        { label: 'Calls', value: calls.length },
        { label: 'Runs', value: runsOf(calls) },
      ],
      effect: 'Fewer input tokens on every call',
      confidence: 0.65,
      impact: Math.max(1, results / 10_000),
    });
    if (found) out.push(found);
  }
  return out;
}

/** The names of the tools a session called (names only: nothing of what was said or returned). */
function calledTools(sessionId: string): Set<string> | undefined {
  const session = agentStore.getSession(sessionId);
  if (!session) return undefined;
  const names = new Set<string>();
  for (const entry of session.timeline ?? []) if (entry.type === 'tool' && typeof entry.tool === 'string') names.add(entry.tool);
  for (const message of session.messages ?? []) {
    const calls = (message as { toolCalls?: Array<{ name?: unknown }> }).toolCalls;
    for (const call of calls ?? []) if (typeof call?.name === 'string') names.add(call.name);
  }
  return names;
}

/** Tools sent on 50+ calls in 30 days and never called by the agent's sessions. */
export function unusedTools(ctx: DetectContext): Finding[] {
  const min = Math.ceil(50 * ctx.quiet('unused-tools'));
  const out: Finding[] = [];
  for (const subject of load(ctx, 30)) {
    if (subject.type !== 'agent') continue;
    const agent = agentStore.get(subject.id);
    // kagent runs its own loop: Landflow sees neither its sessions' tool calls nor its tool list.
    if (!agent || agent.kagent) continue;
    const calls = subject.calls.filter((c) => c.parts?.source === 'landflow' && c.parts.toolNames?.length);
    if (calls.length < min) continue;
    const sent = new Map<string, number>();
    for (const call of calls) for (const name of new Set(call.parts?.toolNames)) sent.set(name, (sent.get(name) ?? 0) + 1);
    const sessions = [...new Set(subject.calls.map((c) => c.row.session_id).filter((s): s is string => Boolean(s)))];
    const used = new Set<string>();
    let readable = 0;
    for (const id of sessions) {
      const names = calledTools(id);
      if (!names) continue;
      readable += 1;
      for (const name of names) used.add(name);
    }
    // A session that can no longer be read may have called the tool.
    if (readable < sessions.length || !readable) continue;
    const unused = [...sent].filter(([name, n]) => n >= min && !used.has(name)).map(([name]) => name).sort();
    if (!unused.length) continue;
    const shown = unused.slice(0, 8).join(', ');
    const found = proposal('unused-tools', subject, ctx, '', {
      title: (name) => `“${name}” is sent ${unused.length} tool${unused.length === 1 ? '' : 's'} it never calls`,
      why: `${unused.length === 1 ? 'A tool was' : `${unused.length} tools were`} sent with ${calls.length} calls in ${runsOf(calls)} runs in 30 days and no session called ${unused.length === 1 ? 'it' : 'any of them'}: ${shown}${unused.length > 8 ? ` and ${unused.length - 8} more` : ''}. Try removing ${unused.length === 1 ? 'it' : 'them'} from the agent’s tools: their definitions go with every call.`,
      evidence: [
        { label: 'Tools never called', value: unused.length },
        { label: 'Tool names', value: shown },
        { label: 'Calls in 30 days', value: calls.length },
        { label: 'Sessions read', value: readable },
      ],
      effect: 'Fewer tool definitions in every prompt',
      confidence: 0.6,
      impact: Math.max(1, unused.length * 0.5),
    });
    if (found) out.push(found);
  }
  return out;
}

const spendCall = (call: Call): SpendCall =>
  callOf(call.row as never, () => undefined, Boolean(call.parts), true);

const REASON_WORDS: Record<string, string> = {
  'instructions-changed': 'the instructions change between calls',
  'tools-changed': 'the tool list changes between calls',
  'below-minimum': 'the part that could be cached is under the provider’s minimum',
  expired: 'the calls are more than 5 minutes apart',
  'not-requested': 'the calls ask for no cache',
  unknown: 'the cause cannot be told from the hashes',
};

/** An Anthropic agent or workflow whose cache hit rate is under 20% over 20+ calls. */
export function cacheMisses(ctx: DetectContext): Finding[] {
  const min = Math.ceil(20 * ctx.quiet('cache-misses'));
  const out: Finding[] = [];
  for (const subject of load(ctx, 14)) {
    const calls = subject.calls.filter((c) => c.row.provider === 'anthropic' && !(c.row.purpose && NOT_CHAT.has(c.row.purpose)));
    if (calls.length < min) continue;
    const splits = new Map<string, CallParts>(calls.filter((c) => c.parts).map((c) => [c.row.id, c.parts as CallParts]));
    const all = calls.map(spendCall);
    const hitRate = cacheLine(all, splits).hitRate;
    if (hitRate === undefined || hitRate >= 0.2) continue;
    // The most common reason over the runs (the cache line says which reasons a run had).
    const tally = new Map<string, number>();
    const byRun = new Map<string, SpendCall[]>();
    for (const [i, call] of calls.entries()) byRun.set(call.run, [...(byRun.get(call.run) ?? []), all[i]]);
    for (const group of byRun.values()) for (const reason of cacheLine(group, splits).missReasons) tally.set(reason, (tally.get(reason) ?? 0) + 1);
    const reason = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    const found = proposal('cache-misses', subject, ctx, '', {
      title: (name) => `The cache barely works for “${name}”`,
      why: `Only ${Math.round(hitRate * 1000) / 10}% of the input tokens over ${calls.length} calls in ${runsOf(calls)} runs came from the provider’s cache.${reason ? ` Most often ${REASON_WORDS[reason] ?? reason}.` : ''} Try keeping the start of the prompt (instructions and tools) the same from call to call, and make it long enough to be cached.`,
      evidence: [
        { label: 'Cache hit rate', value: `${Math.round(hitRate * 1000) / 10}%` },
        ...(reason ? [{ label: 'Most common reason', value: reason }] : []),
        { label: 'Calls', value: calls.length },
        { label: 'Runs', value: runsOf(calls) },
      ],
      effect: 'Cached input tokens cost a fraction of fresh ones',
      confidence: 0.6,
      impact: Math.max(1, calls.length / 20),
    });
    if (found) out.push(found);
  }
  return out;
}

/** The same prompt 5+ times in one day within one agent or workflow. */
export function repeatedCalls(ctx: DetectContext): Finding[] {
  const min = Math.ceil(5 * ctx.quiet('repeated-calls'));
  const out: Finding[] = [];
  for (const subject of load(ctx, 14)) {
    const groups = new Map<string, Call[]>();
    for (const call of subject.calls) {
      const hash = call.parts?.promptHash;
      if (hash) groups.set(`${call.row.day}|${hash}`, [...(groups.get(`${call.row.day}|${hash}`) ?? []), call]);
    }
    const worst = [...groups]
      .filter(([, calls]) => calls.length >= min)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
    if (!worst) continue;
    const [key, calls] = worst;
    const hash = key.split('|')[1].slice(0, 8);
    const repeated = [...groups.values()].filter((g) => g.length >= min).length;
    const found = proposal('repeated-calls', subject, ctx, '', {
      title: (name) => `“${name}” sends the same prompt again and again`,
      why: `${calls.length} identical prompts in ${runsOf(calls)} run${runsOf(calls) === 1 ? '' : 's'} on one day${repeated > 1 ? ` (and ${repeated - 1} other prompt${repeated === 2 ? '' : 's'} like it in 14 days)` : ''}. Try caching the answer, or sending it once and reusing the result.`,
      evidence: [
        { label: 'Identical prompts in a day', value: calls.length },
        { label: 'Runs', value: runsOf(calls) },
        { label: 'Prompt (hash prefix)', value: hash },
        { label: 'Day', value: calls[0].row.day },
      ],
      effect: 'Each repeat is paid in full',
      confidence: 0.6,
      impact: Math.max(1, calls.length / 5),
    });
    if (found) out.push(found);
  }
  return out;
}

/** An agent that keeps running to its iteration limit, or whose longest sessions run far past the typical one. */
export function agentLoops(ctx: DetectContext): Finding[] {
  const min = Math.ceil(3 * ctx.quiet('agent-loops'));
  const since = new Date(ctx.now - 14 * DAY_MS).toISOString();
  const limit = ctx.db.all<{ agent_id: string; session: string | null }>(
    "SELECT agent_id, json_extract(attrs, '$.session') AS session FROM usage_events WHERE kind = 'agent.session' AND at >= ? AND agent_id IS NOT NULL AND json_extract(attrs, '$.reason') = 'max_iterations'",
    since,
  );
  const atLimit = new Map<string, Set<string>>();
  for (const row of limit) atLimit.set(row.agent_id, (atLimit.get(row.agent_id) ?? new Set()).add(row.session ?? `${row.agent_id}:${atLimit.get(row.agent_id)?.size ?? 0}`));
  const out: Finding[] = [];
  for (const subject of load(ctx, 14)) {
    if (subject.type !== 'agent') continue;
    // The highest iteration of each session.
    const highest = new Map<string, number>();
    for (const call of subject.calls) {
      if (call.row.iteration === null || call.row.iteration === undefined || !call.row.session_id) continue;
      highest.set(call.row.session_id, Math.max(highest.get(call.row.session_id) ?? 0, Number(call.row.iteration)));
    }
    const limited = atLimit.get(subject.id)?.size ?? 0;
    const peaks = [...highest.values()];
    const typical = median(peaks);
    const top = Math.max(0, ...peaks);
    const runaway = peaks.length >= Math.max(5, min) && typical > 0 && top > typical * 3;
    if (limited < min && !runaway) continue;
    const parts: string[] = [];
    if (limited >= min) parts.push(`${limited} sessions ended at the iteration limit`);
    if (runaway) parts.push(`one session went ${top} steps against a typical ${Math.round(typical)}`);
    const found = proposal('agent-loops', subject, ctx, '', {
      title: (name) => `“${name}” may be going in circles`,
      why: `In 14 days ${parts.join(' and ')}. Try a clearer stopping rule in the instructions, a lower limit on iterations, or a tool that answers what the agent keeps asking for.`,
      evidence: [
        { label: 'Sessions at the iteration limit', value: limited },
        { label: 'Highest iteration', value: top },
        { label: 'Typical highest iteration', value: Math.round(typical) },
        { label: 'Sessions', value: new Set(subject.calls.map((c) => c.run)).size },
      ],
      effect: 'Fewer calls spent on steps that go nowhere',
      confidence: 0.6,
      impact: Math.max(1, limited + (runaway ? 2 : 0)),
    });
    if (found) out.push(found);
  }
  return out;
}
