/**
 * One run's spend and one call's view (wave 12, SP05; docs/run-trace.md#spend): what `GET /api/executions/:id/spend` and
 * `GET /api/ai-calls/:id` answer. Reads `ai_usage` and `ai_call_parts` (sizes, counts, hashes), never prompt text.
 * Who may open what follows docs/llm-gateway.md "Who sees what" (rule 3): drill-down needs read access to the run's
 * workflow or the call's agent, or a role in its project; a call with none of these opens for its own person and admins.
 */
import { CALL_PURPOSE_LABELS, isCallPurpose } from '../../shared/ai-call';
import type { CallParts, CountMethod, PromptPart } from '../../shared/ai-call-parts';
import { emptySpendTotals, type AiCallView, type CacheLine, type RunSpend, type SpendCall, type SpendComposition, type SpendSlice, type SpendTotals } from '../../shared/run-spend';
import { agentStore } from '../agents/store';
import { database } from '../db';
import { canResource, executionWorkflowId, isInstanceAdmin, projectRole, type Actor } from '../projects/access';
import { liveExecution } from '../runner';
import { store } from '../store';
import { findPrice, priceOverrides } from './prices';
import type { ModelPrice } from '../../shared/ai-usage';

/** The calls a run lists at most (newest last). */
export const SPEND_CALL_LIMIT = 500;
const CACHE_TTL_MS = 5 * 60_000;
/** The lowest prompt-cache minimum among current Claude models (cache-layout.md): "may be below the minimum". */
const MIN_CACHEABLE_TOKENS = 1024;
const CACHE_PARTS: PromptPart[] = ['toolDefinitions', 'instructions', 'projectBlock', 'practices'];
const NOT_CHAT = new Set(['embed', 'cache-embed', 'rerank']);
const WEAKNESS: Record<CountMethod, number> = { estimate: 0, tokenizer: 1, provider: 2 };
const round = (n: number) => Math.round(n * 1e8) / 1e8;
const CHUNK = 400;

