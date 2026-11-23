/**
 * What each chat call's prompt was made of (docs/llm-gateway.md#what-a-prompt-was-made-of): the parts in tokens and
 * their keyed hashes, written to `ai_call_parts` after the meter records the call. Wave 11 writes an estimate
 * (characters ÷ 4 per part, scaled to the reported input); wave 12 makes it exact with the same row and draft.
 *
 * Never text: the draft lives in memory for the length of one call; only sizes, token counts and hashes are stored
 * (constitution note 17). Nothing here throws or logs prompt text.
 */
import { createHmac } from 'node:crypto';
import { nanoid } from 'nanoid';
import { PROMPT_PARTS, type CallParts, type PromptPart } from '../../shared/ai-call-parts';
import { envWithAliases } from '../config';
import { credentials } from '../credentials/vault';
import { database, type Database } from '../db';
import { logger } from '../telemetry/logger';
import type { PromptDraft, RecordedCall } from './call-context';
import { countParts, type CountedParts } from './count';

const DAY_MS = 86_400_000;
/** An image's share of the input in an estimate: the order of an Anthropic image. */
export const ESTIMATED_IMAGE_TOKENS = 1600;

/** Days splits are kept: LANDFLOW_AI_CALL_PARTS_RETENTION_DAYS, default 30. */
export const aiCallPartsRetentionDays = (): number => Number(envWithAliases('LANDFLOW_AI_CALL_PARTS_RETENTION_DAYS')) || 30;

/**
 * The parts of `inputTokens`, an estimate: each part's characters ÷ 4 (images a fixed 1,600 each), scaled so the
 * parts sum to `inputTokens` exactly. Integers; the rounding remainder goes to the largest part. `formatting` is 0
 * (only an exact count can tell it apart), and a segment of the `formatting` part (the date stamp) is not counted.
 * A draft with nothing to count gives `{}` (no part is invented for the input).
 */
export function estimateParts(draft: PromptDraft, inputTokens: number): Partial<Record<PromptPart, number>> {
  const total = Math.max(0, Math.floor(inputTokens));
  if (total === 0) return {};
  const weights: Partial<Record<PromptPart, number>> = {};
  for (const segment of draft.segments) {
    if (segment.text.length && segment.part !== 'formatting') weights[segment.part] = (weights[segment.part] ?? 0) + segment.text.length / 4;
  }
  if (draft.images && draft.images > 0) weights.images = (weights.images ?? 0) + draft.images * ESTIMATED_IMAGE_TOKENS;
  const entries = PROMPT_PARTS.filter((part) => (weights[part] ?? 0) > 0).map((part) => [part, weights[part] as number] as const);
  const sum = entries.reduce((n, [, w]) => n + w, 0);
  if (!entries.length || sum <= 0) return {};
  const parts: Partial<Record<PromptPart, number>> = {};
  let assigned = 0;
  let largest: PromptPart = entries[0]![0];
  for (const [part, weight] of entries) {
    const tokens = Math.floor((weight / sum) * total);
    parts[part] = tokens;
    assigned += tokens;
    if (weight > (weights[largest] ?? 0)) largest = part;
  }
  parts[largest] = (parts[largest] ?? 0) + (total - assigned);
  for (const part of Object.keys(parts) as PromptPart[]) if (!parts[part]) delete parts[part];
  return parts;
}

// SP22: exact counts become a split (the estimate above stays the fallback).
/**
 * A counted draft as a split of `inputTokens`: what was counted per part, `formatting` = the reported input minus every
 * other part (the provider's roles and templates, the run's date stamp), never negative. When the counted parts add up
 * to more than the reported input, they are scaled down to it and `formatting` is 0 (a call's parts always sum to its
 * input). Images are not counted from text: a fixed estimate each, and a call with images is an `estimate` (the
 * weakest method any part used).
 */
