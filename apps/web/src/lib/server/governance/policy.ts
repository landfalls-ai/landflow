/**
 * Instance governance policy (Settings → Governance): which node types workflows and agents may use (by type id or
 * plugin, an allow-list or a block-list, plus "block Code nodes"), which hosts the HTTP Request node may call, and
 * which MCP servers the MCP Client node, the MCP Client Tool and agents may connect to. Four-eyes publishing lives
 * in the same document (./approvals). Everything is off by default, and with it off nothing behaves differently.
 *
 * Enforced in three places:
 * - **save**: PUT/POST of a workflow answer `policyWarnings` (the save goes through; importers report blocked nodes);
 * - **publish**: `publishVersion()` refuses a version with violations (`assertPublishable`, a 422);
 * - **run**: the registry wraps every resolved node type (`withGovernance`), so a blocked node fails with a clear
 *   error whatever started the run (editor, trigger, schedule, agent, sub-workflow, a queue worker), an HTTP Request
 *   to a blocked host fails per call, and `endpointFrom()` (lib/server/mcp/client.ts) refuses MCP URLs not allowed.
 *
 * Static checks look at parameters that aren't expressions; run-time checks see the resolved values. The policy is
 * one JSON document under the `governance` key of the `settings` table, re-read at most once a second, so a change
 * reaches every process (hosts and workers) at once. Plain server module: no Next.js imports.
 */
import { splitType } from '@landflow/protocol';
import type { ExecuteResponse } from '@landflow/protocol';
import type { ResolvedNodeType, Workflow, WorkflowNode } from '@landflow/engine';
import { z } from 'zod';
import { DEFAULT_GOVERNANCE_POLICY, type GovernancePolicy, type PolicyViolation } from '../../shared/governance';
import { database } from '../db';
import { parse } from '../db/rows';
import { singleton } from '../singleton';

export const GOVERNANCE_SETTINGS_KEY = 'governance';

/** Node types that run arbitrary code ("Block Code nodes"). */
export const CODE_NODE_NAMES = new Set(['code', 'function', 'functionItem', 'executeCommand', 'pythonCode']);
export const HTTP_REQUEST_TYPE = 'core.httpRequest';
export const MCP_NODE_TYPES = new Set(['core.mcpClient', 'core.mcpClientTool']);

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly violations: PolicyViolation[] = [],
    readonly status = 422,
  ) {
    super(message);
  }
}

const pattern = z.string().trim().min(1).max(300);
const list = z.array(pattern).max(500);

export const governanceSchema = z.strictObject({
  nodes: z.strictObject({ mode: z.enum(['off', 'allow', 'block']), types: list, plugins: list, blockCode: z.boolean() }),
  http: z.strictObject({ mode: z.enum(['off', 'allow', 'block']), hosts: list }),
  mcp: z.strictObject({ mode: z.enum(['off', 'allow']), urls: list }),
  fourEyes: z.strictObject({
    enabled: z.boolean(),
    approverRole: z.enum(['member', 'admin']),
    unpublish: z.boolean(),
    notifyEmail: z.boolean(),
    channelIds: z.array(z.string().min(1).max(100)).max(50),
  }),
});

export const governancePatchSchema = z.strictObject({
  nodes: governanceSchema.shape.nodes.partial().optional(),
  http: governanceSchema.shape.http.partial().optional(),
  mcp: governanceSchema.shape.mcp.partial().optional(),
  fourEyes: governanceSchema.shape.fourEyes.partial().optional(),
});

const CACHE_MS = 1_000;
const cache = () => singleton('governance-policy-cache', () => ({ at: 0, policy: undefined as GovernancePolicy | undefined }));

const clone = (policy: GovernancePolicy): GovernancePolicy => JSON.parse(JSON.stringify(policy));