interface UsageRow {
  id: string;
  at: string;
  execution_id: string | null;
  workflow_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  user_id: string | null;
  project_id: string | null;
  provider: string;
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

const num = (v: unknown) => Number(v ?? 0) || 0;

const chunks = <T>(list: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
};

/** The split of each call: by the row's id, else (a gateway split) by its gateway request id. */
interface PartsRow {
  usage_id: string | null;
  gateway_request_id: string | null;
  at: string;
  source: string;
  method: string;
  input_tokens: number;
  parts: string;
  prefix_hash: string | null;
  prompt_hash: string | null;
  part_hashes: string | null;
  tool_names: string | null;
}

function toParts(row: PartsRow): CallParts {
  const partHashes = row.part_hashes ? (JSON.parse(row.part_hashes) as Partial<Record<PromptPart, string>>) : undefined;
  return {
    ...(row.usage_id && { usageId: row.usage_id }),
    ...(row.gateway_request_id && { gatewayRequestId: row.gateway_request_id }),
    at: row.at,
    source: row.source as CallParts['source'],
    method: row.method as CallParts['method'],
    inputTokens: num(row.input_tokens),
    parts: JSON.parse(row.parts) as CallParts['parts'],
    ...(row.prefix_hash && { prefixHash: row.prefix_hash }),
    ...(row.prompt_hash && { promptHash: row.prompt_hash }),
    ...(partHashes && Object.keys(partHashes).length && { partHashes }),
    ...(row.tool_names && { toolNames: JSON.parse(row.tool_names) as string[] }),
  };
}

/** Splits of these rows, keyed by `ai_usage.id` (a gateway split joins by the row's `gateway_request_id`). */
function partsOf(rows: UsageRow[]): Map<string, CallParts> {
  const found = new Map<string, CallParts>();
  const db = database();
  const byRequest = new Map(rows.filter((r) => r.gateway_request_id).map((r) => [r.gateway_request_id as string, r.id]));
  for (const ids of chunks(rows.map((r) => r.id))) {
    for (const row of db.all<PartsRow>(`SELECT * FROM ai_call_parts WHERE usage_id IN (${ids.map(() => '?').join(',')})`, ...ids)) found.set(row.usage_id as string, toParts(row));
  }
  const missing = [...byRequest].filter(([, id]) => !found.has(id));
  for (const group of chunks(missing)) {
    const requests = group.map(([request]) => request);
    for (const row of db.all<PartsRow>(`SELECT * FROM ai_call_parts WHERE gateway_request_id IN (${requests.map(() => '?').join(',')})`, ...requests)) {
      const id = byRequest.get(row.gateway_request_id as string);
      if (id && !found.has(id)) found.set(id, toParts(row));
    }
  }
  return found;
}

const priceFor = (overrides: ModelPrice[]) => (call: { provider: string; model: string }) => findPrice(call.provider, call.model, overrides);

function callOf(row: UsageRow, price: (c: { provider: string; model: string }) => ModelPrice | undefined, hasParts: boolean, agentVisible: boolean): SpendCall {
  return {
    usageId: row.id,
    at: row.at,
    provider: row.provider,
    model: row.model,
    ...(isCallPurpose(row.purpose) && { purpose: row.purpose }),
    ...(row.iteration !== null && row.iteration !== undefined && { iteration: num(row.iteration) }),
    ...(row.node_id && { nodeId: row.node_id }),
    ...(row.agent_id && agentVisible && { agentId: row.agent_id }),
    ...(row.session_id && { sessionId: row.session_id }),
    ...(row.span_id && { spanId: row.span_id }),
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    cacheReadTokens: num(row.cache_read_tokens),
    cacheWriteTokens: num(row.cache_write_tokens),
    cost: num(row.cost),
    priced: price(row) !== undefined || num(row.cost) > 0,
    ...(row.duration_ms !== null && row.duration_ms !== undefined && { durationMs: num(row.duration_ms) }),
    ...(row.stop_reason && { stopReason: row.stop_reason }),
    source: row.source === 'litellm' ? 'litellm' : 'landflow',
    hasParts,
  };
}

function addTo(into: SpendTotals, call: SpendCall) {
  into.inputTokens += call.inputTokens;
  into.outputTokens += call.outputTokens;
  into.cacheReadTokens += call.cacheReadTokens;
  into.cacheWriteTokens += call.cacheWriteTokens;
  into.cost += call.cost;
  into.calls += 1;
  if (!call.priced) into.unpricedCalls += 1;
}

const finish = (t: SpendTotals): SpendTotals => ({ ...t, cost: round(t.cost) });

function slices(calls: SpendCall[], keyOf: (c: SpendCall) => { key: string; label: string } | undefined, total: SpendTotals): SpendSlice[] {
  const map = new Map<string, SpendSlice>();
  for (const call of calls) {
    const k = keyOf(call);
    if (!k) continue;
    let slice = map.get(k.key);
    if (!slice) {
      slice = { ...emptySpendTotals(), key: k.key, label: k.label, share: 0 };
      map.set(k.key, slice);
    }
    addTo(slice, call);
  }
  const byCost = total.cost > 0;
  const whole = total.inputTokens + total.outputTokens;
  return [...map.values()]
    .map((s) => ({ ...s, cost: round(s.cost), share: Math.round((byCost ? s.cost / total.cost : whole ? (s.inputTokens + s.outputTokens) / whole : 0) * 1e4) / 1e4 }))
    .sort((a, b) => b.cost - a.cost || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || a.key.localeCompare(b.key));
}

/** How well the provider's cache worked, over chat calls of providers that report it (pure: the caller hands the splits and, for the saving, the price). */
export function cacheLine(calls: SpendCall[], parts: ReadonlyMap<string, CallParts>, priceOf: (call: SpendCall) => Pick<ModelPrice, 'input' | 'cacheRead'> | undefined = () => undefined): CacheLine {
  const sorted = [...calls].sort((a, b) => a.at.localeCompare(b.at) || a.usageId.localeCompare(b.usageId));
  const counted = sorted.filter((c) => !(c.purpose && NOT_CHAT.has(c.purpose)) && (c.provider === 'anthropic' || c.provider === 'openai' || c.cacheReadTokens + c.cacheWriteTokens > 0));
  const read = counted.reduce((s, c) => s + c.cacheReadTokens, 0);
  const write = counted.reduce((s, c) => s + c.cacheWriteTokens, 0);
  const input = counted.reduce((s, c) => s + c.inputTokens, 0);
  const reasons: CacheLine['missReasons'] = [];
  const reason = (r: CacheLine['missReasons'][number]) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  let missCalls = 0;
  const groups = new Map<string, SpendCall[]>();
  for (const call of counted) {
    const key = `${call.sessionId ?? 'run'}\u0000${call.provider}/${call.model}`;
    groups.set(key, [...(groups.get(key) ?? []), call]);
  }
  for (const group of groups.values()) {
    // No write and no read over the whole session: a provider writes no entry under its minimum, so a stable prefix that small
    // is the likely cause ("may be"); with no split, or a prefix over the minimum, the model made no cache request.
    if (group.length > 1 && group[0].provider === 'anthropic' && group.every((c) => c.cacheReadTokens === 0 && c.cacheWriteTokens === 0)) {
      const small = group.some((c) => {
        const split = parts.get(c.usageId);
        return split !== undefined && CACHE_PARTS.reduce((s, p) => s + (split.parts[p] ?? 0), 0) < MIN_CACHEABLE_TOKENS;
      });
      reason(small ? 'below-minimum' : 'not-requested');
    }
    for (let i = 1; i < group.length; i++) {
      const call = group[i];
      if (!(call.cacheWriteTokens > 0 && call.cacheReadTokens === 0)) continue;
      missCalls += 1;
      const before = parts.get(group[i - 1].usageId);
      const now = parts.get(call.usageId);
      // Gateway and Landflow hashes are made under different keys: compare only the splits of one source.
      const comparable = before !== undefined && now !== undefined && before.source === now.source;
      const changed = (part: PromptPart) => comparable && before.partHashes?.[part] !== undefined && now.partHashes?.[part] !== undefined && before.partHashes[part] !== now.partHashes[part];
      const prefix = now ? CACHE_PARTS.reduce((s, p) => s + (now.parts[p] ?? 0), 0) : undefined;
      if (changed('instructions')) reason('instructions-changed');
      else if (changed('toolDefinitions')) reason('tools-changed');
      else if (Date.parse(call.at) - Date.parse(group[i - 1].at) > CACHE_TTL_MS) reason('expired');
      else if (prefix !== undefined && prefix < MIN_CACHEABLE_TOKENS) reason('below-minimum');
      else reason('unknown');
    }
  }
  const savedUsd = counted.reduce((s, c) => {
    const price = priceOf(c);
    return price ? s + (c.cacheReadTokens * (price.input - (price.cacheRead ?? price.input))) / 1_000_000 : s;
  }, 0);
  return {
    ...(counted.length && input > 0 && { hitRate: Math.round((read / input) * 1e4) / 1e4 }),
    readTokens: read,
    writeTokens: write,
    missCalls,
    missReasons: reasons,
    savedUsd: round(Math.max(0, savedUsd)),
  };
}

/** The previous call of the same agent and model before `call` (the candidates are of its session, else its run): the latest by time, ties by id. */
export function matchPrevious<T extends { usageId: string; at: string; provider: string; model: string; agentId?: string }>(call: T, candidates: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const c of candidates) {
    if (c.usageId === call.usageId || c.provider !== call.provider || c.model !== call.model || c.agentId !== call.agentId) continue;
    if (!(c.at < call.at || (c.at === call.at && c.usageId < call.usageId))) continue;
    if (!best || c.at > best.at || (c.at === best.at && c.usageId > best.usageId)) best = c;
  }
  return best;
}