export function countedSplit(counted: CountedParts, draft: PromptDraft, inputTokens: number): Pick<CallParts, 'method' | 'parts'> {
  const total = Math.max(0, Math.floor(inputTokens));
  const weights: Partial<Record<PromptPart, number>> = { ...counted.parts };
  let method: CallParts['method'] = counted.method;
  if (draft.images && draft.images > 0) {
    weights.images = (weights.images ?? 0) + draft.images * ESTIMATED_IMAGE_TOKENS;
    method = 'estimate';
  }
  const entries = PROMPT_PARTS.filter((part) => (weights[part] ?? 0) > 0).map((part) => [part, weights[part] as number] as const);
  const sum = entries.reduce((n, [, w]) => n + w, 0);
  const parts: Partial<Record<PromptPart, number>> = {};
  if (sum <= total) {
    for (const [part, w] of entries) parts[part] = w;
    if (total > sum) parts.formatting = total - sum;
    return { method, parts };
  }
  let assigned = 0;
  let largest: PromptPart | undefined;
  for (const [part, w] of entries) {
    const tokens = Math.floor((w / sum) * total);
    parts[part] = tokens;
    assigned += tokens;
    if (!largest || w > (weights[largest] ?? 0)) largest = part;
  }
  if (largest) parts[largest] = (parts[largest] ?? 0) + (total - assigned);
  for (const part of Object.keys(parts) as PromptPart[]) if (!parts[part]) delete parts[part];
  return { method, parts };
}

/** HMAC-SHA-256 over length-prefixed fields, first 16 hex: no two different field lists hash the same input. */
function digest(key: Buffer, fields: string[]): string {
  const mac = createHmac('sha256', key);
  for (const field of fields) mac.update(`${Buffer.byteLength(field)}:`).update(field);
  return mac.digest('hex').slice(0, 16);
}

export interface PartHashes {
  prefixHash: string;
  promptHash: string;
  partHashes: Partial<Record<PromptPart, string>>;
  toolNames?: string[];
}

/**
 * Keyed hashes of a draft: `promptHash` over every segment but `formatting` in order with its `where`; `prefixHash` over the segments
 * up to the last one marked `breakpoint` (else the tools and the system prompt); `partHashes` per part, over the
 * texts of that part's segments joined in order as one string (so a counter that holds the part whole, as the gateway's
 * callback does, gets the same hash); `formatting` and `images` have none: a prompt's date stamp is a `formatting`
 * segment, so it changes neither `promptHash` nor the instructions' hash: two runs of one prompt stamped to the
 * millisecond still hash alike, which is what repeated-call detection needs. For an agent run the stamp sits after the
 * cache break, so it is not in `prefixHash` either.
 */
export function hashParts(draft: PromptDraft, key: Buffer): PartHashes {
  const field = (s: { where: string; part: string; text: string }) => [s.where, s.part, s.text];
  const lastBreak = draft.segments.reduce((at, s, i) => (s.breakpoint ? i : at), -1);
  const prefix = lastBreak >= 0 ? draft.segments.slice(0, lastBreak + 1) : draft.segments.filter((s) => s.where !== 'messages');
  const byPart = new Map<PromptPart, string[]>();
  for (const s of draft.segments) {
    if (s.part === 'formatting' || s.part === 'images' || !s.text) continue;
    byPart.set(s.part, [...(byPart.get(s.part) ?? []), s.text]);
  }
  const partHashes: Partial<Record<PromptPart, string>> = {};
  for (const part of PROMPT_PARTS) {
    const texts = byPart.get(part);
    if (texts) partHashes[part] = digest(key, [texts.join('')]);
  }
  return {
    prefixHash: digest(key, prefix.flatMap(field)),
    promptHash: digest(key, [...draft.segments.filter((s) => s.part !== 'formatting').flatMap(field), `images:${draft.images ?? 0}`]),
    partHashes,
    ...(draft.toolNames?.length && { toolNames: [...draft.toolNames] }),
  };
}

/** Hashes need the vault's key; a vault that can't give one means no hashes, never a failed call. */
const hashKey = (): Buffer => credentials.deriveKey('ai-call-parts');

/** The split of one recorded chat call, as it is stored. Pure over the draft and the key. */
export function splitCall(call: Pick<RecordedCall, 'usageId' | 'at' | 'inputTokens' | 'gatewayRequestId'>, draft: PromptDraft, key: Buffer, counted?: CountedParts): CallParts {
  const hashes = hashParts(draft, key);
  const split = counted ? countedSplit(counted, draft, call.inputTokens) : { method: 'estimate' as const, parts: estimateParts(draft, call.inputTokens) };
  return {
    usageId: call.usageId,
    ...(call.gatewayRequestId && { gatewayRequestId: call.gatewayRequestId }),
    at: call.at,
    source: 'landflow',
    method: split.method,
    inputTokens: call.inputTokens,
    parts: split.parts,
    prefixHash: hashes.prefixHash,
    promptHash: hashes.promptHash,
    partHashes: hashes.partHashes,
    ...(hashes.toolNames && { toolNames: hashes.toolNames }),
  };
}