/** The policy in force (defaults merged in). */
export function getGovernancePolicy(): GovernancePolicy {
  const state = cache();
  if (state.policy && Date.now() - state.at < CACHE_MS) return state.policy;
  let policy = clone(DEFAULT_GOVERNANCE_POLICY);
  try {
    const saved = parse<Partial<GovernancePolicy>>(database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', GOVERNANCE_SETTINGS_KEY)?.value);
    if (saved) {
      const merged = {
        nodes: { ...policy.nodes, ...saved.nodes },
        http: { ...policy.http, ...saved.http },
        mcp: { ...policy.mcp, ...saved.mcp },
        fourEyes: { ...policy.fourEyes, ...saved.fourEyes },
      };
      const parsed = governanceSchema.safeParse(merged);
      if (parsed.success) policy = { ...parsed.data, ...(saved.updatedAt && { updatedAt: saved.updatedAt }), ...(saved.updatedBy && { updatedBy: saved.updatedBy }) };
    }
  } catch {
    // No database yet (or a broken row): the defaults, i.e. no rules.
  }
  state.policy = policy;
  state.at = Date.now();
  return policy;
}

/** Change the policy (Settings → Governance). Returns the policy in force. */
export function updateGovernancePolicy(patch: z.infer<typeof governancePatchSchema>, by?: string): GovernancePolicy {
  const current = getGovernancePolicy();
  const next = governanceSchema.parse({
    nodes: { ...current.nodes, ...patch.nodes },
    http: { ...current.http, ...patch.http },
    mcp: { ...current.mcp, ...patch.mcp },
    fourEyes: { ...current.fourEyes, ...patch.fourEyes },
  });
  const tidy = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];
  const saved: GovernancePolicy = {
    ...next,
    nodes: { ...next.nodes, types: tidy(next.nodes.types), plugins: tidy(next.nodes.plugins) },
    http: { ...next.http, hosts: tidy(next.http.hosts).map((h) => h.toLowerCase()) },
    mcp: { ...next.mcp, urls: tidy(next.mcp.urls) },
    fourEyes: { ...next.fourEyes, channelIds: tidy(next.fourEyes.channelIds) },
    updatedAt: new Date().toISOString(),
    ...(by && { updatedBy: by }),
  };
  database().upsert('settings', { key: GOVERNANCE_SETTINGS_KEY, value: JSON.stringify(saved) });
  invalidateGovernancePolicy();
  return getGovernancePolicy();
}

