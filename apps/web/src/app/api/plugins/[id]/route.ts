import { z } from 'zod';
import { recordAudit } from '@/lib/server/audit';
import { registry } from '@/lib/server/plugins/registry';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { transportPolicySchema } from '@/lib/server/transports/policy-store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const KIND = z.string().min(1).max(32).regex(/^[a-z][a-z0-9+.-]*$/);

/**
 * PATCH the plugin's transport policy (docs/transports.md): `{ policy: { mode, pinned?, allowed?, objective } }`, or the
 * older `{ preferredTransport: 'http' | 'grpc' | <kind> | null }` (a transport pins the policy to it; null is Auto).
 * Answers with every plugin (the Plugins page replaces its list).
 */
const patchSchema = z
  .object({ preferredTransport: KIND.nullable().optional(), policy: transportPolicySchema.optional() })
  .refine((body) => body.preferredTransport !== undefined || body.policy !== undefined, { message: 'Send `policy` or `preferredTransport`' });

export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, patchSchema);
  if (!body.ok) return body.response;
  const { id } = await params;
  const before = registry.list().find((plugin) => plugin.id === id);
  if (!before) return error('Plugin not found', 404);
  try {
    const policy = body.data.policy ? registry.setPolicy(id, body.data.policy) : (registry.setPreferredTransport(id, body.data.preferredTransport ?? undefined), registry.policy(id));
    recordAudit({
      action: 'plugin.transport',
      target: { type: 'plugin', id, name: before.info.name },
      details: { mode: policy.mode, ...(policy.pinned && { pinned: policy.pinned }), ...(policy.allowed && { allowed: policy.allowed }), objective: policy.objective },
    });
  } catch (caught) {
    return error((caught as Error).message, 404);
  }
  return json({ plugins: registry.list() });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) =>
  registry.remove((await params).id) ? json({ ok: true }) : error('Plugin not found or built-in', 404),
);
