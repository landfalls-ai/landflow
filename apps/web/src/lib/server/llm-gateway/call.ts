/**
 * Landflow's own calls through the LLM gateway (docs/llm-gateway.md, "Point Landflow at it"): the headers that say who
 * is calling, the call id and cost the gateway answers with, and the budget refusal shown as a cap.
 */
import { nanoid } from 'nanoid';
import { LITELLM_IDS, LITELLM_TAGS, type AiRuntime, type LandflowSpendMetadata, type LlmGatewaySettings } from '../../shared/llm-gateway';
import { envString } from '../config';
import { safeFetch } from '../net/safe-fetch';
import { homeProjectId } from '../projects/store';
import { UsageCapError, type UsageScope } from '../ai-usage/scope';
import { gatewayRoot } from './settings';

/** The request header a caller sets to find the reply of its own call again (removed before the request is sent). */
export const GATEWAY_CALL_HEADER = 'x-landflow-gateway-call';

type Lookup = Pick<UsageScope, 'lookup'>;

/** The Landflow project a call belongs to: the scope's own, else its agent's or workflow's home project. */
export function scopeProjectId(scope: Lookup | undefined): string | undefined {
  if (!scope) return undefined;
  const explicit = scope.lookup('projectId');
  if (explicit) return explicit;
  const agentId = scope.lookup('agentId');
  if (agentId) return homeProjectId('agent', agentId);
  const workflowId = scope.lookup('workflowId');
  return workflowId ? homeProjectId('workflow', workflowId) : undefined;
}

/** Header values are ASCII only: anything else is dropped. */
const ascii = (value: string) => value.replace(/[^\x20-\x7e]/g, '').trim();

/**
 * The headers LiteLLM reads to tell who is calling: the end user (a person), tags (project, agent, workflow, surface,
 * runtime), the spend-log metadata (marked `in-process`, so the spend import skips what Landflow's meter counted), and
 * the trace id. Ids only, never names or emails. The Customer Portal headers only with `portalHeaders`.
 */
export function gatewayHeaders(scope: Lookup | undefined, settings: Pick<LlmGatewaySettings, 'portalHeaders'>, runtime: AiRuntime = 'landflow'): Record<string, string> {
  const userId = scope?.lookup('userId');
  const agentId = scope?.lookup('agentId');
  const workflowId = scope?.lookup('workflowId');
  const executionId = scope?.lookup('executionId');
  const sessionId = scope?.lookup('sessionId');
  const surface = scope?.lookup('surface');
  const projectId = scopeProjectId(scope);
  const tags = [
    LITELLM_TAGS.base,
    ...(projectId ? [LITELLM_TAGS.project(projectId)] : []),
    ...(agentId ? [LITELLM_TAGS.agent(agentId)] : []),
    ...(workflowId ? [LITELLM_TAGS.workflow(workflowId)] : []),
    ...(surface ? [LITELLM_TAGS.surface(surface)] : []),
    LITELLM_TAGS.runtime(runtime),
  ];
  const metadata: LandflowSpendMetadata = {
    landflow: 'in-process',
    runtime,
    ...(projectId && { project: projectId }),
    ...(agentId && { agent: agentId }),
    ...(workflowId && { workflow: workflowId }),
    ...(executionId && { execution: executionId }),
    ...(sessionId && { session: sessionId }),
    ...(surface && { surface }),
  };
  const trace = executionId ?? sessionId;
  const headers: Record<string, string> = {
    ...(userId && { 'x-litellm-end-user-id': LITELLM_IDS.customer(userId) }),
    'x-litellm-tags': tags.join(','),
    'x-litellm-spend-logs-metadata': JSON.stringify(metadata),
    ...(trace && { 'x-litellm-trace-id': trace }),
    ...(settings.portalHeaders && projectId && { 'x-litellm-customer-org-alias': LITELLM_IDS.portalOrg(projectId) }),
    ...(settings.portalHeaders && userId && { 'x-litellm-customer-member-id': LITELLM_IDS.customer(userId) }),
  };
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, ascii(value)]).filter(([, value]) => value));
}