/**
 * The recorded-call listener (`setRecordedCallListener(writeParts)`): for a chat call that took a draft, writes its
 * split after the meter has returned. Never throws; drops the draft reference when done.
 */
export function writeParts(recorded: RecordedCall): void {
  let draft: PromptDraft | undefined = recorded.note.draft;
  if (recorded.operation !== 'chat' || !draft || !(recorded.inputTokens > 0)) return;
  const call = { usageId: recorded.usageId, at: recorded.at, inputTokens: recorded.inputTokens, ...(recorded.gatewayRequestId && { gatewayRequestId: recorded.gatewayRequestId }) };
  // The handle is the one in force now, not whatever the singleton is when the callback runs (a test or a restart may swap it);
  // SP22: it is kept through the async counting, which reads the call's `ai_usage` row and writes the split through it.
  const db = database();
  setImmediate(() => {
    void (async () => {
      try {
        const key = hashKey();
        // SP22: an exact count first (a provider's, or the model's own tokenizer); any failure leaves the estimate.
        const counted = await countParts(draft as PromptDraft, { usageId: call.usageId, provider: recorded.provider, model: recorded.model, ...(recorded.agentId && { agentId: recorded.agentId }), db, key: credentials.deriveKey('ai-call-parts-count') });
        const parts = splitCall(call, draft as PromptDraft, key, counted);
        const existing = db.get<{ id: string }>('SELECT id FROM ai_call_parts WHERE usage_id = ?', call.usageId);
        // SP22: the gateway's split of this call (source 'gateway', same response id) is replaced by Landflow's own.
        if (parts.gatewayRequestId) {
          const gateway = db.get<{ id: string }>("SELECT id FROM ai_call_parts WHERE gateway_request_id = ? AND source = 'gateway'", parts.gatewayRequestId);
          if (gateway && gateway.id !== existing?.id) db.delete('ai_call_parts', { id: gateway.id });
        }
        db.upsert('ai_call_parts', {
          id: existing?.id ?? `acp_${nanoid(14)}`,
          usage_id: call.usageId,
          gateway_request_id: parts.gatewayRequestId ?? null,
          at: parts.at,
          source: parts.source,
          method: parts.method,
          input_tokens: parts.inputTokens,
          parts: JSON.stringify(parts.parts),
          prefix_hash: parts.prefixHash ?? null,
          prompt_hash: parts.promptHash ?? null,
          part_hashes: JSON.stringify(parts.partHashes ?? {}),
          tool_names: parts.toolNames ? JSON.stringify(parts.toolNames) : null,
        });
      } catch (error) {
        logger.warn('could not write the parts of a model call', { error: (error as Error).message });
      } finally {
        draft = undefined;
      }
    })();
  });
}

/** Deletes splits older than the retention; the meter calls it with its own hourly prune. */
export function pruneParts(now = Date.now(), db: Database = database(), days = aiCallPartsRetentionDays()): number {
  return db.deleteBefore('ai_call_parts', 'at', new Date(now - days * DAY_MS).toISOString());
}

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

/** One call's split by its `ai_usage` row id (wave 12 reads it; the caller checks access to the row first). */
export function callParts(usageId: string): CallParts | undefined {
  const row = database().get<PartsRow>('SELECT * FROM ai_call_parts WHERE usage_id = ?', usageId);
  if (!row) return undefined;
  const partHashes = row.part_hashes ? (JSON.parse(row.part_hashes) as Partial<Record<PromptPart, string>>) : undefined;
  return {
    ...(row.usage_id && { usageId: row.usage_id }),
    ...(row.gateway_request_id && { gatewayRequestId: row.gateway_request_id }),
    at: row.at,
    source: row.source as CallParts['source'],
    method: row.method as CallParts['method'],
    inputTokens: Number(row.input_tokens),
    parts: JSON.parse(row.parts) as CallParts['parts'],
    ...(row.prefix_hash && { prefixHash: row.prefix_hash }),
    ...(row.prompt_hash && { promptHash: row.prompt_hash }),
    ...(partHashes && Object.keys(partHashes).length && { partHashes }),
    ...(row.tool_names && { toolNames: JSON.parse(row.tool_names) as string[] }),
  };
}
