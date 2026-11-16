/**
 * The gateway's split of a model call (docs/llm-gateway.md, "The gateway's split"): the LiteLLM callback
 * `deploy/llm-gateway/custom_callbacks.py` posts the parts of each call it saw, in tokens, with keyed hashes, under the
 * gateway's response id. This file verifies the post (an HMAC under LANDFLOW_LLM_GATEWAY_PARTS_SECRET), checks it holds
 * only numbers and hashes, and stores one `ai_call_parts` row with `source = 'gateway'`.
 *
 * Never text: the body's key set is closed and every string is short, so prompt text can't arrive by mistake. The parts
 * are for display only, never for money, caps or attribution. A Landflow split for the same call wins, in every order the
 * writers can arrive in (contract `gateway-parts-api.md`, "Stored").
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { PROMPT_PARTS } from '../../shared/ai-call-parts';
import { envWithAliases } from '../config';
import { database, type Database } from '../db';

export const PARTS_SECRET_ENV = 'LANDFLOW_LLM_GATEWAY_PARTS_SECRET';
export const MAX_PARTS_BODY_BYTES = 32 * 1024;
/** How far a signature's time may be from now, in seconds. */
export const SIGNATURE_WINDOW_SECONDS = 300;

/** The secret the gateway signs with; undefined means the route does not exist (404). */
export const partsSecret = (): string | undefined => envWithAliases(PARTS_SECRET_ENV);

/** True when `header` (`t=<unix seconds>,v1=<hex>`) signs `rawBody` under `secret` and is not older or newer than 300 s. */
export function verifySignature(header: string | null, rawBody: string, secret: string, now = Date.now()): boolean {
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!match) return false;
  const [, t, given] = match as unknown as [string, string, string];
  if (Math.abs(now / 1000 - Number(t)) > SIGNATURE_WINDOW_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const actual = Buffer.from(given, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const hash = z.string().regex(/^[0-9a-f]{16}$/);
const shortString = z.string().min(1).max(200);
const tokens = z.number().int().min(0).max(1_000_000_000);
const partKey = z.enum(PROMPT_PARTS);

/** The closed body: any other key is a 400. */
export const gatewayPartsSchema = z
  .object({
    requestId: shortString,
    at: z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), 'not a time'),
    model: shortString,
    provider: shortString,
    method: z.enum(['provider', 'tokenizer', 'estimate']),
    inputTokens: tokens,
    parts: z.partialRecord(partKey, tokens),
    prefixHash: hash.optional(),
    promptHash: hash.optional(),
    partHashes: z.partialRecord(partKey, hash).optional(),
    toolNames: z.array(shortString).max(200).optional(),
  })
  .strict();
export type GatewayPartsBody = z.infer<typeof gatewayPartsSchema>;

/**
 * Store one gateway split. No-op when a row holds the request id, or when the `ai_usage` row of that request id has a
 * Landflow split of its own. `usage_id` is filled when the `ai_usage` row exists. Returns whether a row was written.
 */
export function storeGatewayParts(body: GatewayPartsBody, db: Database = database()): boolean {
  if (db.get('SELECT 1 AS found FROM ai_call_parts WHERE gateway_request_id = ?', body.requestId)) return false;
  const usage = db.get<{ id: string }>('SELECT id FROM ai_usage WHERE gateway_request_id = ?', body.requestId);
  if (usage && db.get('SELECT 1 AS found FROM ai_call_parts WHERE usage_id = ?', usage.id)) return false;
  const parts = Object.fromEntries(Object.entries(body.parts).filter(([, n]) => (n ?? 0) > 0));
  return db.insertNew('ai_call_parts', {
    id: `acp_${nanoid(14)}`,
    usage_id: usage?.id ?? null,
    gateway_request_id: body.requestId,
    at: new Date(body.at).toISOString(),
    source: 'gateway',
    method: body.method,
    input_tokens: body.inputTokens,
    parts: JSON.stringify(parts),
    prefix_hash: body.prefixHash ?? null,
    prompt_hash: body.promptHash ?? null,
    part_hashes: JSON.stringify(body.partHashes ?? {}),
    tool_names: body.toolNames?.length ? JSON.stringify(body.toolNames) : null,
  });
}

/**
 * The spend import's side (`importRow`): a gateway split may be waiting under `requestId` for the `ai_usage` row `usageId`.
 * Fill its `usage_id`; when the row already has a split of its own (Landflow's), drop the waiting gateway split instead,
 * so the unique index on `usage_id` never fires.
 */
export function attachWaitingParts(usageId: string, requestId: string, db: Database = database()): void {
  const waiting = db.get<Record<string, string | number | null> & { id: string; usage_id: string | null }>("SELECT * FROM ai_call_parts WHERE gateway_request_id = ? AND source = 'gateway'", requestId);
  if (!waiting || waiting.usage_id === usageId) return;
  if (db.get('SELECT 1 AS found FROM ai_call_parts WHERE usage_id = ?', usageId)) db.delete('ai_call_parts', { id: waiting.id });
  else db.upsert('ai_call_parts', { ...waiting, usage_id: usageId });
}