/** What `actor` may open of a run: the workflow's project decides, as `GET /api/executions/:id` does. */
function runWorkflowId(executionId: string): { workflowId: string } | undefined {
  const workflowId = executionWorkflowId(executionId) ?? liveExecution(executionId)?.workflowId;
  return workflowId ? { workflowId } : undefined;
}

const canOpenRun = (actor: Actor, executionId: string) => {
  const run = runWorkflowId(executionId);
  return Boolean(run && canResource(actor, 'workflow', run.workflowId, 'read'));
};

/** The root run and every sub-run under it (sub-workflows by `parent_id`, at most 10 levels). */
async function runFamily(root: string): Promise<string[]> {
  const seen = new Set([root]);
  let level = [root];
  for (let depth = 0; depth < 10 && level.length; depth++) {
    const next: string[] = [];
    for (const group of chunks(level)) {
      for (const row of database().all<{ id: string }>(`SELECT id FROM executions WHERE parent_id IN (${group.map(() => '?').join(',')})`, ...group)) next.push(row.id);
    }
    // A sub-run still going is not saved yet: its parent's record names it.
    for (const id of level) for (const child of liveExecution(id)?.subExecutions ?? []) next.push(child.executionId);
    level = next.filter((id) => !seen.has(id));
    for (const id of level) seen.add(id);
  }
  return [...seen];
}

