/**
 * MCP policy hooks (C14), the decision: before an outbound MCP request (a tool call, a resource read, a prompt) the
 * admin's matching hooks are asked allow or deny. `callMcpTool`, `readMcpResource` and `getMcpPrompt` ask here, so no
 * caller (agent tool, MCP Client node, MCP Client Tool, a team member) can skip it.
 *
 * What leaves Landflow: the server URL without userinfo or query, the method and tool, the arguments with secrets
 * redacted and secret-looking keys masked, and ids of the caller. Never a credential value. The call goes through
 * `safeFetch` (the outbound rules apply), is signed with the hook's credential (HMAC by default) and is bounded by its
 * timeout. A service that does not answer 2xx with a valid verdict is a failure, and the hook's failure mode decides.
 * An allow is reused for 60 s for the same call in the same run; a deny or a failure never is.
 */
import { createHash, randomUUID } from 'node:crypto';
import { recordAudit } from '../audit';
import { signature } from '../alerts/channels';
import { activeNode } from '../ai-usage/node-context';
import { currentUsageScope } from '../ai-usage/scope';
import { credentials } from '../credentials/vault';
import { globRegExp, hostMatches } from '../governance/policy';
import { safeFetch } from '../net/safe-fetch';
import { redactValue } from '../secrets/redact';
import { singleton } from '../singleton';
import { logger } from '../telemetry';
import { hostMetrics } from '../telemetry/metrics';
import { maskParams } from '../../shared/approval-inbox';
import { UNAVAILABLE, type McpPolicyHook, type McpPolicyMethod } from '../../shared/mcp-policy';
import { HOOK_CREDENTIAL_TYPE, listPolicyHooks } from './policy-hooks';
import { hookAnswer } from './policy-hooks-schema';

export interface McpCallSubject {
  method: McpPolicyMethod;
  serverUrl: string;
  tool?: string;
  uri?: string;
  prompt?: string;
  args: Record<string, unknown>;
}

/** Who is calling: from the run's usage scope and the node the call runs under. Nothing secret. */
export interface McpCallContext {
  executionId?: string;
  workflowId?: string;
  nodeId?: string;
  nodeName?: string;
  agentId?: string;
  sessionId?: string;
  userId?: string;
  projectId?: string;
}

export type PolicyVerdict = { decision: 'allow'; hooks: string[] } | { decision: 'deny'; hook: string; ruleId?: string; reason: string; failed: boolean };

const ALLOW_MS = 60_000;
const MAX_CACHED = 1_000;
const MAX_ANSWER_BYTES = 64 * 1024;

/** The caller as the usage scope and the active node know it. */
export function callContext(): McpCallContext {
  const scope = currentUsageScope();
  const node = activeNode();
  const pick = <T extends Record<string, string | undefined>>(value: T): McpCallContext => Object.fromEntries(Object.entries(value).filter(([, v]) => v)) as McpCallContext;
  return pick({
    executionId: scope?.lookup('executionId'),
    workflowId: scope?.lookup('workflowId'),
    nodeId: node?.id,
    nodeName: node?.name,
    agentId: scope?.lookup('agentId'),
    sessionId: scope?.lookup('sessionId'),
    userId: scope?.lookup('userId'),
    projectId: scope?.lookup('projectId'),
  });
}

const target = (subject: McpCallSubject) => subject.tool ?? subject.uri ?? subject.prompt ?? '';

/** Whether a hook wants to see this call. No I/O. */
export function matches(hook: McpPolicyHook, subject: McpCallSubject, ctx: McpCallContext): boolean {
  if (!hook.enabled || !hook.match.methods.includes(subject.method)) return false;
  let url: URL;
  try {
    url = new URL(subject.serverUrl);
  } catch {
    return false;
  }
  if (hook.match.hosts.length && !hook.match.hosts.some((pattern) => hostMatches(pattern, url.hostname, url.port))) return false;
  if (hook.match.pathPrefix && !url.pathname.startsWith(hook.match.pathPrefix)) return false;
  if (hook.match.tools.length && !hook.match.tools.some((glob) => globRegExp(glob).test(target(subject)))) return false;
  if (hook.match.projects.length && !(ctx.projectId && hook.match.projects.includes(ctx.projectId))) return false;
  return true;
}

/** The server URL as the service may see it: scheme, host and path, no userinfo or query (they can hold secrets). */
function publicUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  return `${url.origin}${url.pathname}`;
}

