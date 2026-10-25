import { registry } from '@/lib/server/plugins/registry';
import { nodeTypeBlocked } from '@/lib/server/governance/policy';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** Every node type; those the governance policy blocks carry `blocked` (the reason), so the node creator can hide them. */
export const GET = handler(async () =>
  json({
    nodeTypes: registry.nodeTypes().map((info) => {
      const blocked = nodeTypeBlocked(info.type);
      return blocked ? { ...info, blocked: blocked.message } : info;
    }),
  }),
);