const USAGE_COLUMNS =
  'id, at, execution_id, workflow_id, agent_id, session_id, user_id, project_id, provider, model, operation, source, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, gateway_request_id, node_id, span_id, purpose, iteration, caller_agent_id, duration_ms, stop_reason';

/** One run's spend, or undefined when there is no such run or `actor` may not open it. */
export async function runSpend(executionId: string, actor: Actor): Promise<RunSpend | undefined> {
  const root = liveExecution(executionId) ?? (await store.loadExecution(executionId));
  if (!root || !canResource(actor, 'workflow', root.workflowId, 'read')) return undefined;
  const admin = isInstanceAdmin(actor);
  const family = await runFamily(executionId);
  const rows: UsageRow[] = [];
  for (const group of chunks(family)) {
    rows.push(...database().all<UsageRow>(`SELECT ${USAGE_COLUMNS} FROM ai_usage WHERE execution_id IN (${group.map(() => '?').join(',')}) ORDER BY at, id`, ...group));
  }
  rows.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  // A sub-run is a sub-workflow (opens with its workflow) or a session of another agent (a team member, an agent tool:
  // opens with its agent). What the viewer can't open is counted by distinct run, never listed.
  const agentReadable = new Map<string, boolean>();
  const readableAgent = (id: string) => {
    let ok = agentReadable.get(id);
    if (ok === undefined) agentReadable.set(id, (ok = admin || canResource(actor, 'agent', id, 'read')));
    return ok;
  };
  const workflowReadable = new Map<string, boolean>();
  const readableRun = (id: string, fallbackWorkflow: string | null) => {
    let ok = workflowReadable.get(id);
    if (ok === undefined) {
      const workflowId = executionWorkflowId(id) ?? liveExecution(id)?.workflowId ?? fallbackWorkflow;
      workflowReadable.set(id, (ok = admin || Boolean(workflowId && canResource(actor, 'workflow', workflowId, 'read'))));
    }
    return ok;
  };
  const childSession = new Map<string, boolean>();
  const isChildSession = (row: UsageRow) => isChildSessionRow(row, childSession);
  const open: UsageRow[] = [];
  const hidden = emptySpendTotals();
  const hiddenRuns = new Set<string>();
  const price = priceFor(priceOverrides());
  const asCall = (row: UsageRow, hasParts = false) => callOf(row, price, hasParts, true);
  for (const row of rows) {
    let blocked: string | undefined;
    if (!admin) {
      if (row.execution_id && row.execution_id !== executionId && !readableRun(row.execution_id, row.workflow_id)) blocked = `x:${row.execution_id}`;
      else if (row.agent_id && !readableAgent(row.agent_id) && isChildSession(row)) blocked = `s:${row.session_id ?? row.id}`;
    }
    if (blocked) {
      hiddenRuns.add(blocked);
      addTo(hidden, asCall(row));
    } else open.push(row);
  }

  const listed = open.slice(-SPEND_CALL_LIMIT);
  const parts = partsOf(listed);
  const calls = listed.map((row) => callOf(row, price, parts.has(row.id), !row.agent_id || readableAgent(row.agent_id)));
  const all = open.map((row) => callOf(row, price, false, !row.agent_id || readableAgent(row.agent_id)));
  const totals = emptySpendTotals();
  for (const call of all) addTo(totals, call);

  // Names: a node's name as the run recorded it; an agent's name only when the viewer can read the agent.
  const nodeNames = new Map<string, string>();
  for (const id of new Set(open.map((r) => r.execution_id).filter((id): id is string => Boolean(id)))) {
    const record = id === executionId ? root : liveExecution(id) ?? (await store.loadExecution(id));
    for (const [nodeId, name] of Object.entries(record?.nodeNames ?? {})) if (!nodeNames.has(nodeId)) nodeNames.set(nodeId, name);
  }
  const providersOf = new Map<string, Set<string>>();
  for (const call of all) providersOf.set(call.model, (providersOf.get(call.model) ?? new Set<string>()).add(call.provider));
  const modelCount = new Map([...providersOf].map(([model, set]) => [model, set.size]));
  const agentLabel = (id: string) => (readableAgent(id) ? agentStore.get(id)?.name ?? 'An agent' : 'Another agent');

  const byPurpose = slices(all, (c) => (c.purpose ? { key: c.purpose, label: CALL_PURPOSE_LABELS[c.purpose] } : { key: 'none', label: 'Not set' }), totals);
  const byModel = slices(all, (c) => ({ key: `${c.provider}/${c.model}`, label: (modelCount.get(c.model) ?? 1) > 1 ? `${c.model} (${c.provider})` : c.model }), totals);
  const byNode = slices(all, (c) => (c.nodeId ? { key: c.nodeId, label: nodeNames.get(c.nodeId) ?? `Node ${c.nodeId}` } : undefined), totals);
  const byAgentRows = open.map((row, i) => ({ row, call: all[i] }));
  const byAgent = slices(
    byAgentRows.filter((x) => x.row.agent_id).map((x) => ({ ...x.call, agentId: x.row.agent_id as string })),
    (c) => (readableAgent(c.agentId as string) ? { key: c.agentId as string, label: agentLabel(c.agentId as string) } : { key: 'other', label: 'Another agent' }),
    totals,
  );
  const byIteration = slices(all, (c) => (c.iteration !== undefined ? { key: String(c.iteration), label: `Step ${c.iteration}` } : undefined), totals).sort((a, b) => Number(a.key) - Number(b.key));

  const have = listed.filter((r) => parts.has(r.id));
  let composition: SpendComposition | undefined;
  if (have.length) {
    const sum: Partial<Record<PromptPart, number>> = {};
    let method: CountMethod = 'provider';
    for (const row of have) {
      const split = parts.get(row.id) as CallParts;
      if (WEAKNESS[split.method] < WEAKNESS[method]) method = split.method;
      for (const [part, tokens] of Object.entries(split.parts)) sum[part as PromptPart] = (sum[part as PromptPart] ?? 0) + (tokens ?? 0);
    }
    composition = { method, parts: sum, callsWithParts: have.length, calls: listed.length };
  }

  const chat = calls.filter((_, i) => listed[i].operation !== 'embeddings');
  const priceOf = (call: SpendCall) => price(call);
  return {
    executionId,
    totals: finish(totals),
    byPurpose,
    byModel,
    byNode,
    byAgent,
    byIteration,
    ...(composition && { composition }),
    cache: cacheLine(chat, parts, priceOf),
    calls,
    truncated: open.length > SPEND_CALL_LIMIT,
    hidden: { runs: hiddenRuns.size, totals: finish(hidden) },
  };
}