/** The request body: what the service decides on. Arguments redacted (known secret values) and masked (secret-looking keys). */
export function hookRequestBody(subject: McpCallSubject, ctx: McpCallContext, extra: { test?: boolean } = {}) {
  const { projectId, ...caller } = ctx;
  return {
    requestId: randomUUID(),
    time: new Date().toISOString(),
    server: { url: publicUrl(subject.serverUrl) },
    method: subject.method,
    ...(subject.tool !== undefined && { tool: subject.tool }),
    ...(subject.uri !== undefined && { uri: subject.uri }),
    ...(subject.prompt !== undefined && { prompt: subject.prompt }),
    arguments: maskParams(redactValue(subject.args)),
    caller,
    ...(projectId && { projectId }),
    ...(extra.test && { test: true }),
  };
}

/** The token of the hook's credential (the key of the signature, or the bearer). Throws when it can't be read. */
async function hookToken(hook: McpPolicyHook): Promise<string> {
  const data = await credentials.dataWithSecrets({ id: hook.credentialId ?? '', name: `of policy hook "${hook.name}"` }, HOOK_CREDENTIAL_TYPE);
  const token = String(data.token ?? '');
  if (!token) throw new Error('The hook’s credential has no token');
  return token;
}

export interface HookAnswerResult {
  ok: boolean;
  decision?: 'allow' | 'deny';
  reason?: string;
  ruleId?: string;
  status?: number;
  error?: string;
  ms: number;
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('the answer is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One request to one hook; never throws: the outcome says why it failed. */
export async function askHook(hook: McpPolicyHook, body: object, signal?: AbortSignal): Promise<HookAnswerResult> {
  const started = Date.now();
  const ms = () => Date.now() - started;
  try {
    const text = JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Landflow-MCP-Policy/1' };
    if (hook.auth !== 'none') {
      const token = await hookToken(hook);
      if (hook.auth === 'bearer') headers.authorization = `Bearer ${token}`;
      else {
        const timestamp = String(Math.floor(Date.now() / 1000));
        headers['x-landflow-timestamp'] = timestamp;
        headers['x-landflow-signature'] = signature(token, timestamp, text);
      }
    }
    const timeout = AbortSignal.timeout(hook.timeoutMs);
    const response = await safeFetch(hook.url, { method: 'POST', headers, body: text, redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, status: response.status, error: `answered HTTP ${response.status}`, ms: ms() };
    }
    let json: unknown;
    try {
      json = JSON.parse(await readCapped(response));
    } catch {
      return { ok: false, status: response.status, error: 'the answer is not valid JSON', ms: ms() };
    }
    const parsed = hookAnswer.safeParse(json);
    if (!parsed.success) return { ok: false, status: response.status, error: 'the answer is not { decision: "allow" | "deny" }', ms: ms() };
    return { ok: true, status: response.status, ...parsed.data, ms: ms() };
  } catch (error) {
    const timedOut = (error as Error).name === 'TimeoutError';
    const cause = (error as Error & { cause?: Error }).cause?.message ?? (error as Error).message;
    return { ok: false, error: timedOut ? `no answer within ${hook.timeoutMs} ms` : cause, ms: ms() };
  }
}

// ---------------------------------------------------------------------------
// The allow cache: per process, per run
// ---------------------------------------------------------------------------

const allowed = () => singleton('mcp-policy-allow-cache', () => new Map<string, number>());

export function resetPolicyCache() {
  allowed().clear();
}

/** The key of one hook's allow: the hook, the call (arguments hashed as given) and the caller. */
function cacheKey(hook: McpPolicyHook, subject: McpCallSubject, ctx: McpCallContext): string {
  const args = createHash('sha256').update(JSON.stringify(subject.args ?? {})).digest('hex');
  return [hook.id, hook.updatedAt, subject.method, target(subject), publicUrl(subject.serverUrl), args, ctx.executionId, ctx.workflowId, ctx.nodeId, ctx.agentId, ctx.userId].join('|');
}

function remember(key: string) {
  const cache = allowed();
  const now = Date.now();
  if (cache.size >= MAX_CACHED) {
    for (const [k, until] of cache) if (until <= now) cache.delete(k);
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
  }
  cache.set(key, now + ALLOW_MS);
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

type HookOutcome = { hook: McpPolicyHook; kind: 'allow' } | { hook: McpPolicyHook; kind: 'deny'; reason: string; ruleId?: string } | { hook: McpPolicyHook; kind: 'failed'; error: string };

async function decide(hook: McpPolicyHook, subject: McpCallSubject, ctx: McpCallContext, signal?: AbortSignal): Promise<HookOutcome & { cached?: boolean }> {
  const key = ctx.executionId ? cacheKey(hook, subject, ctx) : undefined;
  if (key && (allowed().get(key) ?? 0) > Date.now()) return { hook, kind: 'allow', cached: true };
  const answer = await askHook(hook, hookRequestBody(subject, ctx), signal);
  if (!answer.ok) return { hook, kind: 'failed', error: answer.error ?? 'no answer' };
  if (answer.decision === 'deny') return { hook, kind: 'deny', reason: answer.reason?.trim() || 'denied', ...(answer.ruleId && { ruleId: answer.ruleId }) };
  if (key) remember(key);
  return { hook, kind: 'allow' };
}

/** What each outcome leaves behind: a check on the call's span, a count, and an audit event for a deny or a failure. */
function record(outcome: HookOutcome, subject: McpCallSubject, ctx: McpCallContext) {
  const { hook } = outcome;
  const name = target(subject);
  const ruleId = outcome.kind === 'deny' ? outcome.ruleId : undefined;
  const failedClosed = outcome.kind === 'failed' && hook.failureMode === 'closed';
  const label = outcome.kind === 'allow' ? 'allow' : outcome.kind === 'deny' ? 'deny' : failedClosed ? 'failed_closed' : 'failed_open';
  hostMetrics().mcpPolicyDecisions.add(1, { decision: label, hook: hook.name });
  const status = outcome.kind === 'allow' ? 'pass' : failedClosed ? 'fail' : 'warn';
  const message = outcome.kind === 'allow' ? `Allowed by ${hook.name}` : outcome.kind === 'deny' ? `Denied by ${hook.name}: ${outcome.reason}` : `${hook.name}: ${UNAVAILABLE} (${outcome.error}); the call ${failedClosed ? 'was blocked' : 'went ahead'}`;
  try {
    activeNode()?.report?.({ type: 'check', name: 'policy', status, message, subject: name, evidence: { hook: hook.name, decision: label, ...(ruleId && { ruleId }) } });
  } catch {
    // A report that can't be stored never changes the decision.
  }
  logger.info('mcp policy decision', { hook: hook.id, decision: label, method: subject.method, ...(ctx.executionId && { executionId: ctx.executionId }) });
  if (outcome.kind === 'allow') return;
  const host = new URL(subject.serverUrl).host;
  recordAudit({
    action: outcome.kind === 'deny' ? 'mcp.policy.denied' : 'mcp.policy.failed',
    outcome: outcome.kind === 'deny' || failedClosed ? 'denied' : 'success',
    actor: ctx.userId ? { id: ctx.userId } : 'system',
    target: { type: 'mcp-server', id: host, name: host },
    project: ctx.projectId ?? null,
    summary: outcome.kind === 'deny' ? `Policy hook “${hook.name}” blocked ${name || subject.method} on ${host}` : `Policy hook “${hook.name}” did not answer for ${name || subject.method} on ${host}; the call ${failedClosed ? 'was blocked' : 'went ahead'}`,
    details: { hook: hook.name, hookId: hook.id, method: subject.method, tool: name, ...(ruleId && { ruleId }), ...(outcome.kind === 'failed' && { error: outcome.error, failureMode: hook.failureMode }), ...(ctx.executionId && { executionId: ctx.executionId }) },
  });
}

/**
 * Ask every matching hook (in parallel) about one outbound MCP call. All must allow; the first deny in hook order wins.
 * With no hook configured this is one cached read.
 */
export async function checkMcpCall(subject: McpCallSubject, ctx: McpCallContext = callContext(), signal?: AbortSignal): Promise<PolicyVerdict> {
  const hooks = listPolicyHooks().filter((hook) => matches(hook, subject, ctx));
  if (!hooks.length) return { decision: 'allow', hooks: [] };
  const outcomes = await Promise.all(hooks.map((hook) => decide(hook, subject, ctx, signal)));
  for (const outcome of outcomes) record(outcome, subject, ctx);
  for (const outcome of outcomes) {
    if (outcome.kind === 'deny') return { decision: 'deny', hook: outcome.hook.name, reason: outcome.reason, ...(outcome.ruleId && { ruleId: outcome.ruleId }), failed: false };
    if (outcome.kind === 'failed' && outcome.hook.failureMode === 'closed') return { decision: 'deny', hook: outcome.hook.name, reason: UNAVAILABLE, failed: true };
  }
  return { decision: 'allow', hooks: hooks.map((hook) => hook.name) };
}
