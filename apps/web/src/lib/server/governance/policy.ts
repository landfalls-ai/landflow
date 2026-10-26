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
 *
 * Below the instance, a workflow's project and the workflow itself can narrow the node list further (./scopes.ts):
 * every check here that takes a workflow also applies those lists (`scopedNodeBlocked`).
 */
import { splitType } from '@landflow/protocol';
import type { ExecuteResponse } from '@landflow/protocol';
import type { ResolvedNodeType, Workflow, WorkflowNode } from '@landflow/engine';
import { z } from 'zod';
import { DEFAULT_GOVERNANCE_POLICY, type GovernancePolicy, type PolicyViolation } from '../../shared/governance';
import { database } from '../db';
import { parse } from '../db/rows';
import { singleton } from '../singleton';
import { policyScope, scopeActive, type PolicyScope, type ScopeTarget } from './scopes';

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

/** An IPv6 address (`2001:db8::1`, `::ffff:10.0.0.1`, a zone id is ignored) as a 128-bit number. */
export function ipv6(text: string): bigint | undefined {
  let rest = text.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  if (!rest.includes(':')) return undefined;
  // An IPv4 tail (`::ffff:10.0.0.1`) is the last two groups.
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(rest);
  if (tail) {
    const v4 = ipv4(tail[2]);
    if (v4 === undefined) return undefined;
    rest = `${tail[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = rest.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string) => (part ? part.split(':') : []);
  const head = groups(halves[0]);
  const back = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - back.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...back];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return all.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** `::ffff:a.b.c.d` (an IPv4-mapped IPv6 address) as its IPv4 address, so IPv4 rules see it. */
function mappedIpv4(host: string): number | undefined {
  const v6 = ipv6(host);
  if (v6 === undefined || v6 >> 32n !== 0xffffn) return undefined;
  return Number(v6 & 0xffffffffn);
}

/**
 * Whether host pattern `pattern` matches: names (`example.com`, `*.example.com`), `api.example.com:8443`, IPv4 and
 * IPv6 addresses and CIDR ranges (`10.0.0.0/8`, `fd00::/8`, `2001:db8::1`, `[2001:db8::1]:8443`). IPv4-mapped IPv6
 * addresses (`::ffff:10.0.0.1`) match IPv4 rules.
 */
export function hostMatches(pattern: string, host: string, port?: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(p);
  if (cidr) {
    const base = ipv4(cidr[1]);
    const addr = ipv4(h) ?? mappedIpv4(h);
    const bits = Number(cidr[2]);
    if (base === undefined || addr === undefined || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((base & mask) >>> 0) === ((addr & mask) >>> 0);
  }
  const cidr6 = /^\[?([0-9a-f:.]+)\]?\/(\d{1,3})$/.exec(p);
  if (cidr6 && cidr6[1].includes(':')) {
    const base = ipv6(cidr6[1]);
    const addr = ipv6(h) ?? (ipv4(h) !== undefined ? (0xffffn << 32n) | BigInt(ipv4(h)!) : undefined);
    const bits = Number(cidr6[2]);
    if (base === undefined || addr === undefined || bits > 128) return false;
    const shift = BigInt(128 - bits);
    return base >> shift === addr >> shift;
  }
  // An IPv6 address, bare or bracketed with a port (`[::1]:8080`).
  const bracketed = /^\[([0-9a-f:.%]+)\](?::(\d+|\*))?$/.exec(p);
  const address6 = bracketed ? ipv6(bracketed[1]) : ipv6(p);
  if (address6 !== undefined) {
    if (bracketed?.[2] && bracketed[2] !== '*' && bracketed[2] !== port) return false;
    return ipv6(h) === address6;
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

/** Where a node type was refused: the instance policy, the workflow's project or the workflow's own policy. */
export type BlockedBy = 'instance' | 'project' | 'workflow';

const listed = (list: { plugins: string[]; types: string[] }, type: string, pluginId: string) =>
  list.types.some((glob) => globMatch(glob, type)) || (Boolean(pluginId) && list.plugins.some((glob) => globMatch(glob, pluginId)));

/**
 * Why `type` is not allowed for a workflow (the instance's rules, then its project's allow-list, then its own), or
 * undefined when it is. `scope` is what `policyScope()` gives for the workflow.
 */
export function scopedNodeBlocked(type: string, policy = getGovernancePolicy(), scope: PolicyScope = {}): { rule: 'node' | 'plugin' | 'code'; message: string; by: BlockedBy } | undefined {
  const instance = nodeTypeBlocked(type, policy);
  if (instance) return { ...instance, by: 'instance' };
  let pluginId = '';
  try {
    ({ pluginId } = splitType(type));
  } catch {}
  if (scope.project && !listed(scope.project.nodes, type, pluginId)) return { rule: 'node', message: `${type} is not on the “${scope.project.name}” project’s list of allowed nodes`, by: 'project' };
  if (scope.workflow && !listed(scope.workflow.nodes, type, pluginId)) return { rule: 'node', message: `${type} is not on this workflow’s list of allowed nodes`, by: 'workflow' };
  return undefined;
}

/** Where to change the rule that refused a node (the run-time error's description). */
export function blockedHint(by: BlockedBy): string {
  if (by === 'project') return 'The project’s admins set this in the project’s settings (Projects → Settings → Allowed nodes).';
  if (by === 'workflow') return 'Set in this workflow’s settings (Workflow settings → Governance), by the admins of its project.';
  return 'An admin set this in Settings → Governance.';
}

/** The scope of a workflow document: by its id (none for a workflow that isn't saved, such as a template's). */
function scopeOf(workflow: Pick<Workflow, 'nodes'> & { id?: string }): PolicyScope {
  return workflow.id ? policyScope({ workflowId: workflow.id }) : {};
}

/** The project and workflow lists for `target` (a workflow, or the project something will be created in). */
export function scopeFor(target: ScopeTarget | undefined): PolicyScope {
  return policyScope(target);
}

/** What a single node breaks (type, then its literal HTTP or MCP URL). */
export function nodeViolations(node: Pick<WorkflowNode, 'id' | 'name' | 'type' | 'parameters'>, policy = getGovernancePolicy(), scope: PolicyScope = {}): PolicyViolation[] {
  const base = { nodeId: node.id, nodeName: node.name, nodeType: node.type };
  const blocked = scopedNodeBlocked(node.type, policy, scope);
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

/**
 * Every enabled node of `workflow` the policy doesn't allow (empty when the rules are off): the instance's rules and,
 * for a saved workflow (by its id) or the given `scope`, its project's and its own allow-lists.
 */
export function workflowViolations(workflow: Pick<Workflow, 'nodes'> & { id?: string }, policy = getGovernancePolicy(), scope: PolicyScope = scopeOf(workflow)): PolicyViolation[] {
  if (!rulesActive(policy) && !scopeActive(scope)) return [];
  return (workflow.nodes ?? []).filter((node) => !node.disabled).flatMap((node) => nodeViolations(node, policy, scope));
}

export function violationsMessage(violations: PolicyViolation[]): string {
  const first = violations.slice(0, 3).map((v) => `“${v.nodeName}”: ${v.message}`);
  return `${first.join('; ')}${violations.length > 3 ? `; and ${violations.length - 3} more` : ''}`;
}

/** Why `workflow` can't be published (nodes the policy, its project or its own policy don't allow), or undefined when it can. */
export function publishBlockedReason(workflow: Pick<Workflow, 'nodes'> & { id?: string }): string | undefined {
  const violations = workflowViolations(workflow);
  return violations.length ? `This version uses nodes the governance policy doesn’t allow, so it can’t be published: ${violationsMessage(violations)}` : undefined;
}

/** Publishing gate: throws a PolicyError (422) listing the nodes the policy doesn't allow. */
export function assertPublishable(workflow: Pick<Workflow, 'nodes'> & { id?: string }) {
  const violations = workflowViolations(workflow);
  if (violations.length) throw new PolicyError(publishBlockedReason(workflow)!, violations);
}

// ---------------------------------------------------------------------------
// Run time
// ---------------------------------------------------------------------------

function refusal(message: string, by: BlockedBy = 'instance'): ExecuteResponse {
  return { outputs: [], error: { message: `Blocked by policy: ${message}`, description: blockedHint(by) } } as ExecuteResponse;
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
 * The request's workflow brings its project's and its own allow-lists (`agent:<id>`: the agent's project).
 * Policies off: the node type is returned as is.
 */
export function withGovernance(resolved: ResolvedNodeType): ResolvedNodeType {
  const blockedNow = (workflowId?: string) => {
    const policy = getGovernancePolicy();
    return scopedNodeBlocked(resolved.type, policy, workflowId ? policyScope({ workflowId }) : {});
  };
  const http = resolved.type === HTTP_REQUEST_TYPE;
  return {
    ...resolved,
    execute: async (request, extras) => {
      const blocked = blockedNow(request.workflowId);
      if (blocked) return refusal(blocked.message, blocked.by);
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
        const blocked = blockedNow((request as { workflowId?: string }).workflowId);
        if (blocked) throw new PolicyError(`Blocked by policy: ${blocked.message}`);
        return resolved.supplyData!(request, extras);
      },
    }),
    ...(resolved.webhookMethod && {
      webhookMethod: async (request) => {
        const blocked = blockedNow(request.workflowId);
        if (blocked && request.method === 'create') throw new PolicyError(`Blocked by policy: ${blocked.message}`);
        return resolved.webhookMethod!(request);
      },
    }),
    ...(resolved.webhook && {
      webhook: async (request) => {
        const blocked = blockedNow((request as { workflowId?: string }).workflowId);
        if (blocked) throw new PolicyError(`Blocked by policy: ${blocked.message}`);
        return resolved.webhook!(request);
      },
    }),
  };
}