export function invalidateGovernancePolicy() {
  cache().policy = undefined;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const compiled = () => singleton('governance-patterns', () => new Map<string, RegExp>());

/** A glob (`*` any characters, `?` one) as an anchored, case-insensitive RegExp. */
export function globRegExp(glob: string): RegExp {
  const patterns = compiled();
  let re = patterns.get(glob);
  if (!re) {
    re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    if (patterns.size > 2_000) patterns.clear();
    patterns.set(glob, re);
  }
  return re;
}

const globMatch = (glob: string, text: string) => globRegExp(glob).test(text);

function ipv4(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return undefined;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

/** Whether host pattern `pattern` (`example.com`, `*.example.com`, `10.0.0.0/8`, `api.example.com:8443`) matches. */
export function hostMatches(pattern: string, host: string, port?: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(p);
  if (cidr) {
    const base = ipv4(cidr[1]);
    const addr = ipv4(h);
    const bits = Number(cidr[2]);
    if (base === undefined || addr === undefined || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((base & mask) >>> 0) === ((addr & mask) >>> 0);
  }
  const withPort = /^(.*):(\d+|\*)$/.exec(p);
  if (withPort && !p.includes('::')) return globMatch(withPort[1], h) && (withPort[2] === '*' || withPort[2] === port);
  return globMatch(p, h);
}

function urlParts(url: string): { host: string; port: string; href: string } | undefined {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    return { host: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), href: parsed.toString() };
  } catch {
    return undefined;
  }
}

/** A parameter value the static checks can read (not an expression). */
function literal(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.startsWith('=') || text.includes('{{')) return undefined;
  return text;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Why `type` is not allowed, or undefined when it is. */
export function nodeTypeBlocked(type: string, policy = getGovernancePolicy()): { rule: 'node' | 'plugin' | 'code'; message: string } | undefined {
  let pluginId = '';
  let nodeName = type;
  try {
    ({ pluginId, nodeName } = splitType(type));
  } catch {}
  const { nodes } = policy;
  if (nodes.blockCode && CODE_NODE_NAMES.has(nodeName)) return { rule: 'code', message: 'Code nodes are blocked on this instance' };
  if (nodes.mode === 'off') return undefined;
  const byType = nodes.types.some((glob) => globMatch(glob, type));
  const byPlugin = Boolean(pluginId) && nodes.plugins.some((glob) => globMatch(glob, pluginId));
  if (nodes.mode === 'allow' && !byType && !byPlugin) return { rule: 'node', message: `${type} is not on this instance’s list of allowed nodes` };
  if (nodes.mode === 'block' && byType) return { rule: 'node', message: `${type} is blocked on this instance` };
  if (nodes.mode === 'block' && byPlugin) return { rule: 'plugin', message: `The ${pluginId} plugin’s nodes are blocked on this instance` };
  return undefined;
}

/** Why the HTTP Request node may not call `url`, or undefined when it may (or the URL is not one it could call). */
export function httpUrlBlocked(url: string, policy = getGovernancePolicy()): string | undefined {
  const { http } = policy;
  if (http.mode === 'off') return undefined;
  const parts = urlParts(url);
  if (!parts) return undefined;
  const listed = http.hosts.some((p) => hostMatches(p, parts.host, parts.port));
  if (http.mode === 'allow' && !listed) return `HTTP requests to ${parts.host} are not allowed on this instance`;
  if (http.mode === 'block' && listed) return `HTTP requests to ${parts.host} are blocked on this instance`;
  return undefined;
}

/** Why an MCP client may not connect to `url`, or undefined when it may. Patterns with `://` match the whole URL. */
export function mcpUrlBlocked(url: string, policy = getGovernancePolicy()): string | undefined {
  const { mcp } = policy;
  if (mcp.mode === 'off') return undefined;
  const parts = urlParts(url);
  if (!parts) return undefined;
  const allowed = mcp.urls.some((p) => (p.includes('://') ? globMatch(p, parts.href) || globMatch(p, parts.href.replace(/\/$/, '')) : hostMatches(p, parts.host, parts.port)));
  return allowed ? undefined : `The MCP server ${parts.href} is not on this instance’s list of allowed MCP servers`;
}

/** Throws a PolicyError when `url` is not an allowed MCP server (the MCP client calls this for every connection). */
export function assertMcpUrlAllowed(url: string) {
  const blocked = mcpUrlBlocked(url);
  if (blocked) throw new PolicyError(`${blocked}. An admin can allow it in Settings → Governance.`);
}

/** Whether any node or URL rule is on. */
export function rulesActive(policy = getGovernancePolicy()): boolean {
  return policy.nodes.mode !== 'off' || policy.nodes.blockCode || policy.http.mode !== 'off' || policy.mcp.mode !== 'off';
}

/** What a single node breaks (type, then its literal HTTP or MCP URL). */
export function nodeViolations(node: Pick<WorkflowNode, 'id' | 'name' | 'type' | 'parameters'>, policy = getGovernancePolicy()): PolicyViolation[] {
  const base = { nodeId: node.id, nodeName: node.name, nodeType: node.type };
  const blocked = nodeTypeBlocked(node.type, policy);
  if (blocked) return [{ ...base, rule: blocked.rule, message: blocked.message }];
  const out: PolicyViolation[] = [];
  if (node.type === HTTP_REQUEST_TYPE) {
    const url = literal(node.parameters?.url);
    const message = url && httpUrlBlocked(url, policy);
    if (message) out.push({ ...base, rule: 'http', message });
  }
  if (MCP_NODE_TYPES.has(node.type)) {
    const url = literal(node.parameters?.endpointUrl);
    const message = url && mcpUrlBlocked(url, policy);
    if (message) out.push({ ...base, rule: 'mcp', message });
  }
  return out;
}

/** Every enabled node of `workflow` the policy doesn't allow (empty when the rules are off). */
export function workflowViolations(workflow: Pick<Workflow, 'nodes'>, policy = getGovernancePolicy()): PolicyViolation[] {
  if (!rulesActive(policy)) return [];
  return (workflow.nodes ?? []).filter((node) => !node.disabled).flatMap((node) => nodeViolations(node, policy));
}

export function violationsMessage(violations: PolicyViolation[]): string {
  const first = violations.slice(0, 3).map((v) => `“${v.nodeName}”: ${v.message}`);
  return `${first.join('; ')}${violations.length > 3 ? `; and ${violations.length - 3} more` : ''}`;
}

/** Why `workflow` can't be published (nodes the policy doesn't allow), or undefined when it can. */
export function publishBlockedReason(workflow: Pick<Workflow, 'nodes'>): string | undefined {
  const violations = workflowViolations(workflow);
  return violations.length ? `This version uses nodes the governance policy doesn’t allow, so it can’t be published: ${violationsMessage(violations)}` : undefined;
}

/** Publishing gate: throws a PolicyError (422) listing the nodes the policy doesn't allow. */
export function assertPublishable(workflow: Pick<Workflow, 'nodes'>) {
  const violations = workflowViolations(workflow);
  if (violations.length) throw new PolicyError(publishBlockedReason(workflow)!, violations);
}

// ---------------------------------------------------------------------------
// Run time
// ---------------------------------------------------------------------------

function refusal(message: string): ExecuteResponse {
  return { outputs: [], error: { message: `Blocked by policy: ${message}`, description: 'An admin set this in Settings → Governance.' } } as ExecuteResponse;
}

/** The HTTP Request node's URLs for this call (per item, or the node-level value). */
function requestUrls(request: { parameters?: Record<string, unknown>; itemParameters?: Record<string, unknown>[] }): string[] {
  const urls = (request.itemParameters ?? []).map((p) => p?.url).filter((u): u is string => typeof u === 'string');
  if (!urls.length && typeof request.parameters?.url === 'string') urls.push(request.parameters.url);
  return [...new Set(urls)];
}

/**
 * The registry's run-time gate (plugins/registry.ts `resolve`): a node type the policy blocks fails every call with
 * a clear error on the node (and its app webhooks don't register); the HTTP Request node checks each call's URLs.
 * Policies off: the node type is returned as is.
 */
export function withGovernance(resolved: ResolvedNodeType): ResolvedNodeType {
  const blockedNow = () => nodeTypeBlocked(resolved.type);
  const http = resolved.type === HTTP_REQUEST_TYPE;
  return {
    ...resolved,
    execute: async (request, extras) => {
      const blocked = blockedNow();
      if (blocked) return refusal(blocked.message);
      if (http) {
        for (const url of requestUrls(request)) {
          const message = httpUrlBlocked(url);
          if (message) return refusal(message);
        }
      }
      return resolved.execute(request, extras);
    },
    ...(resolved.supplyData && {
      supplyData: async (request, extras) => {
        const blocked = blockedNow();
        if (blocked) throw new PolicyError(`Blocked by policy: ${blocked.message}`);
        return resolved.supplyData!(request, extras);
      },
    }),
    ...(resolved.webhookMethod && {
      webhookMethod: async (request) => {
        const blocked = blockedNow();
        if (blocked && request.method === 'create') throw new PolicyError(`Blocked by policy: ${blocked.message}`);
        return resolved.webhookMethod!(request);
      },
    }),
    ...(resolved.webhook && {
      webhook: async (request) => {
        const blocked = blockedNow();
        if (blocked) throw new PolicyError(`Blocked by policy: ${blocked.message}`);
        return resolved.webhook!(request);
      },
    }),
  };
}
