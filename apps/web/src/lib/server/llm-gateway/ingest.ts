/**
 * The spend import (docs/llm-gateway.md, "Agents outside Landflow"): copies the model calls Landflow did not meter itself
 * (agents on kagent, Claude Code on kagent, other clients of the gateway, Landflow's own calls outside a usage scope) from
 * LiteLLM's spend log into `ai_usage`, one row per call, attributed only from what Landflow controls (a key it minted, or
 * the key's team). Insights, the AI page and the usage caps sum `ai_usage`, so they count these calls by themselves.
 *
 * A call is counted once. A spend row is named by LiteLLM's request id, the id the gateway gave the response (row id and
 * `gateway_request_id`); Landflow's meter keeps that id for each call it made through the server's gateway, so the import
 * skips exactly those spend rows. A call with no response id (embeddings) made with the server's own key, whose call ids
 * only Landflow mints, is paired by its call id instead, one spend row for one Landflow row. Nothing a caller sends
 * decides either: a caller can choose its call id, never the response id. Only the server's admin connection reads the
 * log, so a member can't inject or erase spend.
 */
import { createHash } from 'node:crypto';
import { envInt } from '../config';
import { database, type Database, type SqlValue } from '../db';
import { aiUsageMeter } from '../ai-usage';
import { dayOf, recordUsage } from '../usage/ledger';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { projectIdOfTeam, type AiRuntime, type IngestStatus } from '../../shared/llm-gateway';
import { hashKey, spendLogTime, type Fetcher, type LiteLlmSpendLog } from './client';
import { adminClient, gatewayConnection, gatewaySettings, ingestStatus, saveIngestStatus } from './settings';
import { serverKeyHash } from './call';

const PAGE_SIZE = 500;
const MAX_PAGES = 200;
const OVERLAP_MS = 15 * 60_000;
const LAG_MS = 60_000;
const FIRST_WINDOW_MS = 24 * 3_600_000;
/** The window is read in chunks of this length, oldest first, so an unfinished run never skips rows. */
const CHUNK_MS = 3_600_000;
const MISSING_ADMIN = 'The spend import needs LANDFLOW_LLM_GATEWAY_URL and LANDFLOW_LLM_GATEWAY_ADMIN_KEY on the server';

const sha = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const RUNTIMES = new Set<AiRuntime>(['kagent', 'claude']);

/** A time LiteLLM wrote (ISO, often without a zone: it is UTC) in milliseconds. */
function timeOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

interface KeyRow {
  runtime: string;
  agent_id: string;
  project_id: string | null;
}

/** The cache tokens a row reports (`usage_object`, in either provider's words). */
function cacheTokens(row: LiteLlmSpendLog): { read: number; write: number } {
  const usage = (row.metadata?.usage_object ?? {}) as Record<string, unknown>;
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  return {
    read: count(usage.cache_read_input_tokens) || count(details.cached_tokens),
    write: count(usage.cache_creation_input_tokens),
  };
}

interface Attribution {
  runtime: AiRuntime;
  agentId?: string;
  projectId?: string;
}

/**
 * Who made the call, from what Landflow controls only: a key it minted for a runtime (its agent and project), else the
 * project of the key's LiteLLM team (an admin assigns teams). What the caller sends (end user, tags, spend-log metadata)
 * names nobody: a key holder could otherwise file spend under another person, agent or project and use up their caps.
 */
export function attribute(row: LiteLlmSpendLog, db: Database): Attribution {
  const key = row.api_key ? db.get<KeyRow>('SELECT runtime, agent_id, project_id FROM llm_gateway_keys WHERE key_hash = ?', row.api_key) : undefined;
  const trusted = key !== undefined && RUNTIMES.has(key.runtime as AiRuntime);
  const runtime: AiRuntime = trusted ? (key.runtime as AiRuntime) : 'other';
  const agentId = trusted ? key.agent_id : undefined;
  const projectId = key?.project_id ?? projectIdOfTeam(row.team_id || row.metadata?.user_api_key_team_id);
  return { runtime, ...(agentId && { agentId }), ...(projectId && { projectId }) };
}

export interface ImportOptions {
  now?: number;
  db?: Database;
  fetcher?: Fetcher;
}

