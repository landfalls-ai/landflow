import { error, handler } from '@/lib/server/http';
import { gatewayPartsSchema, MAX_PARTS_BODY_BYTES, partsSecret, storeGatewayParts, verifySignature } from '@/lib/server/llm-gateway/parts-receiver';

/**
 * POST /api/gateway-parts: the LLM gateway's split of one model call (parts in tokens and keyed hashes, never text), from
 * the LiteLLM callback `deploy/llm-gateway/custom_callbacks.py` (docs/llm-gateway.md, "The gateway's split"). Public: the
 * `x-landflow-signature` HMAC under LANDFLOW_LLM_GATEWAY_PARTS_SECRET is the credential. 204 stored (or already stored);
 * 400 a body with any key outside the contract or a long string; 401 a bad or old signature; 404 when the secret is not set.
 */
export const POST = handler(async (request: Request) => {
  const secret = partsSecret();
  if (!secret) return error('Not found', 404);
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PARTS_BODY_BYTES) return error('Request body too large', 413);
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_PARTS_BODY_BYTES) return error('Request body too large', 413);
  if (!verifySignature(request.headers.get('x-landflow-signature'), raw, secret)) return error('Invalid signature', 401);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return error('Request body must be JSON', 400);
  }
  const parsed = gatewayPartsSchema.safeParse(body);
  if (!parsed.success) return error('Invalid request', 400, { code: 'invalid_request', issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path, code: i.code })) });
  storeGatewayParts(parsed.data);
  return new Response(null, { status: 204 });
});