// ---- the gateway's reply: call id and cost -------------------------------------------------------------------------

/** What the gateway said about one call. */
export interface GatewayReply {
  callId?: string;
  /** `x-litellm-response-cost`, dollars. */
  cost?: number;
}

const REPLY_TTL_MS = 10 * 60_000;
const replies = new Map<string, { at: number; reply: GatewayReply }>();

/** The call id and cost in a response's headers. */
export function gatewayReplyOf(headers: Headers): GatewayReply {
  const callId = headers.get('x-litellm-call-id')?.trim();
  const raw = headers.get('x-litellm-response-cost');
  const cost = raw !== null && raw.trim() !== '' ? Number(raw) : undefined;
  return { ...(callId && { callId }), ...(cost !== undefined && Number.isFinite(cost) && cost >= 0 && { cost }) };
}

function remember(id: string, reply: GatewayReply) {
  const now = Date.now();
  for (const [key, entry] of replies) if (now - entry.at > REPLY_TTL_MS) replies.delete(key);
  replies.set(id, { at: now, reply });
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The address policy applies to the gateway's URL like any other outbound call. */
const guarded: Fetch = (input, init) => safeFetch(input, init, { span: false });

/**
 * A fetch for an SDK client: a caller passes a per-call id in `x-landflow-gateway-call`; the wrapper removes that header,
 * sends the request, and keeps the response's call id and cost under the id for `takeGatewayReply`.
 */
export function captureGatewayReply(fetcher: Fetch = guarded): Fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const id = headers.get(GATEWAY_CALL_HEADER);
    headers.delete(GATEWAY_CALL_HEADER);
    const response = await fetcher(input, { ...init, headers });
    if (id) remember(id, gatewayReplyOf(response.headers));
    return response;
  };
}

/** A fresh id for one call (the value of `x-landflow-gateway-call`). */
export const newGatewayCallId = () => nanoid(12);

/** The reply kept for a call id, forgotten on the way. */
export function takeGatewayReply(id: string): GatewayReply {
  const entry = replies.get(id);
  replies.delete(id);
  return entry?.reply ?? {};
}

/**
 * Whether a gateway-reported cost may count in caps and totals: only for the gateway the server itself is configured with
 * (LANDFLOW_LLM_GATEWAY_URL). A gateway named only by a credential could be a fake one that under-reports, so its cost is
 * shown as "gateway says" and Landflow's own price table stays in charge.
 */
export function trustsGatewayCost(baseUrl: string): boolean {
  const configured = envString('LANDFLOW_LLM_GATEWAY_URL');
  return Boolean(configured && gatewayRoot(configured).toLowerCase() === gatewayRoot(baseUrl).toLowerCase());
}

// ---- a spent budget is a cap -----------------------------------------------------------------------------------------

const BUDGET = /budget_exceeded|budget has been exceeded|exceededbudget|exceededtokenbudget|max budget/i;

/**
 * When LiteLLM refused a call because a budget is spent (400 or 429), a UsageCapError that names the gateway, so Spotlight
 * and runs show it as a cap and not as a crash. Anything else: undefined.
 */
export function gatewayBudgetError(error: unknown): UsageCapError | undefined {
  const { status, message, description, error: body } = (error ?? {}) as { status?: number; message?: string; description?: string; error?: unknown };
  if (status !== 400 && status !== 429) return undefined;
  const text = [message, description, typeof body === 'string' ? body : body ? JSON.stringify(body) : ''].filter(Boolean).join(' ');
  if (!BUDGET.test(text)) return undefined;
  const who = /end user=([^\s,]+)/i.exec(text)?.[1] ?? '';
  const team = /team=([^\s,]+)/i.exec(text)?.[1] ?? '';
  const subject = who ? `customer ${who}` : team ? `team ${team}` : /token/i.test(text) ? 'the key' : 'this caller';
  const limit = { metric: 'cost' as const, max: 0, subject, setIn: 'Insights → AI', used: () => 0 };
  return new UsageCapError(limit, 0, `The LLM gateway stopped the call: the budget of ${subject} is spent. Ask for a higher cap on Insights → AI.`);
}
