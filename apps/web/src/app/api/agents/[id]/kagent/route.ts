/**
 * The agent on kagent (docs/a2a.md, "Landflow agents on kagent"): GET reads the deployment and what kagent holds now
 * (every field that differs from what Landflow writes), and the Harnesses and EgressPolicies of a cluster (`?credentialId=`,
 * else the deployment's); PUT writes the published version there (`credentialId`, a core.kagentApi credential, an optional
 * `name`, `harness`, `egressPolicies`: the sandbox's network beyond Landflow and the model, and `guard`: how strictly
 * Claude Code's landflow-harness mod guards it); DELETE removes it from kagent.
 */
import { agentStore } from '@/lib/server/agents/store';
import { credentials } from '@/lib/server/credentials/vault';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { KAGENT_CREDENTIAL } from '@/lib/server/kagent/cluster';
import { KAGENT_GUARDS, type KagentGuard } from '@/lib/shared/agents';
import { deployToKagent, KagentError, kagentEgressPolicies, kagentHarnesses, kagentStatus, removeFromKagent } from '@/lib/server/kagent/deploy';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const deploySchema = z.object({
  credentialId: z.string().min(1).optional(),
  name: z.string().max(53).optional(),
  harness: z.string().max(63).optional(),
  egressPolicies: z.array(z.string().min(1).max(253)).max(20).optional(),
  guard: z.enum(KAGENT_GUARDS as [string, ...string[]]).optional(),
});

const failed = (cause: unknown) => (cause instanceof KagentError ? error(cause.message, cause.status) : error((cause as Error).message, 502));

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const agent = agentStore.get((await params).id);
  if (!agent) return error('Agent not found', 404);
  const credentialId = new URL(request.url).searchParams.get('credentialId');
  const found = credentialId ? credentials.get(credentialId) : undefined;
  if (credentialId && found?.type !== KAGENT_CREDENTIAL) return error('Credential not found', 404);
  const cluster = found ? { id: found.id, name: found.name } : agent.kagent?.credential;
  const [status, harnesses, egress] = await Promise.all([
    kagentStatus(agent),
    cluster ? kagentHarnesses(cluster).then((list) => ({ harnesses: list }), (cause: Error) => ({ harnessError: cause.message })) : {},
    cluster ? kagentEgressPolicies(cluster).then((list) => ({ egressPolicies: list }), () => ({})) : {},
  ]);
  return json({ status, ...harnesses, ...egress });
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, deploySchema);
  if (!body.ok) return body.response;
  const id = (await params).id;
  let credential;
  if (body.data.credentialId) {
    const found = credentials.get(body.data.credentialId);
    if (!found) return error('Credential not found', 404);
    if (found.type !== KAGENT_CREDENTIAL) return error(`Credential “${found.name}” is a ${found.type}, not a kagent cluster`);
    credential = { id: found.id, name: found.name };
  }
  try {
    const { agent, status, unavailable } = await deployToKagent(id, { credential, name: body.data.name, harness: body.data.harness, egressPolicies: body.data.egressPolicies, ...(body.data.guard && { guard: body.data.guard as KagentGuard }) });
    return json({ agent, status, unavailable });
  } catch (cause) {
    return failed(cause);
  }
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  try {
    const agent = await removeFromKagent((await params).id);
    return json({ agent, status: await kagentStatus(agent) });
  } catch (cause) {
    return failed(cause);
  }
});