/** Import what the gateway's spend log holds since the last run. Never throws: a failure is kept in the status. */
export async function importSpend(options: ImportOptions = {}): Promise<IngestStatus> {
  const db = options.db ?? database();
  const now = options.now ?? Date.now();
  const previous = ingestStatus(db);
  const settings = gatewaySettings(db);
  const connection = await gatewayConnection(db).catch(() => undefined);
  const admin = adminClient(connection, options.fetcher);
  if (!connection || !admin || !settings.ingest) {
    const idle: IngestStatus = {
      ...previous,
      enabled: false,
      imported: 0,
      skipped: 0,
      ...(settings.ingest && connection && !admin ? { error: MISSING_ADMIN } : { error: undefined }),
    };
    if (idle.error === undefined) delete idle.error;
    saveIngestStatus(idle, db);
    return idle;
  }

  const meter = aiUsageMeter();
  // Only the server's own key (LANDFLOW_LLM_GATEWAY_KEY) labels a row as Landflow's; a credential's key is member-editable.
  const ownKeyHash = connection.source === 'environment' && connection.apiKey ? hashKey(connection.apiKey) : undefined;
  const serverKey = serverKeyHash();
  const endMs = now - LAG_MS;
  const startMs = previous.lastEnd && timeOf(previous.lastEnd) !== undefined ? (timeOf(previous.lastEnd) as number) - OVERLAP_MS : now - FIRST_WINDOW_MS;
  let imported = 0;
  let skipped = 0;
  let error: string | undefined;
  /** The end of the last chunk that was read to an empty page: nothing older than it is unread. */
  let doneUpTo: number | undefined;
  let stalled = false;

  try {
    // LiteLLM caps only the advertised total (`total_is_capped`); the data is never cut, so page until a page is empty.
    for (let from = startMs; from < endMs && !stalled; from += CHUNK_MS) {
      const to = Math.min(endMs, from + CHUNK_MS);
      let finished = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        // The chunk's end is one second late: a row on the boundary is read twice, never missed (a call id counts once).
        const reply = await admin.spendLogs({ start: spendLogTime(from), end: spendLogTime(Math.min(endMs, to + 1000)), page, pageSize: PAGE_SIZE });
        if (!reply.data.length) {
          finished = true;
          break;
        }
        for (const row of reply.data) {
          if (importRow(row, { db, meter, ownKeyHash, serverKey, now })) imported++;
          else skipped++;
        }
      }
      if (!finished) {
        stalled = true;
        error = `The gateway's spend log holds more than ${(MAX_PAGES * PAGE_SIZE).toLocaleString('en-US')} rows from ${new Date(from).toISOString()} on; the import keeps its place there and tries again`;
        break;
      }
      doneUpTo = to;
    }
  } catch (cause) {
    error = (cause as Error).message || 'The gateway could not be read';
    logger.warn('llm gateway: the spend import failed', { error });
  }

  // Only chunks read to the end move the mark; a failed or stalled run keeps what it had.
  const lastEnd = doneUpTo !== undefined ? new Date(doneUpTo).toISOString() : previous.lastEnd;
  const status: IngestStatus = {
    enabled: true,
    lastRunAt: new Date(now).toISOString(),
    ...(lastEnd && { lastEnd }),
    imported,
    skipped,
    totalImported: previous.totalImported + imported,
    ...(error && { error }),
  };
  saveIngestStatus(status, db);
  if (imported) logger.info('llm gateway: spend imported', { imported, skipped });
  return status;
}