/** A row of a child session: an agent called by another agent (a team member, an agent tool), by caller or by session. */
function isChildSessionRow(row: UsageRow, cache?: Map<string, boolean>): boolean {
  if (row.caller_agent_id) return true;
  if (!row.session_id) return false;
  let is = cache?.get(row.session_id);
  if (is === undefined) {
    is = Boolean(agentStore.getSession(row.session_id)?.parentSessionId);
    cache?.set(row.session_id, is);
  }
  return is;
}

/**
 * Whether `actor` may open this call (rule 3): its run, its agent or its project, else its own person and admins. The
 * rule of `runSpend` holds here too: a call in a child session of an agent the viewer cannot read is not opened.
 */
function canOpenCall(actor: Actor, row: UsageRow): boolean {
  if (isInstanceAdmin(actor)) return true;
  if (row.agent_id && !canResource(actor, 'agent', row.agent_id, 'read') && isChildSessionRow(row)) return false;
  if (row.execution_id && canOpenRun(actor, row.execution_id)) return true;
  if (row.agent_id && canResource(actor, 'agent', row.agent_id, 'read')) return true;
  if (row.project_id && projectRole(actor, row.project_id)) return true;
  if (row.execution_id || row.agent_id || row.project_id) return false;
  return row.user_id === actor.id;
}

