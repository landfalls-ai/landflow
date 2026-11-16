/**
 * The AI page's cache card (docs/llm-gateway.md, "The AI page"): how well the provider's cache worked over the period,
 * for the calls the viewer's totals hold. It runs the Run Trace's own `cacheLine` over the period's calls, then again
 * per agent for the top 5 by uncached input. Reads `ai_usage` and `ai_call_parts` (sizes, counts, hashes), never prompt text.
 */
import { addDays } from '../../shared/ai-forecast';
import type { AiCacheAgent, AiCacheReport } from '../../shared/ai-cache';
import type { SpendCall } from '../../shared/run-spend';
import { agentStore } from '../agents/store';
import { database } from '../db';
import { canResource, isInstanceAdmin, type Actor } from '../projects/access';
import { aiUsageMeter } from './index';
import { visibleRow } from './forecast';
import { findPrice, priceOverrides } from './prices';
import { cacheLine, callOf, partsOf } from './run-spend';

const DAY_MS = 86_400_000;
const PARTS_KEPT_DAYS = 30;
const MAX_ROWS = 20_000;
const TOP_AGENTS = 5;

type UsageRow = Parameters<typeof callOf>[0];

const COLUMNS =
  'id, at, execution_id, workflow_id, agent_id, session_id, user_id, project_id, provider, model, operation, source, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, gateway_request_id, node_id, span_id, purpose, iteration, caller_agent_id, duration_ms, stop_reason';
// The rows `cacheLine` can count: a provider that reports a cache, or any row that has cache tokens.
const CANDIDATE = "(provider IN ('anthropic', 'openai') OR cache_read_tokens + cache_write_tokens > 0) AND operation <> 'embeddings'";
const PERIOD_DAYS = { '24h': 1, '7d': 7, '30d': 30 } as const;

const uncached = (c: SpendCall) => Math.max(0, c.inputTokens - c.cacheReadTokens);

/** The cache card's numbers for `actor`. */
export function aiCacheReport(actor: Actor, period: keyof typeof PERIOD_DAYS, now = Date.now()): AiCacheReport {
  const meter = aiUsageMeter();
  const today = meter.today(now);
  const first = meter.today(now - (PERIOD_DAYS[period] - 1) * DAY_MS);
  const where = period === '24h' ? 'at >= ?' : 'day >= ?';
  const start = period === '24h' ? new Date(now - DAY_MS).toISOString() : first;
  const found = database().all<UsageRow>(`SELECT ${COLUMNS} FROM ai_usage WHERE ${where} AND ${CANDIDATE} ORDER BY at DESC, id DESC LIMIT ${MAX_ROWS + 1}`, start);
  const truncated = found.length > MAX_ROWS;
  const sees = visibleRow(actor);
  const rows = found.slice(0, MAX_ROWS).filter(sees);

  const admin = isInstanceAdmin(actor);
  const readable = new Map<string, boolean>();
  const agentReadable = (id: string) => {
    let ok = readable.get(id);
    if (ok === undefined) readable.set(id, (ok = admin || canResource(actor, 'agent', id, 'read')));
    return ok;
  };
  const overrides = priceOverrides();
  const price = (c: { provider: string; model: string }) => findPrice(c.provider, c.model, overrides);
  const parts = partsOf(rows);
  const calls = rows.map((row) => callOf(row, price, parts.has(row.id), !row.agent_id || agentReadable(row.agent_id)));
  const whole = cacheLine(calls, parts, price);

  // Per agent (an agent the viewer can't read is "Another agent"); calls with no agent are one row.
  const groups = new Map<string, { label: string; calls: SpendCall[] }>();
  const keyed = rows.map((row, i) => ({ row, call: calls[i] }));
  for (const { row, call } of keyed) {
    const key = !row.agent_id ? 'none' : agentReadable(row.agent_id) ? row.agent_id : 'shared';
    let group = groups.get(key);
    if (!group) {
      const label = key === 'none' ? 'No agent' : key === 'shared' ? 'Another agent' : (agentStore.get(key)?.name ?? 'Deleted agent');
      groups.set(key, (group = { label, calls: [] }));
    }
    group.calls.push(call);
  }
  const agents: AiCacheAgent[] = [...groups]
    .map(([key, group]) => {
      const line = cacheLine(group.calls, parts, price);
      const counted = group.calls.filter((c) => !c.purpose || !['embed', 'cache-embed', 'rerank'].includes(c.purpose));
      return { key, label: group.label, uncachedTokens: counted.reduce((s, c) => s + uncached(c), 0), calls: group.calls.length, ...(line.hitRate !== undefined && { hitRate: line.hitRate }), missCalls: line.missCalls, missReasons: line.missReasons };
    })
    .filter((a) => a.uncachedTokens > 0)
    .sort((a, b) => b.uncachedTokens - a.uncachedTokens || a.label.localeCompare(b.label))
    .slice(0, TOP_AGENTS);

  // The AI Agent node asks for no cache: its Anthropic calls have an execution and a node but no session.
  const node = calls.filter((c, i) => c.provider === 'anthropic' && !c.sessionId && rows[i].execution_id && c.nodeId && c.cacheReadTokens + c.cacheWriteTokens === 0);
  return {
    period,
    cache: whole,
    agents,
    agentNode: { calls: node.length, uncachedTokens: node.reduce((s, c) => s + uncached(c), 0) },
    reasonsPartial: first < addDays(today, -PARTS_KEPT_DAYS),
    truncated,
  };
}
