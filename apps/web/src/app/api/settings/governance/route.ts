/**
 * GET /api/settings/governance — the governance policy (allowed and blocked nodes, HTTP hosts, MCP servers,
 * four-eyes publishing) and the plugins and node types to pick from. PATCH (owners and admins) changes any part:
 * `{ nodes?, http?, mcp?, fourEyes? }`, each partial. See lib/server/governance/policy.ts.
 */
import { recordAudit } from '@/lib/server/audit';
import { currentActorId } from '@/lib/server/auth/context';
import { getGovernancePolicy, governancePatchSchema, nodeTypeBlocked, updateGovernancePolicy } from '@/lib/server/governance/policy';
import { handler, json, parseBody } from '@/lib/server/http';
import { registry } from '@/lib/server/plugins/registry';

export const dynamic = 'force-dynamic';

function view() {
  const policy = getGovernancePolicy();
  const types = registry.nodeTypes();
  return {
    policy,
    plugins: [...new Map(types.map((t) => [t.pluginId, { id: t.pluginId, name: t.pluginName }])).values()],
    nodeTypes: types.map((t) => ({ type: t.type, displayName: t.descriptor.displayName, pluginId: t.pluginId, ...(nodeTypeBlocked(t.type, policy) && { blocked: nodeTypeBlocked(t.type, policy)!.message }) })),
  };
}

export const GET = handler(async () => json(view()));

export const PATCH = handler(async (request: Request) => {
  const body = await parseBody(request, governancePatchSchema);
  if (!body.ok) return body.response;
  const before = getGovernancePolicy();
  const policy = updateGovernancePolicy(body.data, currentActorId());
  const changed = (Object.keys(body.data) as (keyof typeof body.data)[]).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(policy[key]));
  recordAudit({
    action: 'settings.update',
    target: { type: 'settings', id: 'governance', name: 'Governance' },
    summary: `Changed the governance policy${changed.length ? ` (${changed.join(', ')})` : ''}`,
    details: {
      sections: changed,
      nodesMode: policy.nodes.mode,
      nodeTypes: policy.nodes.types,
      plugins: policy.nodes.plugins,
      blockCode: policy.nodes.blockCode,
      httpMode: policy.http.mode,
      httpHosts: policy.http.hosts,
      mcpMode: policy.mcp.mode,
      mcpUrls: policy.mcp.urls,
      fourEyes: policy.fourEyes.enabled,
      approverRole: policy.fourEyes.approverRole,
    },
  });
  return json(view());
});