/** One call's view, or undefined when there is no such call or `actor` may not open it. */
export function aiCallView(usageId: string, actor: Actor): AiCallView | undefined {
  if (!/^[\w-]+$/.test(usageId)) return undefined;
  const db = database();
  const row = db.get<UsageRow>(`SELECT ${USAGE_COLUMNS} FROM ai_usage WHERE id = ?`, usageId);
  if (!row || !canOpenCall(actor, row)) return undefined;
  const price = priceFor(priceOverrides());
  const agentVisible = !row.agent_id || isInstanceAdmin(actor) || canResource(actor, 'agent', row.agent_id, 'read');
  const parts = partsOf([row]).get(row.id);
  const call = callOf(row, price, Boolean(parts), agentVisible);

  let previous: AiCallView['previous'];
  const scope = row.session_id ? { column: 'session_id', value: row.session_id } : row.execution_id ? { column: 'execution_id', value: row.execution_id } : undefined;
  if (scope) {
    // The agent is in the SQL filter: in a run of several agents on one model, newer rows of the others must not push the real previous call out of the 200.
    const agentFilter = row.agent_id ? { sql: 'agent_id = ?', args: [row.agent_id] } : { sql: 'agent_id IS NULL', args: [] };
    const candidates = db.all<UsageRow>(`SELECT ${USAGE_COLUMNS} FROM ai_usage WHERE ${scope.column} = ? AND model = ? AND ${agentFilter.sql} AND at <= ? AND id <> ? ORDER BY at DESC, id DESC LIMIT 200`, scope.value, row.model, ...agentFilter.args, row.at, row.id);
    const before = matchPrevious({ ...call, agentId: row.agent_id ?? undefined }, candidates.map((c) => callOf(c, price, false, true)));
    if (before) {
      const earlier = partsOf(candidates.filter((c) => c.id === before.usageId)).get(before.usageId);
      // Gateway and Landflow hashes use different keys: a mixed pair is not compared.
      const comparable = parts !== undefined && earlier !== undefined && parts.source === earlier.source;
      const hashesNow = comparable ? parts.partHashes : undefined;
      const hashesBefore = comparable ? earlier.partHashes : undefined;
      const changedParts = hashesNow && hashesBefore ? ([...new Set([...Object.keys(hashesNow), ...Object.keys(hashesBefore)])] as PromptPart[]).filter((p) => hashesNow[p] !== hashesBefore[p]) : [];
      previous = { usageId: before.usageId, samePrefix: Boolean(comparable && parts.prefixHash && earlier.prefixHash && parts.prefixHash === earlier.prefixHash), changedParts };
    }
  }
  const runHref = row.execution_id && (isInstanceAdmin(actor) || canOpenRun(actor, row.execution_id)) ? `/runs/${row.execution_id}` : undefined;
  return {
    call,
    ...(parts && { parts: { source: parts.source, method: parts.method, parts: parts.parts, ...(parts.toolNames && { toolNames: parts.toolNames }) } }),
    ...(previous && { previous }),
    ...(runHref && { runHref }),
  };
}
