/**
 * The tool policy port (docs/agents.md "Tool access"): before a run, each tool the agent could use is checked against who is asking.
 * `allow` offers it, `ask` offers it behind a person's approval, `deny` withholds it (the model never sees it).
 *
 * Adapters, chosen by `LANDFLOW_TOOL_POLICY`:
 * - `rules` (default): the agent's own access rules; with none, everything is allowed, as before;
 * - `opa`: Open Policy Agent's data API (`LANDFLOW_TOOL_POLICY_URL` is the rule's URL, e.g. http://opa:8181/v1/data/landflow/tools);
 * - `openfga`: OpenFGA's check API (`LANDFLOW_TOOL_POLICY_URL` is the server, `LANDFLOW_OPENFGA_STORE_ID` the store).
 * The agent's rules always apply as well, and the most restrictive answer wins. If an external engine can't be reached the tool is
 * denied (`LANDFLOW_TOOL_POLICY_FAIL=open` allows it instead).
 */
import { decideByRules, mostRestrictive, type AgentAccess, type Caller, type ToolDecision } from '../../shared/agent-access';
import type { BuiltTool } from './tools';

export interface PolicyRequest {
  caller: Caller;
  agentId: string;
  tool: string;
  kind: string;
}

/** An external engine: answers `allow`, `ask` or `deny`, or throws when it can't. */
export type PolicyEngine = (request: PolicyRequest, signal?: AbortSignal) => Promise<ToolDecision>;

const env = (name: string) => process.env[name]?.trim() ?? '';
const TIMEOUT_MS = 3_000;

async function post(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const token = env('LANDFLOW_TOOL_POLICY_TOKEN');
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`the policy engine answered ${response.status}`);
  return response.json();
}

/** OPA: `{ input }` in, `{ result }` out. The result is `allow` / `ask` / `deny`, or a boolean (true allows). */
export const opaEngine: PolicyEngine = async (request, signal) => {
  const answer = (await post(env('LANDFLOW_TOOL_POLICY_URL'), { input: request }, signal)) as { result?: unknown };
  let result = answer.result;
  // Asked for a package (…/landflow/tools) rather than a rule (…/landflow/tools/result), OPA nests the rule: `{ result: { result } }`.
  if (result && typeof result === 'object' && 'result' in result) result = (result as { result: unknown }).result;
  if (result === true || result === 'allow') return { effect: 'allow' };
  if (result === 'ask') return { effect: 'ask', reason: 'policy: ask' };
  return { effect: 'deny', reason: 'policy: deny' };
};

/** OpenFGA: may the caller use the tool? `user:<id>` — `can_use` — `tool:<agent>/<tool>`. A yes allows; a no denies. */
export const openFgaEngine: PolicyEngine = async (request, signal) => {
  const store = env('LANDFLOW_OPENFGA_STORE_ID');
  if (!store) throw new Error('LANDFLOW_OPENFGA_STORE_ID is not set');
  const url = `${env('LANDFLOW_TOOL_POLICY_URL').replace(/\/+$/, '')}/stores/${encodeURIComponent(store)}/check`;
  const answer = (await post(url, { tuple_key: { user: `user:${request.caller.id}`, relation: 'can_use', object: `tool:${request.agentId}/${request.tool}` } }, signal)) as { allowed?: boolean };
  return answer.allowed ? { effect: 'allow' } : { effect: 'deny', reason: 'policy: not permitted' };
};

/** The engine the environment names, if any. */
export function configuredEngine(): PolicyEngine | undefined {
  const name = env('LANDFLOW_TOOL_POLICY').toLowerCase();
  if (!name || name === 'rules') return undefined;
  if (!env('LANDFLOW_TOOL_POLICY_URL')) throw new Error(`LANDFLOW_TOOL_POLICY=${name} needs LANDFLOW_TOOL_POLICY_URL`);
  if (name === 'opa') return opaEngine;
  if (name === 'openfga') return openFgaEngine;
  throw new Error(`Unknown LANDFLOW_TOOL_POLICY "${name}" (rules, opa or openfga)`);
}

export interface ToolAccess {
  tools: BuiltTool[];
  /** One line per tool that was withheld or now needs approval, for the run's notices. */
  notes: string[];
}

/** The tools this caller may use: denied ones removed, `ask` ones behind approval. Nothing changes without rules or an engine. */
export async function applyToolPolicy(
  tools: BuiltTool[],
  context: { agentId: string; caller: Caller; access: AgentAccess | undefined; engine?: PolicyEngine | undefined; signal?: AbortSignal },
): Promise<ToolAccess> {
  const engine = context.engine === undefined ? configuredEngine() : context.engine;
  if (!context.access?.rules.length && !engine) return { tools, notes: [] };
  const failOpen = env('LANDFLOW_TOOL_POLICY_FAIL').toLowerCase() === 'open';
  const kept: BuiltTool[] = [];
  const notes: string[] = [];
  for (const tool of tools) {
    const decisions = [decideByRules(context.access, context.caller, tool.name)];
    if (engine) {
      try {
        decisions.push(await engine({ caller: context.caller, agentId: context.agentId, tool: tool.name, kind: tool.kind }, context.signal));
      } catch (error) {
        if (!failOpen) decisions.push({ effect: 'deny', reason: `the policy engine could not be reached (${(error as Error).message})` });
      }
    }
    const decision = mostRestrictive(decisions);
    if (decision.effect === 'deny') notes.push(`${tool.label} is not available to you${decision.reason ? ` (${decision.reason})` : ''}`);
    else if (decision.effect === 'ask' && !tool.requireApproval) {
      notes.push(`${tool.label} needs a person's approval for you${decision.reason ? ` (${decision.reason})` : ''}`);
      kept.push({ ...tool, requireApproval: true });
    } else kept.push(tool);
  }
  return { tools: kept, notes };
}