/** One spend row into `ai_usage` (and the usage ledger); false when it is skipped. */
function importRow(row: LiteLlmSpendLog, ctx: { db: Database; meter: ReturnType<typeof aiUsageMeter>; ownKeyHash?: string; serverKey?: string; now: number }): boolean {
  const { db, meter } = ctx;
  // A spend row is named by LiteLLM's request id, the response's id (the gateway's, not the caller's). The call id
  // (`x-litellm-call-id`) is not enough: a caller may send its own, so two rows can share one.
  const requestId = text(row.request_id);
  if (!requestId) return false;
  const callId = text(row.litellm_call_id);
  if (row.status !== undefined && row.status !== 'success') return false;
  const input = count(row.prompt_tokens) || (row.prompt_tokens === undefined ? count(row.total_tokens) - count(row.completion_tokens) : 0);
  const output = count(row.completion_tokens);
  const spend = typeof row.spend === 'number' && Number.isFinite(row.spend) && row.spend > 0 ? row.spend : 0;
  if (input + output + count(row.total_tokens) === 0 && spend === 0) return false;
  // Imported before, or a call Landflow's meter counted (it keeps the response id the server's gateway gave it).
  if (db.get('SELECT 1 AS found FROM ai_usage WHERE gateway_request_id = ?', requestId)) return false;
  // A call with no response id is paired by its call id only on the server's own key: only the server holds it and
  // Landflow mints its call ids, so nobody can reuse one. Any other key's holder can, so its rows are always imported.
  // One Landflow row takes one spend row. Nothing the caller sends (the `in-process` metadata) and no credential's key
  // can make the import skip a row.
  const serverKey = ctx.serverKey && row.api_key === ctx.serverKey ? ctx.serverKey : undefined;
  if (callId && serverKey) {
    const counted = db.get<Record<string, SqlValue>>("SELECT * FROM ai_usage WHERE call_id = ? AND source = 'landflow' AND gateway_key_hash = ? AND gateway_request_id IS NULL", callId, serverKey);
    if (counted) {
      db.upsert('ai_usage', { ...counted, gateway_request_id: requestId });
      return false;
    }
  }

  const at = timeOf(row.startTime) ?? timeOf(row.endTime) ?? ctx.now;
  const who = attribute(row, db);
  // An `unmetered` call on Landflow's own key is Landflow's (a background job), not another client's.
  if (ctx.ownKeyHash && row.api_key === ctx.ownKeyHash) who.runtime = 'landflow';
  const model = text(row.model_group) ?? text(row.model) ?? 'unknown';
  const cache = cacheTokens(row);
  const priced = meter.price({ provider: text(row.custom_llm_provider) ?? 'litellm', model, inputTokens: input, outputTokens: output, cacheReadTokens: cache.read, cacheWriteTokens: cache.write });
  const cost = priced.priced ? priced.cost : spend;
  const hash = sha(requestId);
  // The call id is unique in ai_usage: a second row with a reused one keeps it only in the spend log.
  const freeCallId = callId && !db.get('SELECT 1 AS found FROM ai_usage WHERE call_id = ?', callId) ? callId : undefined;
  const done = db.insertNew('ai_usage', {
    id: `au_ll_${hash}`,
    at: new Date(at).toISOString(),
    day: dayOf(at),
    agent_id: who.agentId,
    cache_read_tokens: cache.read,
    cache_write_tokens: cache.write,
    provider: 'litellm',
    model,
    operation: 'chat',
    input_tokens: input,
    output_tokens: output,
    cost,
    call_id: freeCallId,
    gateway_request_id: requestId,
    // On the server's key, so a meter that records after this import can take the row over by its call id.
    ...(freeCallId && serverKey && { gateway_key_hash: serverKey }),
    source: 'litellm',
    runtime: who.runtime,
    project_id: who.projectId,
    gateway_cost: spend,
  });
  if (!done) return false;
  recordUsage(
    {
      id: `ue_ll_${hash}`,
      at: new Date(at).toISOString(),
      kind: 'ai.call',
      ...(who.agentId && { agentId: who.agentId }),
      ...(who.projectId && { projectId: who.projectId }),
      tokens: input + output,
      cost,
      attrs: { provider: 'litellm', model, operation: 'chat', input, output, cacheRead: cache.read, cacheWrite: cache.write, ...(callId && { callId }), requestId, source: 'litellm', runtime: who.runtime, gatewayCost: spend },
    },
    db,
  );
  return true;
}

/** The service: the leader imports every LANDFLOW_LLM_GATEWAY_INGEST_SECONDS (default 300), the first time 20 s after start. */
export const llmGatewayIngest = singleton('llm-gateway-ingest', () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  let running = false;

  const interval = () => envInt('LANDFLOW_LLM_GATEWAY_INGEST_SECONDS', { fallback: 300, min: 30, max: 86_400 }) * 1000;

  async function run() {
    if (running) return;
    running = true;
    try {
      await importSpend();
    } catch (error) {
      logger.warn('llm gateway: the spend import failed', { error: (error as Error).message });
    } finally {
      running = false;
    }
  }

  function arm(delay: number) {
    timer = setTimeout(() => {
      void run().finally(() => {
        if (!stopped) arm(interval());
      });
    }, delay);
    timer.unref?.();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      arm(20_000);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
});
